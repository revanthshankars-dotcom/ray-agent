import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { WebSocket } from 'ws';
import type {
  AppConnector,
  BrainNote,
  BrowserTabInfo,
  IncomingMessage,
  CommandExecutionResult,
  CommandType,
  DeviceCommand,
  DeviceInfo,
  DeviceTelemetry,
  HandoffItem,
  HudSoundType,
  RoomSnapshot,
  RoutinePlan,
  SharedTask,
  SyncTimer,
} from '../src/types/relay.ts';
import { loadJson, loadJsonSync, scheduleSave } from './persistence.ts';
import { wakeOfflineDevices } from './wake.ts';

interface RoomState {
  roomId: string;
  roomToken: string;
  devices: Map<string, DeviceInfo>;
  sockets: Map<string, WebSocket>;
  commands: DeviceCommand[];
  tasks: SharedTask[];
  handoffs: HandoffItem[];
  timers: SyncTimer[];
  routines: RoutinePlan[];
  brainNotes: BrainNote[];
  connectors: AppConnector[];
  veronicaMode: boolean;
  interrupted: boolean;
  screenControlArmed: boolean;
  /** Commands addressed to devices that were offline; delivered when they reconnect. */
  queuedCommands: Record<string, DeviceCommand[]>;
  /** Web Push subscriptions per device id (used to wake phones / closed PWAs). */
  pushSubscriptions: Record<string, unknown>;
  /** Open tabs per RAY Tabs extension device id. */
  browserTabs: Record<string, BrowserTabInfo[]>;
  /** Recent incoming WhatsApp / Instagram / SMS messages (newest first). */
  incomingMessages: IncomingMessage[];
}

interface PendingCommandWaiter {
  expectedDeviceIds: Set<string>;
  receivedResults: CommandExecutionResult[];
  resolve: (results: CommandExecutionResult[]) => void;
  timer: NodeJS.Timeout;
}

interface PendingProxyWaiter {
  resolve: (payload: { ok: boolean; data?: unknown; error?: string }) => void;
  timer: NodeJS.Timeout;
}

const rooms = new Map<string, RoomState>();
const pendingWaiters = new Map<string, PendingCommandWaiter>();
const pendingProxyWaiters = new Map<string, PendingProxyWaiter>();

export function normalizeRoomId(raw?: string): string {
  const cleaned = (raw ?? '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
  return cleaned.length >= 3 ? cleaned.slice(0, 20) : 'RLY-HOME';
}

const LEGACY_TMP_TOKEN_STORE = path.join(os.tmpdir(), 'ray-relay-room-tokens.json');
const RELAY_DATA_DIR = path.join(process.cwd(), '.relay-data');
const TOKEN_STORE_PATH = path.join(RELAY_DATA_DIR, 'room-tokens.json');
let persistedTokensCache: Record<string, string> | null = null;

function loadPersistedRoomTokens(): Record<string, string> {
  if (persistedTokensCache) return persistedTokensCache;
  const merged: Record<string, string> = {};
  try {
    if (fs.existsSync(LEGACY_TMP_TOKEN_STORE)) {
      const legacy = JSON.parse(fs.readFileSync(LEGACY_TMP_TOKEN_STORE, 'utf8')) as Record<string, string>;
      if (legacy && typeof legacy === 'object') Object.assign(merged, legacy);
    }
  } catch {
    // Ignore corrupt legacy store
  }
  try {
    if (fs.existsSync(TOKEN_STORE_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(TOKEN_STORE_PATH, 'utf8')) as Record<string, string>;
      if (parsed && typeof parsed === 'object') Object.assign(merged, parsed);
    }
  } catch {
    // Ignore corrupt token store
  }
  persistedTokensCache = merged;
  return persistedTokensCache;
}

/**
 * When RELAY_MASTER_SECRET is set the room token is derived deterministically
 * (HMAC-SHA256), so it survives Cloud Run restarts / redeploys and every bridge,
 * phone and browser keeps working without re-pairing.
 */
function deriveRoomTokenFromSecret(roomId: string): string | null {
  const secret = (process.env.RELAY_MASTER_SECRET || '').trim();
  if (secret.length < 16) return null;
  return crypto.createHmac('sha256', secret).update(`ray-room:${roomId}`).digest('hex').slice(0, 48);
}

export function hasStableRoomSecret(): boolean {
  return Boolean(deriveRoomTokenFromSecret('probe'));
}

function getOrCreatePersistedRoomToken(roomId: string): string {
  const derived = deriveRoomTokenFromSecret(roomId);
  if (derived) return derived;
  const store = loadPersistedRoomTokens();
  const existing = store[roomId];
  if (typeof existing === 'string' && existing.length >= 32) {
    // Ensure it is saved to workspace .relay-data/ so future restarts keep the exact same token
    try {
      if (!fs.existsSync(TOKEN_STORE_PATH)) {
        fs.mkdirSync(RELAY_DATA_DIR, { recursive: true });
        fs.writeFileSync(TOKEN_STORE_PATH, JSON.stringify(store, null, 2), { mode: 0o600 });
      }
    } catch {
      // Non-fatal
    }
    return existing;
  }
  const next = crypto.randomBytes(24).toString('hex');
  store[roomId] = next;
  try {
    fs.mkdirSync(RELAY_DATA_DIR, { recursive: true });
    fs.writeFileSync(TOKEN_STORE_PATH, JSON.stringify(store, null, 2), { mode: 0o600 });
  } catch {
    try {
      fs.writeFileSync(LEGACY_TMP_TOKEN_STORE, JSON.stringify(store), { mode: 0o600 });
    } catch {
      // Non-fatal if filesystem is read-only
    }
  }
  return next;
}

function generateRoomToken(): string {
  return crypto.randomBytes(24).toString('hex');
}

function slugifyNoteTitle(title: string): string {
  const slug = (title || 'untitled')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || `note-${Date.now()}`;
}

export function extractWikilinks(content: string): string[] {
  const matches = new Set<string>();
  const re = /\[\[([^\]]{1,120})\]\]/g;
  let m: RegExpExecArray | null = null;
  while ((m = re.exec(content)) !== null) {
    const raw = m[1].split('|')[0].trim();
    if (raw) matches.add(raw);
  }
  return Array.from(matches).slice(0, 50);
}

export function extractTags(content: string): string[] {
  const matches = new Set<string>();
  const re = /(?:^|\s)#([a-zA-Z0-9_-]{2,40})/g;
  let m: RegExpExecArray | null = null;
  while ((m = re.exec(content)) !== null) {
    matches.add(m[1].toLowerCase());
  }
  return Array.from(matches).slice(0, 30);
}

export function getOrCreateRoom(roomId: string): RoomState {
  const id = normalizeRoomId(roomId);
  let room = rooms.get(id);
  if (!room) {
    const now = Date.now();
    const todayIso = new Date(now).toISOString().slice(0, 10);
    const seedNotes: Array<{
      id: string;
      title: string;
      folder: string;
      content: string;
      source: 'jarvis' | 'user';
    }> = [
      {
        id: 'note-jarvis-core',
        title: 'RAY Second Brain',
        folder: 'System',
        source: 'jarvis',
        content:
          `# RAY's Obsidian Second Brain\n\nWelcome back, Ray. Your knowledge graph lives natively inside RAY and syncs with Firebase.\n\n## Core Hubs\n- [[${todayIso}]] — Today's Daily Note & Inbox\n- [[Google Workspace Hub]] — Gmail, Calendar, Drive, Docs, Sheets, Tasks, Contacts\n- [[External Apps Hub]] — Brave, Notion, NotebookLM, WhatsApp, Instagram\n- [[RAY Operations]] — Automation rules, screens & AI engines (Gemini, OpenRouter, Ollama)\n\n## Quick Tips\n- [ ] Connect Google Workspace authorization separately when ready\n- [ ] Capture web ideas with \`[[Wikilinks]]\` and \`#tags\`\n\n#second-brain #ray #system`,
      },
      {
        id: 'note-daily-today',
        title: todayIso,
        folder: 'Daily',
        source: 'user',
        content:
          `# Daily Note — ${todayIso}\n\nLinked to [[RAY Second Brain]] and [[Google Workspace Hub]].\n\n## Focus\n- [ ] Review inbox & calendar briefing\n- [ ] Capture new research into [[External Apps Hub]]\n\n## Notes\n\n#daily #focus`,
      },
      {
        id: 'note-google-hub',
        title: 'Google Workspace Hub',
        folder: 'Apps',
        source: 'jarvis',
        content:
          `# Google Workspace Hub\n\nEvery Google app connects to [[RAY Second Brain]] once you grant OAuth authorization:\n\n- **[[Gmail]]** — Search inbox, draft & summarize threads into notes\n- **[[Google Calendar]]** — Pull meetings into [[${todayIso}]]\n- **[[Google Drive]]** — Search files & reference them via wikilinks\n- **[[Google Docs]]** — Read & generate structured documents\n- **[[Google Sheets]]** — Inspect tables & append logs\n- **[[Google Tasks]]** — Sync actionable checklist items\n- **[[Google Contacts]]** — People graph & directory lookup\n\n#apps #google #workspace`,
      },
      {
        id: 'note-external-apps',
        title: 'External Apps Hub',
        folder: 'Apps',
        source: 'jarvis',
        content:
          `# External Apps Hub\n\nFree zero-fee external apps linked into [[RAY Second Brain]]:\n\n- **[[Brave Browser]]** — Privacy search & web launches\n- **[[Notion]]** — Search Notion pages via integration token\n- **[[NotebookLM]]** — Deep source synthesis & study notebooks\n- **[[WhatsApp]]** — Zero-fee quick message launcher\n- **[[Instagram]]** — Direct creator/social access\n\n#apps #integrations #tools`,
      },
      {
        id: 'note-jarvis-ops',
        title: 'RAY Operations',
        folder: 'System',
        source: 'jarvis',
        content:
          `# RAY Operations\n\nConnected to [[RAY Second Brain]].\n\n- **AI Engines**: Cloud Gemini, OpenRouter (cloud/free models), Local Ollama (offline)\n- **Screen Vision & Guarded Control**: Browser screen share + Desktop Bridge\n- **Optional Local Backup**: Any folder you optionally point \`RELAY_VAULT_DIR\` to simply mirrors these notes as \`.md\` files on disk — your Second Brain here works 100% standalone without it.\n\n#ray #architecture`,
      },
    ];

    const brainNotes: BrainNote[] = seedNotes.map((s, idx) => ({
      id: s.id,
      title: s.title,
      slug: slugifyNoteTitle(s.title),
      folder: s.folder,
      content: s.content,
      tags: extractTags(s.content),
      links: extractWikilinks(s.content),
      source: s.source,
      createdAt: now - (seedNotes.length - idx) * 1000,
      updatedAt: now - (seedNotes.length - idx) * 1000,
    }));

    room = {
      roomId: id,
      roomToken: getOrCreatePersistedRoomToken(id) || generateRoomToken(),
      devices: new Map(),
      sockets: new Map(),
      commands: [],
      tasks: [],
      handoffs: [],
      timers: [],
      routines: [],
      brainNotes,
      connectors: [],
      veronicaMode: false,
      interrupted: false,
      screenControlArmed: false,
      queuedCommands: {},
      pushSubscriptions: {},
      browserTabs: {},
      incomingMessages: [],
    };
    rooms.set(id, room);
    const persisted = loadJsonSync<PersistedRoom>(roomStorageKey(id));
    if (persisted) applyPersistedRoom(room, persisted);
    rememberRoomId(id);
  }
  return room;
}

// ---------------------------------------------------------------------------
// Durable room state (brain notes, connectors, tasks, routines, devices, queue)
// ---------------------------------------------------------------------------

interface PersistedRoom extends Record<string, unknown> {
  version: number;
  brainNotes?: BrainNote[];
  connectors?: AppConnector[];
  tasks?: SharedTask[];
  routines?: RoutinePlan[];
  handoffs?: HandoffItem[];
  devices?: DeviceInfo[];
  queuedCommands?: Record<string, DeviceCommand[]>;
  pushSubscriptions?: Record<string, unknown>;
  incomingMessages?: IncomingMessage[];
}

function roomStorageKey(roomId: string): string {
  return `room-${roomId}`;
}

const knownRoomIds = new Set<string>();
function rememberRoomId(roomId: string): void {
  if (knownRoomIds.has(roomId)) return;
  knownRoomIds.add(roomId);
  scheduleSave('rooms-index', () => ({ rooms: Array.from(knownRoomIds) }), 500);
}

function applyPersistedRoom(room: RoomState, p: PersistedRoom): void {
  if (Array.isArray(p.brainNotes) && p.brainNotes.length > 0) room.brainNotes = p.brainNotes;
  if (Array.isArray(p.connectors)) {
    const seen = new Set<string>();
    room.connectors = p.connectors.filter((c) => {
      const k = c.name.trim().toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  if (Array.isArray(p.tasks)) room.tasks = p.tasks;
  if (Array.isArray(p.routines)) room.routines = p.routines;
  if (Array.isArray(p.handoffs)) room.handoffs = p.handoffs;
  if (Array.isArray(p.devices)) {
    for (const d of p.devices) {
      if (!room.devices.has(d.id)) room.devices.set(d.id, { ...d, online: false });
    }
  }
  if (p.queuedCommands && typeof p.queuedCommands === 'object') room.queuedCommands = p.queuedCommands;
  if (p.pushSubscriptions && typeof p.pushSubscriptions === 'object') room.pushSubscriptions = p.pushSubscriptions;
  if (Array.isArray(p.incomingMessages)) room.incomingMessages = p.incomingMessages;
}

function persistRoom(room: RoomState): void {
  scheduleSave(roomStorageKey(room.roomId), () => ({
    version: 1,
    brainNotes: room.brainNotes,
    connectors: room.connectors,
    tasks: room.tasks,
    routines: room.routines,
    // Images are large and ephemeral – keep text/link handoffs only.
    handoffs: room.handoffs.filter((h) => h.kind !== 'image').slice(0, 40),
    devices: Array.from(room.devices.values()).map((d) => ({ ...d, online: false })),
    queuedCommands: room.queuedCommands,
    pushSubscriptions: room.pushSubscriptions,
    incomingMessages: room.incomingMessages.slice(0, 100),
  }));
}

export function getBrowserTabs(roomId: string): Array<{ deviceId: string; deviceName: string; tabs: BrowserTabInfo[] }> {
  const room = getOrCreateRoom(roomId);
  return Object.entries(room.browserTabs).map(([deviceId, tabs]) => ({
    deviceId,
    deviceName: room.devices.get(deviceId)?.name || deviceId,
    tabs,
  }));
}

type IncomingListener = (roomId: string, msg: IncomingMessage) => void;
const incomingListeners: IncomingListener[] = [];
export function onIncomingMessage(listener: IncomingListener): void {
  incomingListeners.push(listener);
}

/**
 * Store an incoming chat message (from a phone notification relay or Meta webhook),
 * fan it out to every connected device and wake offline ones.
 */
export function recordIncomingMessage(
  roomId: string,
  input: Omit<IncomingMessage, 'id' | 'read'>
): IncomingMessage | null {
  const room = getOrCreateRoom(roomId);
  const text = input.text.trim().slice(0, 2000);
  if (!text) return null;
  // De-duplicate: phone notification lists are re-sent on every poll.
  const dup = room.incomingMessages.find(
    (m) => m.app === input.app && m.from === input.from && m.text === text && Math.abs(m.receivedAt - input.receivedAt) < 6 * 3600_000
  );
  if (dup) return null;
  const msg: IncomingMessage = {
    id: crypto.randomUUID(),
    app: input.app.toLowerCase().slice(0, 30),
    from: input.from.slice(0, 120),
    text,
    receivedAt: input.receivedAt || Date.now(),
    viaDevice: input.viaDevice.slice(0, 80),
  };
  room.incomingMessages.unshift(msg);
  room.incomingMessages = room.incomingMessages.slice(0, 100);
  broadcastRoomEvent(room.roomId, 'messages:new', msg);
  broadcastRoomEvent(room.roomId, 'state:sync', getRoomSnapshot(room.roomId));
  for (const l of incomingListeners) {
    try {
      l(room.roomId, msg);
    } catch {
      // ignore listener failure
    }
  }
  return msg;
}

export function getIncomingMessages(roomId: string, opts?: { app?: string; unreadOnly?: boolean; limit?: number }): IncomingMessage[] {
  const room = getOrCreateRoom(roomId);
  return room.incomingMessages
    .filter((m) => !opts?.app || m.app === opts.app.toLowerCase())
    .filter((m) => !opts?.unreadOnly || !m.read)
    .slice(0, opts?.limit || 20);
}

export function markMessagesRead(roomId: string, ids?: string[]): number {
  const room = getOrCreateRoom(roomId);
  let n = 0;
  for (const m of room.incomingMessages) {
    if (!m.read && (!ids || ids.includes(m.id))) {
      m.read = true;
      n++;
    }
  }
  if (n) broadcastRoomEvent(room.roomId, 'state:sync', getRoomSnapshot(room.roomId));
  return n;
}

/** Load every known room from durable storage (GCS or local) before serving traffic. */
export async function hydrateRoomsFromStorage(): Promise<number> {
  const index = await loadJson<{ rooms?: string[] }>('rooms-index');
  const ids = Array.isArray(index?.rooms) ? index!.rooms : [];
  let count = 0;
  for (const rawId of ids) {
    const id = normalizeRoomId(rawId);
    knownRoomIds.add(id);
    const persisted = await loadJson<PersistedRoom>(roomStorageKey(id));
    const room = getOrCreateRoom(id);
    if (persisted) {
      applyPersistedRoom(room, persisted);
      count++;
    }
  }
  return count;
}

export function listRoomIds(): string[] {
  return Array.from(rooms.keys());
}

export function getRoomDevices(roomId: string): DeviceInfo[] {
  return Array.from(getOrCreateRoom(roomId).devices.values());
}

export function savePushSubscription(roomId: string, deviceId: string, subscription: unknown): void {
  const room = getOrCreateRoom(roomId);
  if (!deviceId || !subscription || typeof subscription !== 'object') return;
  room.pushSubscriptions[deviceId] = subscription;
  persistRoom(room);
}

export function removePushSubscription(roomId: string, deviceId: string): void {
  const room = getOrCreateRoom(roomId);
  delete room.pushSubscriptions[deviceId];
  persistRoom(room);
}

export function getPushSubscriptions(roomId: string): Record<string, unknown> {
  return getOrCreateRoom(roomId).pushSubscriptions;
}

export function verifyRoomToken(roomId: string, providedToken?: string | null): boolean {
  const room = getOrCreateRoom(roomId);
  if (!providedToken || typeof providedToken !== 'string') return false;
  const a = Buffer.from(room.roomToken);
  const b = Buffer.from(providedToken.trim());
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function getOrIssueRoomBootstrap(
  roomId: string,
  providedToken?: string | null
): { authorized: boolean; roomToken?: string; snapshot?: RoomSnapshot; error?: string } {
  const room = getOrCreateRoom(roomId);
  const tokenValid = verifyRoomToken(room.roomId, providedToken);
  if (tokenValid) {
    return {
      authorized: true,
      roomToken: room.roomToken,
      snapshot: getRoomSnapshot(room.roomId),
    };
  }
  // Allow first-time bootstrap when no active socket is currently connected to this room
  if (room.sockets.size === 0) {
    return {
      authorized: true,
      roomToken: room.roomToken,
      snapshot: getRoomSnapshot(room.roomId),
    };
  }
  return {
    authorized: false,
    error: 'Room token required. Use the pairing link or copy the Room Access Token from your primary console.',
  };
}

export function getRoomSnapshot(roomId: string): RoomSnapshot {
  const room = getOrCreateRoom(roomId);
  const now = Date.now();
  room.timers = room.timers.filter((t) => t.endsAt > now - 30_000);
  return {
    roomId: room.roomId,
    devices: Array.from(room.devices.values())
      .map((d) => ({ ...d, queuedCount: room.queuedCommands[d.id]?.length || 0 }))
      .sort(
      (a, b) => Number(b.online) - Number(a.online) || b.lastSeen - a.lastSeen
    ),
    commands: room.commands.slice(0, 50),
    tasks: room.tasks,
    handoffs: room.handoffs.slice(0, 40),
    timers: room.timers,
    routines: room.routines,
    brainNotes: room.brainNotes,
    connectors: room.connectors,
    veronicaMode: room.veronicaMode,
    interrupted: room.interrupted,
    screenControlArmed: room.screenControlArmed,
    incomingMessages: room.incomingMessages.slice(0, 50),
  };
}

export function broadcastRoomEvent(roomId: string, event: string, data: unknown): void {
  const room = getOrCreateRoom(roomId);
  if (event === 'state:sync') persistRoom(room);
  const payload = JSON.stringify({ event, data });
  for (const ws of room.sockets.values()) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

export function broadcastHudSound(roomId: string, sound: HudSoundType): void {
  broadcastRoomEvent(roomId, 'hud:sound', { sound });
}

export function setRoomVeronicaMode(roomId: string, enabled: boolean): void {
  const room = getOrCreateRoom(roomId);
  room.veronicaMode = enabled;
  broadcastRoomEvent(room.roomId, 'state:sync', getRoomSnapshot(room.roomId));
}

export function setRoomScreenControlArmed(roomId: string, armed: boolean): void {
  const room = getOrCreateRoom(roomId);
  room.screenControlArmed = armed;
  broadcastRoomEvent(room.roomId, 'state:sync', getRoomSnapshot(room.roomId));
}

export function isRoomScreenControlArmed(roomId: string): boolean {
  return getOrCreateRoom(roomId).screenControlArmed;
}

export function setRoomInterrupted(roomId: string, interrupted: boolean): void {
  const room = getOrCreateRoom(roomId);
  room.interrupted = interrupted;
  if (interrupted && room.screenControlArmed) {
    room.screenControlArmed = false;
  }
  broadcastRoomEvent(room.roomId, 'jarvis:interrupted', { interrupted, timestamp: Date.now() });
  broadcastRoomEvent(room.roomId, 'state:sync', getRoomSnapshot(room.roomId));
}

export function isRoomInterrupted(roomId: string): boolean {
  return getOrCreateRoom(roomId).interrupted;
}

export function getRoomBrainNotes(roomId: string): BrainNote[] {
  return getOrCreateRoom(roomId).brainNotes;
}

export function upsertRoomBrainNote(
  roomId: string,
  input: Partial<BrainNote> & { title: string; content: string }
): BrainNote {
  const room = getOrCreateRoom(roomId);
  const now = Date.now();
  const title = input.title.trim().slice(0, 140) || 'Untitled Note';
  const slug = slugifyNoteTitle(input.slug || title);
  const content = (input.content || '').slice(0, 120000);
  const mergedTags = Array.from(
    new Set([...(Array.isArray(input.tags) ? input.tags.map((t) => String(t).toLowerCase()) : []), ...extractTags(content)])
  ).slice(0, 30);
  const mergedLinks = Array.from(
    new Set([...(Array.isArray(input.links) ? input.links.map((l) => String(l)) : []), ...extractWikilinks(content)])
  ).slice(0, 50);

  const existingIdx = room.brainNotes.findIndex(
    (n) => (input.id && n.id === input.id) || n.slug === slug || n.title.toLowerCase() === title.toLowerCase()
  );

  if (existingIdx >= 0) {
    const existing = room.brainNotes[existingIdx];
    const updated: BrainNote = {
      ...existing,
      title,
      slug,
      folder: (input.folder ?? existing.folder ?? 'General').trim().slice(0, 80) || 'General',
      content,
      tags: mergedTags,
      links: mergedLinks,
      source: input.source || existing.source || 'user',
      updatedAt: now,
    };
    room.brainNotes[existingIdx] = updated;
    broadcastRoomEvent(room.roomId, 'state:sync', getRoomSnapshot(room.roomId));
    return updated;
  }

  const created: BrainNote = {
    id: input.id || `note-${crypto.randomUUID().slice(0, 10)}`,
    title,
    slug,
    folder: (input.folder || 'General').trim().slice(0, 80) || 'General',
    content,
    tags: mergedTags,
    links: mergedLinks,
    source: input.source || 'user',
    createdAt: now,
    updatedAt: now,
  };
  room.brainNotes.unshift(created);
  room.brainNotes = room.brainNotes.slice(0, 1000);
  broadcastRoomEvent(room.roomId, 'state:sync', getRoomSnapshot(room.roomId));
  return created;
}

export function deleteRoomBrainNote(roomId: string, noteId: string): boolean {
  const room = getOrCreateRoom(roomId);
  const before = room.brainNotes.length;
  room.brainNotes = room.brainNotes.filter((n) => n.id !== noteId);
  if (room.brainNotes.length !== before) {
    broadcastRoomEvent(room.roomId, 'state:sync', getRoomSnapshot(room.roomId));
    return true;
  }
  return false;
}

export function getRoomConnectors(roomId: string): AppConnector[] {
  return getOrCreateRoom(roomId).connectors;
}

export function upsertRoomConnector(roomId: string, connector: AppConnector): AppConnector {
  const room = getOrCreateRoom(roomId);
  // Unique by name: re-saving "WhatsApp" updates the existing connector instead of duplicating it.
  const nameKey = connector.name.trim().toLowerCase();
  const sameName = room.connectors.find((c) => c.id !== connector.id && c.name.trim().toLowerCase() === nameKey);
  if (sameName) connector = { ...connector, id: sameName.id };
  const idx = room.connectors.findIndex((c) => c.id === connector.id);
  if (idx >= 0) {
    room.connectors[idx] = connector;
  } else {
    room.connectors.unshift(connector);
    room.connectors = room.connectors.slice(0, 60);
  }
  broadcastRoomEvent(room.roomId, 'state:sync', getRoomSnapshot(room.roomId));
  return connector;
}

export function deleteRoomConnector(roomId: string, connectorId: string): boolean {
  const room = getOrCreateRoom(roomId);
  const before = room.connectors.length;
  room.connectors = room.connectors.filter((c) => c.id !== connectorId);
  if (room.connectors.length !== before) {
    broadcastRoomEvent(room.roomId, 'state:sync', getRoomSnapshot(room.roomId));
    return true;
  }
  return false;
}

export function clearCompletedTasks(roomId: string): number {
  const room = getOrCreateRoom(roomId);
  const before = room.tasks.length;
  room.tasks = room.tasks.filter((t) => !t.completed);
  const removed = before - room.tasks.length;
  broadcastRoomEvent(room.roomId, 'state:sync', getRoomSnapshot(room.roomId));
  return removed;
}

export function clearStaleHandoffs(roomId: string, maxAgeMs = 3_600_000): number {
  const room = getOrCreateRoom(roomId);
  const cutoff = Date.now() - maxAgeMs;
  const before = room.handoffs.length;
  room.handoffs = room.handoffs.filter((h) => h.createdAt >= cutoff);
  const removed = before - room.handoffs.length;
  broadcastRoomEvent(room.roomId, 'state:sync', getRoomSnapshot(room.roomId));
  return removed;
}

function matchDevices(pool: DeviceInfo[], targetQuery: string): DeviceInfo[] {
  const q = (targetQuery || 'all').trim().toLowerCase();
  if (q === 'all' || q === 'every' || q === 'everywhere' || q === 'broadcast' || q === '') {
    return pool;
  }

  const byId = pool.find((d) => d.id.toLowerCase() === q);
  if (byId) return [byId];

  const byName = pool.filter((d) => d.name.toLowerCase().includes(q));
  if (byName.length > 0) return byName;

  if (q.includes('phone') || q.includes('mobile') || q.includes('iphone') || q.includes('android')) {
    const mobiles = pool.filter((d) => d.type === 'mobile' || /android/i.test(d.os));
    if (mobiles.length > 0) return mobiles;
  }
  if (q.includes('tablet') || q.includes('ipad')) {
    const tablets = pool.filter((d) => d.type === 'tablet');
    if (tablets.length > 0) return tablets;
  }
  if (q.includes('browser') || q.includes('chrome') || q.includes('tab')) {
    const ext = pool.filter((d) => d.capabilities?.includes('browser-tabs'));
    if (ext.length > 0) return ext;
  }
  if (q.includes('bridge') || q.includes('terminal') || q.includes('host') || q.includes('cli')) {
    const bridges = pool.filter((d) => d.type === 'bridge');
    if (bridges.length > 0) return bridges;
    const browserRelays = pool.filter((d) => d.capabilities?.includes('os-bridge'));
    if (browserRelays.length > 0) return browserRelays;
  }
  if (q.includes('desktop') || q.includes('laptop') || q.includes('computer') || q.includes('mac') || q.includes('pc') || q.includes('windows')) {
    const desktops = pool.filter(
      (d) => (d.type === 'desktop' || d.type === 'bridge' || d.capabilities?.includes('os-bridge')) && !/android/i.test(d.os)
    );
    if (desktops.length > 0) return desktops;
  }

  return [];
}

export function resolveTargetDevices(room: RoomState, targetQuery: string): DeviceInfo[] {
  return matchDevices(
    Array.from(room.devices.values()).filter((d) => d.online),
    targetQuery
  );
}

/** Offline devices that match a query (excluding "all" – we never queue broadcasts). */
function resolveOfflineTargets(room: RoomState, targetQuery: string): DeviceInfo[] {
  const q = (targetQuery || 'all').trim().toLowerCase();
  if (!q || q === 'all' || q === 'every' || q === 'everywhere' || q === 'broadcast') return [];
  return matchDevices(
    Array.from(room.devices.values()).filter((d) => !d.online),
    targetQuery
  );
}

/**
 * Pick the device that can actually *execute* an OS-level action (open a real tab,
 * launch an app). Preference: device the user named -> RAY Tabs extension (for URLs)
 * -> Desktop OS bridge -> Android bridge -> browser relay with a local bridge.
 */
export function pickExecutorDevice(
  roomId: string,
  targetQuery: string,
  need: 'url' | 'app' | 'os'
): DeviceInfo | null {
  const room = getOrCreateRoom(roomId);
  const online = Array.from(room.devices.values()).filter((d) => d.online);
  const q = (targetQuery || 'all').trim().toLowerCase();
  const named = q && q !== 'all' ? matchDevices(online, q) : online;
  const canExec = (d: DeviceInfo) =>
    d.type === 'bridge' || d.capabilities?.includes('os-bridge') || (need === 'url' && d.capabilities?.includes('browser-tabs'));
  const rank = (d: DeviceInfo) => {
    if (need === 'url' && d.capabilities?.includes('browser-tabs')) return 0;
    if (d.type === 'bridge' && !/android/i.test(d.os)) return 1;
    if (d.type === 'bridge') return 2;
    return 3;
  };
  const candidates = named.filter(canExec).sort((a, b) => rank(a) - rank(b) || b.lastSeen - a.lastSeen);
  return candidates[0] || null;
}

export async function dispatchBridgeProxyCall(
  roomId: string,
  payload: Record<string, unknown>,
  timeoutMs = 15000,
  preferDeviceQuery?: string
): Promise<{ ok: boolean; data?: unknown; error?: string; deviceName?: string }> {
  const room = getOrCreateRoom(roomId);
  const online = Array.from(room.devices.values()).filter((d) => d.online);
  const isExec = (d: DeviceInfo) => d.type === 'bridge' || (Array.isArray(d.capabilities) && d.capabilities.includes('os-bridge'));
  const preferred =
    preferDeviceQuery && preferDeviceQuery !== 'all' ? matchDevices(online, preferDeviceQuery).find(isExec) : undefined;
  const bridgeDevice =
    preferred ||
    online.find((d) => d.type === 'bridge' && !/android/i.test(d.os)) ||
    online.find((d) => d.type === 'bridge') ||
    online.find((d) => Array.isArray(d.capabilities) && d.capabilities.includes('os-bridge'));
  if (!bridgeDevice) {
    return {
      ok: false,
      error: 'No online Desktop OS Bridge found in this room. Start the bridge script on your computer (or keep your PC RAY browser tab open with Bridge 17345 active).',
    };
  }
  const ws = room.sockets.get(bridgeDevice.id);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return { ok: false, error: 'Desktop OS Bridge socket is not open.' };
  }

  const requestId = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingProxyWaiters.delete(requestId);
      resolve({ ok: false, error: 'Desktop OS Bridge proxy request timed out.' });
    }, timeoutMs);

    pendingProxyWaiters.set(requestId, {
      resolve: (payload) => resolve({ ...payload, deviceName: bridgeDevice.name }),
      timer,
    });
    ws.send(
      JSON.stringify({
        event: 'bridge:proxy_request',
        data: { requestId, ...payload },
      })
    );
  });
}

export async function dispatchDeviceCommand(params: {
  roomId: string;
  type: CommandType;
  targetQuery: string;
  source: 'assistant' | 'user' | 'routine' | 'protocol';
  payload: Record<string, unknown>;
  waitForAckMs?: number;
}): Promise<{ command: DeviceCommand; summary: string }> {
  const room = getOrCreateRoom(params.roomId);
  const targets = resolveTargetDevices(room, params.targetQuery);

  const isAll = !params.targetQuery || params.targetQuery.toLowerCase() === 'all';
  const targetLabel =
    targets.length === 0
      ? params.targetQuery || 'none'
      : isAll
      ? `All online devices (${targets.length})`
      : targets.map((t) => t.name).join(', ');

  const command: DeviceCommand = {
    id: crypto.randomUUID(),
    roomId: room.roomId,
    type: params.type,
    targetDeviceId: isAll ? 'all' : targets.map((t) => t.id).join(','),
    targetDeviceLabel: targetLabel,
    source: params.source,
    payload: params.payload,
    createdAt: Date.now(),
    status: targets.length > 0 ? 'dispatched' : 'failed',
    results: [],
  };

  if (targets.length === 0) {
    const offline = resolveOfflineTargets(room, params.targetQuery);
    if (offline.length > 0 && params.type !== 'refresh_telemetry') {
      command.status = 'queued';
      command.targetDeviceId = offline.map((d) => d.id).join(',');
      command.targetDeviceLabel = offline.map((d) => d.name).join(', ');
      for (const d of offline) {
        const q = room.queuedCommands[d.id] || [];
        q.push(command);
        room.queuedCommands[d.id] = q.slice(-25);
      }
      const wakeSummary = await wakeOfflineDevices({
        roomId: room.roomId,
        targets: offline,
        onlineDevices: Array.from(room.devices.values()).filter((d) => d.online),
        pushSubscriptions: room.pushSubscriptions,
        reason: describeCommand(params.type, params.payload),
        url:
          params.type === 'call'
            ? `/?answer=${encodeURIComponent(String(params.payload.callId || ''))}&kind=${encodeURIComponent(String(params.payload.kind || 'ray'))}` +
              (params.payload.fromDeviceId ? `&from=${encodeURIComponent(String(params.payload.fromDeviceId))}` : '') +
              (params.payload.message ? `&m=${encodeURIComponent(String(params.payload.message).slice(0, 300))}` : '')
            : undefined,
        sendToDevice: (deviceId, packet) => {
          const ws = room.sockets.get(deviceId);
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(packet));
            return true;
          }
          return false;
        },
        onExpiredSubscription: (deviceId) => {
          delete room.pushSubscriptions[deviceId];
        },
      });
      const msg = `${command.targetDeviceLabel} is offline — command queued and will run as soon as it reconnects. ${wakeSummary}`.trim();
      command.results.push({
        deviceId: offline[0].id,
        deviceName: offline[0].name,
        status: 'acknowledged',
        message: msg,
        timestamp: Date.now(),
      });
      room.commands.unshift(command);
      room.commands = room.commands.slice(0, 60);
      broadcastRoomEvent(room.roomId, 'command:dispatched', command);
      persistRoom(room);
      return { command, summary: msg };
    }
    command.results.push({
      deviceId: 'none',
      deviceName: params.targetQuery || 'Unknown',
      status: 'failed',
      message: `No online device matched "${params.targetQuery}". Connected online devices: ${
        Array.from(room.devices.values())
          .filter((d) => d.online)
          .map((d) => `${d.name} (${d.type})`)
          .join(', ') || 'none'
      }.`,
      timestamp: Date.now(),
    });
    room.commands.unshift(command);
    room.commands = room.commands.slice(0, 60);
    broadcastRoomEvent(room.roomId, 'command:dispatched', command);
    return { command, summary: command.results[0].message };
  }

  room.commands.unshift(command);
  room.commands = room.commands.slice(0, 60);
  broadcastRoomEvent(room.roomId, 'command:dispatched', command);

  const waitMs = params.waitForAckMs ?? 2500;
  const expectedIds = new Set(targets.map((t) => t.id));

  const ackPromise = new Promise<CommandExecutionResult[]>((resolve) => {
    const timer = setTimeout(() => {
      const waiter = pendingWaiters.get(command.id);
      if (waiter) {
        pendingWaiters.delete(command.id);
        resolve(waiter.receivedResults);
      } else {
        resolve([]);
      }
    }, waitMs);

    pendingWaiters.set(command.id, {
      expectedDeviceIds: expectedIds,
      receivedResults: [],
      resolve,
      timer,
    });
  });

  const executePacket = JSON.stringify({
    event: 'command:execute',
    data: command,
  });
  for (const target of targets) {
    const ws = room.sockets.get(target.id);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(executePacket);
    }
  }

  const results = await ackPromise;
  if (results.length > 0) {
    const allCompleted = results.every((r) => r.status === 'completed' || r.status === 'acknowledged');
    command.status = allCompleted ? 'completed' : 'failed';
    const summary = results.map((r) => `${r.deviceName}: ${r.message}`).join(' | ');
    return { command, summary };
  }

  return {
    command,
    summary: `Dispatched "${params.type}" to ${targetLabel}. Waiting for device confirmation.`,
  };
}

function describeCommand(type: CommandType, payload: Record<string, unknown>): string {
  switch (type) {
    case 'open_url':
      return `Open ${String(payload.title || payload.url || 'a link')}`;
    case 'notify':
      return String(payload.title || 'New notification from RAY');
    case 'speak':
      return String(payload.text || 'RAY has a message for you').slice(0, 120);
    case 'bridge_command':
      return `Run ${String(payload.action || 'a command')}`;
    case 'call':
      return payload.kind === 'peer'
        ? `Incoming call from ${String(payload.fromName || 'your other device')}`
        : `RAY is calling: ${String(payload.message || 'pick up').slice(0, 100)}`;
    default:
      return `RAY ${type.replace(/_/g, ' ')}`;
  }
}

function flushQueuedCommands(room: RoomState, deviceId: string, ws: WebSocket): void {
  const queue = room.queuedCommands[deviceId];
  if (!queue || queue.length === 0) return;
  delete room.queuedCommands[deviceId];
  const fresh = queue.filter((c) => Date.now() - c.createdAt < 24 * 3600_000);
  for (const cmd of fresh) {
    cmd.status = 'dispatched';
    ws.send(JSON.stringify({ event: 'command:execute', data: { ...cmd, targetDeviceId: deviceId } }));
  }
  persistRoom(room);
}

export function handleCommandAck(
  roomId: string,
  ack: {
    commandId: string;
    deviceId: string;
    status: 'acknowledged' | 'completed' | 'failed';
    message: string;
    data?: Record<string, unknown>;
  }
): void {
  const room = getOrCreateRoom(roomId);
  const device = room.devices.get(ack.deviceId);
  const deviceName = device?.name ?? ack.deviceId;
  const cmd = room.commands.find((c) => c.id === ack.commandId);

  const result: CommandExecutionResult = {
    deviceId: ack.deviceId,
    deviceName,
    status: ack.status,
    message: ack.message,
    timestamp: Date.now(),
    data: ack.data,
  };

  if (cmd) {
    const existingIdx = cmd.results.findIndex((r) => r.deviceId === ack.deviceId);
    if (existingIdx >= 0) {
      cmd.results[existingIdx] = result;
    } else {
      cmd.results.push(result);
    }
    cmd.status = ack.status === 'failed' ? 'failed' : 'completed';
    broadcastRoomEvent(room.roomId, 'command:updated', cmd);
  }

  const waiter = pendingWaiters.get(ack.commandId);
  if (waiter) {
    waiter.receivedResults.push(result);
    waiter.expectedDeviceIds.delete(ack.deviceId);
    if (waiter.expectedDeviceIds.size === 0) {
      clearTimeout(waiter.timer);
      pendingWaiters.delete(ack.commandId);
      waiter.resolve(waiter.receivedResults);
    }
  }
}

export function addSharedTask(
  roomId: string,
  title: string,
  assignedDevice = 'All Devices',
  meta?: Partial<Pick<SharedTask, 'category' | 'priority' | 'effortMinutes' | 'analysisId'>>
): SharedTask {
  const room = getOrCreateRoom(roomId);
  const task: SharedTask = {
    id: crypto.randomUUID(),
    title: title.trim(),
    completed: false,
    assignedDevice,
    category: meta?.category || 'general',
    priority: meta?.priority || 'medium',
    effortMinutes: meta?.effortMinutes,
    analysisId: meta?.analysisId,
    createdAt: Date.now(),
  };
  room.tasks.unshift(task);
  broadcastRoomEvent(room.roomId, 'state:sync', getRoomSnapshot(roomId));
  return task;
}

export function toggleSharedTask(roomId: string, taskId: string, completed?: boolean): SharedTask | null {
  const room = getOrCreateRoom(roomId);
  const task = room.tasks.find((t) => t.id === taskId || t.title.toLowerCase().includes(taskId.toLowerCase()));
  if (!task) return null;
  task.completed = typeof completed === 'boolean' ? completed : !task.completed;
  broadcastRoomEvent(room.roomId, 'state:sync', getRoomSnapshot(roomId));
  return task;
}

export function deleteSharedTask(roomId: string, taskId: string): boolean {
  const room = getOrCreateRoom(roomId);
  const before = room.tasks.length;
  room.tasks = room.tasks.filter((t) => t.id !== taskId);
  if (room.tasks.length !== before) {
    broadcastRoomEvent(room.roomId, 'state:sync', getRoomSnapshot(roomId));
    return true;
  }
  return false;
}

export function addHandoffItem(
  roomId: string,
  params: { label: string; content: string; kind: 'text' | 'link' | 'code' | 'image'; sourceDevice: string; targetDevice: string }
): HandoffItem {
  const room = getOrCreateRoom(roomId);
  const item: HandoffItem = {
    id: crypto.randomUUID(),
    label: params.label,
    content: params.content,
    kind: params.kind,
    sourceDevice: params.sourceDevice,
    targetDevice: params.targetDevice,
    createdAt: Date.now(),
  };
  room.handoffs.unshift(item);
  room.handoffs = room.handoffs.slice(0, 40);
  broadcastRoomEvent(room.roomId, 'state:sync', getRoomSnapshot(roomId));
  return item;
}

export function deleteHandoffItem(roomId: string, itemId: string): void {
  const room = getOrCreateRoom(roomId);
  room.handoffs = room.handoffs.filter((h) => h.id !== itemId);
  broadcastRoomEvent(room.roomId, 'state:sync', getRoomSnapshot(roomId));
}

export function addSyncTimer(roomId: string, label: string, durationSeconds: number, targetDevice: string): SyncTimer {
  const room = getOrCreateRoom(roomId);
  const safeDuration = Math.max(5, Math.min(86400, Math.round(durationSeconds)));
  const timer: SyncTimer = {
    id: crypto.randomUUID(),
    label: label || 'Timer',
    durationSeconds: safeDuration,
    endsAt: Date.now() + safeDuration * 1000,
    targetDevice: targetDevice || 'all',
    createdAt: Date.now(),
  };
  room.timers.unshift(timer);
  broadcastRoomEvent(room.roomId, 'state:sync', getRoomSnapshot(roomId));
  return timer;
}

export function cancelSyncTimer(roomId: string, timerId: string): void {
  const room = getOrCreateRoom(roomId);
  room.timers = room.timers.filter((t) => t.id !== timerId);
  broadcastRoomEvent(room.roomId, 'state:sync', getRoomSnapshot(roomId));
}

export function saveRoutinePlan(roomId: string, routine: Omit<RoutinePlan, 'id' | 'createdAt'>): RoutinePlan {
  const room = getOrCreateRoom(roomId);
  const plan: RoutinePlan = {
    ...routine,
    id: crypto.randomUUID(),
    createdAt: Date.now(),
  };
  room.routines.unshift(plan);
  broadcastRoomEvent(room.roomId, 'state:sync', getRoomSnapshot(roomId));
  return plan;
}

export function deleteRoutinePlan(roomId: string, routineId: string): void {
  const room = getOrCreateRoom(roomId);
  room.routines = room.routines.filter((r) => r.id !== routineId);
  broadcastRoomEvent(room.roomId, 'state:sync', getRoomSnapshot(roomId));
}

const socketAlive = new WeakMap<WebSocket, boolean>();
let heartbeatStarted = false;

/** Server-side heartbeat: terminate half-open sockets so devices show offline quickly and reconnect. */
function startHeartbeat(): void {
  if (heartbeatStarted) return;
  heartbeatStarted = true;
  setInterval(() => {
    for (const room of rooms.values()) {
      for (const ws of room.sockets.values()) {
        if (socketAlive.get(ws) === false) {
          try {
            ws.terminate();
          } catch {
            // ignore
          }
          continue;
        }
        socketAlive.set(ws, false);
        try {
          ws.ping();
        } catch {
          // ignore
        }
      }
    }
  }, 25_000).unref();
}

export function handleSocketConnection(ws: WebSocket, roomId: string): void {
  const room = getOrCreateRoom(roomId);
  let registeredDeviceId: string | null = null;
  startHeartbeat();
  socketAlive.set(ws, true);
  ws.on('pong', () => socketAlive.set(ws, true));

  ws.send(JSON.stringify({ event: 'state:sync', data: getRoomSnapshot(room.roomId) }));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as { event: string; data?: Record<string, unknown> };
      const data = msg.data ?? {};

      switch (msg.event) {
        case 'device:register': {
          const deviceId = String(data.id || crypto.randomUUID());
          registeredDeviceId = deviceId;
          const existing = room.devices.get(deviceId);
          const device: DeviceInfo = {
            id: deviceId,
            name: String(data.name || existing?.name || 'Connected Device'),
            type: (data.type as DeviceInfo['type']) || existing?.type || 'desktop',
            os: String(data.os || existing?.os || 'Unknown OS'),
            browser: String(data.browser || existing?.browser || 'Browser'),
            capabilities: Array.isArray(data.capabilities)
              ? (data.capabilities as string[])
              : existing?.capabilities || ['notify', 'clipboard', 'speak', 'timers'],
            online: true,
            lastSeen: Date.now(),
            telemetry: (data.telemetry as DeviceTelemetry) || existing?.telemetry || {},
            macAddress:
              typeof data.macAddress === 'string' && /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(data.macAddress)
                ? data.macAddress
                : existing?.macAddress,
            pushEnabled: Boolean(room.pushSubscriptions[deviceId]),
          };
          room.devices.set(deviceId, device);
          // Same device re-registering under a new id (cleared storage, reinstall): drop the stale offline twin.
          for (const [otherId, other] of room.devices) {
            if (otherId !== deviceId && !other.online && other.name === device.name && other.type === device.type) {
              room.devices.delete(otherId);
              delete room.queuedCommands[otherId];
            }
          }
          // Forget devices that have been offline for 14 days.
          for (const [otherId, other] of room.devices) {
            if (!other.online && Date.now() - other.lastSeen > 14 * 86400_000) room.devices.delete(otherId);
          }
          const previous = room.sockets.get(deviceId);
          if (previous && previous !== ws && previous.readyState === WebSocket.OPEN) {
            try {
              previous.close(4000, 'Replaced by newer connection');
            } catch {
              // ignore
            }
          }
          room.sockets.set(deviceId, ws);
          broadcastRoomEvent(room.roomId, 'state:sync', getRoomSnapshot(room.roomId));
          flushQueuedCommands(room, deviceId, ws);
          break;
        }

        case 'push:subscribe': {
          const deviceId = String(data.id || registeredDeviceId || '');
          if (deviceId && data.subscription && typeof data.subscription === 'object') {
            room.pushSubscriptions[deviceId] = data.subscription;
            const device = room.devices.get(deviceId);
            if (device) device.pushEnabled = true;
            broadcastRoomEvent(room.roomId, 'state:sync', getRoomSnapshot(room.roomId));
          }
          break;
        }

        case 'call:signal': {
          // WebRTC signalling between two devices (accept / offer / answer / ice / hangup / decline).
          const to = String(data.to || '');
          const target = room.sockets.get(to);
          if (target && target.readyState === WebSocket.OPEN && registeredDeviceId) {
            target.send(
              JSON.stringify({
                event: 'call:signal',
                data: { ...data, from: registeredDeviceId, fromName: room.devices.get(registeredDeviceId)?.name || 'Device' },
              })
            );
          } else if (registeredDeviceId) {
            ws.send(JSON.stringify({ event: 'call:signal', data: { type: 'unavailable', callId: data.callId, from: to } }));
          }
          break;
        }

        case 'device:ping': {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event: 'device:pong', data: { t: Date.now() } }));
          break;
        }

        case 'messages:incoming': {
          // Incoming WhatsApp / Instagram / SMS notifications relayed by a phone bridge or Meta webhook.
          const items = Array.isArray(data.items) ? (data.items as unknown[]) : [];
          const sourceName = registeredDeviceId ? room.devices.get(registeredDeviceId)?.name || 'Phone' : 'Phone';
          for (const raw of items.slice(0, 20)) {
            const it = raw as Record<string, unknown>;
            recordIncomingMessage(room.roomId, {
              app: String(it.app || 'unknown'),
              from: String(it.from || it.title || 'Unknown'),
              text: String(it.text || it.content || ''),
              receivedAt: Number(it.receivedAt || Date.now()),
              viaDevice: sourceName,
            });
          }
          break;
        }

        case 'tabs:update': {
          const deviceId = String(data.id || registeredDeviceId || '');
          const device = room.devices.get(deviceId);
          if (device) {
            const tabs = Array.isArray(data.tabs) ? (data.tabs as BrowserTabInfo[]).slice(0, 80) : [];
            room.browserTabs[deviceId] = tabs;
            device.telemetry = { ...device.telemetry, openTabCount: tabs.length };
            device.lastSeen = Date.now();
          }
          break;
        }

        case 'device:telemetry': {
          const deviceId = String(data.id || registeredDeviceId || '');
          const device = room.devices.get(deviceId);
          if (device) {
            device.telemetry = { ...device.telemetry, ...(data.telemetry as DeviceTelemetry) };
            device.lastSeen = Date.now();
            device.online = true;
            broadcastRoomEvent(room.roomId, 'device:updated', device);
          }
          break;
        }

        case 'device:rename': {
          const deviceId = String(data.id || '');
          const newName = String(data.name || '').trim();
          const device = room.devices.get(deviceId);
          if (device && newName) {
            device.name = newName.slice(0, 40);
            broadcastRoomEvent(room.roomId, 'state:sync', getRoomSnapshot(room.roomId));
          }
          break;
        }

        case 'device:remove': {
          const deviceId = String(data.id || '');
          if (deviceId) {
            room.devices.delete(deviceId);
            const sock = room.sockets.get(deviceId);
            if (sock && sock !== ws) {
              sock.close();
            }
            room.sockets.delete(deviceId);
            broadcastRoomEvent(room.roomId, 'state:sync', getRoomSnapshot(room.roomId));
          }
          break;
        }

        case 'command:ack': {
          handleCommandAck(room.roomId, {
            commandId: String(data.commandId || ''),
            deviceId: String(data.deviceId || registeredDeviceId || ''),
            status: (data.status as 'acknowledged' | 'completed' | 'failed') || 'completed',
            message: String(data.message || 'Done'),
            data: data.data as Record<string, unknown> | undefined,
          });
          break;
        }

        case 'bridge:proxy_response': {
          const requestId = String(data.requestId || '');
          const waiter = pendingProxyWaiters.get(requestId);
          if (waiter) {
            clearTimeout(waiter.timer);
            pendingProxyWaiters.delete(requestId);
            waiter.resolve({
              ok: Boolean(data.ok),
              data: data.data,
              error: typeof data.error === 'string' ? data.error : undefined,
            });
          }
          break;
        }

        case 'task:create': {
          if (typeof data.title === 'string' && data.title.trim()) {
            addSharedTask(room.roomId, data.title, String(data.assignedDevice || 'All Devices'));
          }
          break;
        }

        case 'task:toggle': {
          if (typeof data.id === 'string') {
            toggleSharedTask(room.roomId, data.id, typeof data.completed === 'boolean' ? data.completed : undefined);
          }
          break;
        }

        case 'task:delete': {
          if (typeof data.id === 'string') {
            deleteSharedTask(room.roomId, data.id);
          }
          break;
        }

        case 'handoff:push': {
          if (typeof data.content === 'string' && data.content.trim()) {
            const target = String(data.targetDevice || 'all');
            const item = addHandoffItem(room.roomId, {
              label: String(data.label || 'Shared Note'),
              content: data.content,
              kind: (data.kind as HandoffItem['kind']) || 'text',
              sourceDevice: String(data.sourceDevice || 'Device'),
              targetDevice: target,
            });
            if (item.kind !== 'image') {
              void dispatchDeviceCommand({
                roomId: room.roomId,
                type: 'clipboard',
                targetQuery: target,
                source: 'user',
                payload: { content: item.content, label: item.label },
                waitForAckMs: 800,
              });
            }
          }
          break;
        }

        case 'handoff:delete': {
          if (typeof data.id === 'string') {
            deleteHandoffItem(room.roomId, data.id);
          }
          break;
        }

        case 'timer:create': {
          const duration = Number(data.durationSeconds || 60);
          const label = String(data.label || 'Focus Timer');
          const target = String(data.targetDevice || 'all');
          const timer = addSyncTimer(room.roomId, label, duration, target);
          void dispatchDeviceCommand({
            roomId: room.roomId,
            type: 'set_timer',
            targetQuery: target,
            source: 'user',
            payload: { timerId: timer.id, label: timer.label, durationSeconds: timer.durationSeconds, endsAt: timer.endsAt },
            waitForAckMs: 800,
          });
          break;
        }

        case 'timer:cancel': {
          if (typeof data.id === 'string') {
            cancelSyncTimer(room.roomId, data.id);
          }
          break;
        }

        case 'routine:delete': {
          if (typeof data.id === 'string') {
            deleteRoutinePlan(room.roomId, data.id);
          }
          break;
        }

        case 'snapshot:submit': {
          const deviceName = registeredDeviceId ? room.devices.get(registeredDeviceId)?.name ?? 'Device' : 'Device';
          if (typeof data.dataUrl === 'string') {
            addHandoffItem(room.roomId, {
              label: `Snapshot from ${deviceName}`,
              content: data.dataUrl,
              kind: 'image',
              sourceDevice: deviceName,
              targetDevice: 'all',
            });
            broadcastRoomEvent(room.roomId, 'snapshot:received', {
              commandId: data.commandId,
              deviceId: registeredDeviceId,
              deviceName,
              dataUrl: data.dataUrl,
              reason: data.reason || 'Remote device snapshot',
            });
          }
          break;
        }
      }
    } catch {
      // Ignore malformed JSON frames
    }
  });

  ws.on('close', () => {
    if (registeredDeviceId) {
      const existingSocket = room.sockets.get(registeredDeviceId);
      if (existingSocket === ws) {
        room.sockets.delete(registeredDeviceId);
        const device = room.devices.get(registeredDeviceId);
        if (device) {
          device.online = false;
          device.lastSeen = Date.now();
          broadcastRoomEvent(room.roomId, 'state:sync', getRoomSnapshot(room.roomId));
        }
      }
    }
  });
}

const BRIDGE_TEMPLATE_PATH = path.join(path.dirname(new URL(import.meta.url).pathname), 'bridge', 'relay-bridge.mjs');
let bridgeTemplateCache: string | null = null;

/**
 * The bridge agent lives in server/bridge/relay-bridge.mjs (a real, syntax-checkable file).
 * We inject the room's WebSocket URL, room id and token so the download "just works".
 */
export function generateBridgeScript(wsUrl: string, roomId: string, roomToken: string): string {
  if (!bridgeTemplateCache || process.env.NODE_ENV !== 'production') {
    bridgeTemplateCache = fs.readFileSync(decodeURIComponent(BRIDGE_TEMPLATE_PATH), 'utf8');
  }
  return bridgeTemplateCache
    .replace('"__RAY_WS_URL__"', JSON.stringify(wsUrl))
    .replace('"__RAY_ROOM_ID__"', JSON.stringify(roomId))
    .replace('"__RAY_ROOM_TOKEN__"', JSON.stringify(roomToken))
    .replace(/relay-bridge-__RAY_ROOM_ID_LOWER__/g, `relay-bridge-${roomId.toLowerCase()}`);
}
