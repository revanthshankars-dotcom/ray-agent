import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { WebSocket } from 'ws';
import type {
  AppConnector,
  BrainNote,
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

function getOrCreatePersistedRoomToken(roomId: string): string {
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
    };
    rooms.set(id, room);
  }
  return room;
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
    devices: Array.from(room.devices.values()).sort(
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
  };
}

export function broadcastRoomEvent(roomId: string, event: string, data: unknown): void {
  const room = getOrCreateRoom(roomId);
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
  room.brainNotes = room.brainNotes.slice(0, 200);
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

export function resolveTargetDevices(room: RoomState, targetQuery: string): DeviceInfo[] {
  const q = (targetQuery || 'all').trim().toLowerCase();
  const allDevices = Array.from(room.devices.values());
  const onlineDevices = allDevices.filter((d) => d.online);

  if (q === 'all' || q === 'every' || q === 'everywhere' || q === 'broadcast' || q === '') {
    return onlineDevices;
  }

  const byId = onlineDevices.find((d) => d.id.toLowerCase() === q);
  if (byId) return [byId];

  const byName = onlineDevices.filter((d) => d.name.toLowerCase().includes(q));
  if (byName.length > 0) return byName;

  if (q.includes('phone') || q.includes('mobile') || q.includes('iphone') || q.includes('android')) {
    const mobiles = onlineDevices.filter((d) => d.type === 'mobile');
    if (mobiles.length > 0) return mobiles;
  }
  if (q.includes('tablet') || q.includes('ipad')) {
    const tablets = onlineDevices.filter((d) => d.type === 'tablet');
    if (tablets.length > 0) return tablets;
  }
  if (q.includes('bridge') || q.includes('terminal') || q.includes('host') || q.includes('cli')) {
    const bridges = onlineDevices.filter((d) => d.type === 'bridge');
    if (bridges.length > 0) return bridges;
    const browserRelays = onlineDevices.filter((d) => d.capabilities?.includes('os-bridge'));
    if (browserRelays.length > 0) return browserRelays;
  }
  if (q.includes('desktop') || q.includes('laptop') || q.includes('computer') || q.includes('mac') || q.includes('pc') || q.includes('windows')) {
    const desktops = onlineDevices.filter(
      (d) => d.type === 'desktop' || d.type === 'bridge' || d.capabilities?.includes('os-bridge')
    );
    if (desktops.length > 0) return desktops;
  }

  return [];
}

export async function dispatchBridgeProxyCall(
  roomId: string,
  payload: Record<string, unknown>,
  timeoutMs = 15000
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const room = getOrCreateRoom(roomId);
  const online = Array.from(room.devices.values()).filter((d) => d.online);
  const bridgeDevice =
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

    pendingProxyWaiters.set(requestId, { resolve, timer });
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

export function handleSocketConnection(ws: WebSocket, roomId: string): void {
  const room = getOrCreateRoom(roomId);
  let registeredDeviceId: string | null = null;

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
          };
          room.devices.set(deviceId, device);
          room.sockets.set(deviceId, ws);
          broadcastRoomEvent(room.roomId, 'state:sync', getRoomSnapshot(room.roomId));
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

export function generateBridgeScript(wsUrl: string, roomId: string, roomToken: string): string {
  return `#!/usr/bin/env node
// RAY / Relay Desktop OS Bridge Agent v2.1 — hardened OS, Filesystem, Screen, Auto-Ollama & Boot Startup bridge
// Usage:
//   npm install ws && node relay-bridge-${roomId.toLowerCase()}.mjs
//   node relay-bridge-${roomId.toLowerCase()}.mjs --install-startup    (Auto-start silently on PC boot!)
//   node relay-bridge-${roomId.toLowerCase()}.mjs --set-token <token>  (Update room token without re-downloading)
//   node relay-bridge-${roomId.toLowerCase()}.mjs --status             (Check bridge + Ollama + startup status)
// Optional env:
//   RELAY_VAULT_DIR=/path/to/ObsidianVault
//   RELAY_ALLOWED_DIRS=/path/one,/path/two   (comma-separated extra folders for RAY file access)
//   OLLAMA_HOST=http://127.0.0.1:11434

import os from 'os';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { execFile, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';

const BRIDGE_VERSION = '2.1';
const WS_URL = process.env.RELAY_WS_URL || ${JSON.stringify(wsUrl)};
const ROOM_ID = process.env.RELAY_ROOM_ID || ${JSON.stringify(roomId)};
const DEFAULT_ROOM_TOKEN = ${JSON.stringify(roomToken)};
const OLLAMA_HOST = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace('://localhost', '://127.0.0.1');
const LOCAL_PORT = Number(process.env.RELAY_LOCAL_PORT || 17345);
const VAULT_ROOT_RAW = process.env.RELAY_VAULT_DIR || path.join(os.homedir(), 'Documents', 'RAY-Brain');
const DEVICE_ID = 'bridge-' + os.hostname().toLowerCase().replace(/[^a-z0-9]/g, '');
const DEVICE_NAME = process.env.RELAY_DEVICE_NAME || (os.hostname() + ' (OS Bridge)');

const CONFIG_DIR = path.join(os.homedir(), '.ray-bridge');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config-' + ROOM_ID.toLowerCase() + '.json');

function loadSavedBridgeConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch {}
  return {};
}

function saveBridgeConfig(patch) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const next = { ...loadSavedBridgeConfig(), ...patch, updatedAt: Date.now() };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

const savedCfg = loadSavedBridgeConfig();
let ROOM_TOKEN = String(process.env.RELAY_ROOM_TOKEN || savedCfg.roomToken || DEFAULT_ROOM_TOKEN).trim();

function getStartupLocations() {
  const plat = os.platform();
  if (plat === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    const installDir = path.join(appData, 'RAY-Bridge');
    const startupFolder = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    return {
      plat,
      installDir,
      scriptTarget: path.join(installDir, 'relay-bridge.mjs'),
      startupFile: path.join(startupFolder, 'RAY-Bridge-' + ROOM_ID + '.vbs'),
      logFile: path.join(installDir, 'bridge.log'),
    };
  }
  if (plat === 'darwin') {
    const installDir = path.join(os.homedir(), 'Library', 'Application Support', 'RAY-Bridge');
    return {
      plat,
      installDir,
      scriptTarget: path.join(installDir, 'relay-bridge.mjs'),
      startupFile: path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.ray.bridge.' + ROOM_ID.toLowerCase() + '.plist'),
      logFile: path.join(installDir, 'bridge.log'),
    };
  }
  const installDir = path.join(os.homedir(), '.local', 'share', 'ray-bridge');
  return {
    plat,
    installDir,
    scriptTarget: path.join(installDir, 'relay-bridge.mjs'),
    startupFile: path.join(os.homedir(), '.config', 'systemd', 'user', 'ray-bridge-' + ROOM_ID.toLowerCase() + '.service'),
    logFile: path.join(installDir, 'bridge.log'),
  };
}

function isStartupInstalled() {
  try {
    return fs.existsSync(getStartupLocations().startupFile);
  } catch {
    return false;
  }
}

function runSyncExec(cmd, args, cwd) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: 60000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

async function handleCliFlags() {
  const args = process.argv.slice(2);
  const setTokenIdx = args.indexOf('--set-token');
  if (setTokenIdx >= 0) {
    const newToken = String(args[setTokenIdx + 1] || '').trim();
    if (!newToken || newToken.length < 16) {
      console.error('[RAY Bridge] Invalid token. Usage: node relay-bridge.mjs --set-token <room_token>');
      process.exit(1);
    }
    saveBridgeConfig({ roomToken: newToken });
    ROOM_TOKEN = newToken;
    console.log('[RAY Bridge] Saved updated room token for', ROOM_ID, 'in', CONFIG_FILE);
    console.log('[RAY Bridge] Restart any running background bridge (or reboot) to apply immediately.');
    if (!args.includes('--install-startup')) process.exit(0);
  }

  if (args.includes('--uninstall-startup')) {
    const loc = getStartupLocations();
    if (loc.plat === 'darwin' && fs.existsSync(loc.startupFile)) {
      await runSyncExec('launchctl', ['unload', loc.startupFile]);
    } else if (loc.plat === 'linux' && fs.existsSync(loc.startupFile)) {
      await runSyncExec('systemctl', ['--user', 'disable', '--now', path.basename(loc.startupFile)]);
    }
    if (fs.existsSync(loc.startupFile)) {
      fs.unlinkSync(loc.startupFile);
      console.log('[RAY Bridge] Removed auto-start entry:', loc.startupFile);
    } else {
      console.log('[RAY Bridge] No auto-start entry found at:', loc.startupFile);
    }
    process.exit(0);
  }

  if (args.includes('--install-startup')) {
    const loc = getStartupLocations();
    const selfPath = fileURLToPath(import.meta.url);
    fs.mkdirSync(loc.installDir, { recursive: true });
    let srcCode = fs.readFileSync(selfPath, 'utf8');
    // Bake latest ROOM_TOKEN into persistent config so installed script keeps it synced
    saveBridgeConfig({ roomToken: ROOM_TOKEN });
    fs.writeFileSync(loc.scriptTarget, srcCode, 'utf8');

    if (!fs.existsSync(path.join(loc.installDir, 'node_modules', 'ws'))) {
      console.log('[RAY Bridge] Installing ws dependency into', loc.installDir, '...');
      const npmBin = loc.plat === 'win32' ? 'npm.cmd' : 'npm';
      await runSyncExec(npmBin, ['install', '--no-audit', '--no-fund', 'ws'], loc.installDir);
    }

    if (loc.plat === 'win32') {
      fs.mkdirSync(path.dirname(loc.startupFile), { recursive: true });
      const nodeBin = process.execPath;
      const launchCmd = path.join(loc.installDir, 'launch.cmd');
      const cmdContent = '@echo off\\r\\n"' + nodeBin + '" "' + loc.scriptTarget + '" >> "' + loc.logFile + '" 2>&1\\r\\n';
      fs.writeFileSync(launchCmd, cmdContent, 'utf8');
      const vbs = 'Set WshShell = CreateObject("WScript.Shell")\\r\\n' +
        'WshShell.Run Chr(34) & "' + launchCmd.replace(/"/g, '""') + '" & Chr(34), 0, False\\r\\n';
      fs.writeFileSync(loc.startupFile, vbs, 'utf8');
      console.log('[RAY Bridge] Installed silent Windows Startup launcher:', loc.startupFile);
      spawn('wscript.exe', [loc.startupFile], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      console.log('[RAY Bridge] Background bridge started silently! Check log at:', loc.logFile);
    } else if (loc.plat === 'darwin') {
      fs.mkdirSync(path.dirname(loc.startupFile), { recursive: true });
      const label = 'com.ray.bridge.' + ROOM_ID.toLowerCase();
      const plist = '<?xml version="1.0" encoding="UTF-8"?>\\n' +
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\\n' +
        '<plist version="1.0"><dict>\\n' +
        '  <key>Label</key><string>' + label + '</string>\\n' +
        '  <key>ProgramArguments</key><array><string>' + process.execPath + '</string><string>' + loc.scriptTarget + '</string></array>\\n' +
        '  <key>RunAtLoad</key><true/>\\n' +
        '  <key>KeepAlive</key><true/>\\n' +
        '  <key>StandardOutPath</key><string>' + loc.logFile + '</string>\\n' +
        '  <key>StandardErrorPath</key><string>' + loc.logFile + '</string>\\n' +
        '</dict></plist>\\n';
      fs.writeFileSync(loc.startupFile, plist, 'utf8');
      await runSyncExec('launchctl', ['unload', loc.startupFile]);
      await runSyncExec('launchctl', ['load', '-w', loc.startupFile]);
      console.log('[RAY Bridge] Installed & started macOS LaunchAgent:', loc.startupFile);
    } else {
      fs.mkdirSync(path.dirname(loc.startupFile), { recursive: true });
      const svcName = path.basename(loc.startupFile);
      const unit = '[Unit]\\nDescription=RAY Desktop OS Bridge (' + ROOM_ID + ')\\nAfter=network-online.target\\n\\n' +
        '[Service]\\nExecStart=' + process.execPath + ' ' + loc.scriptTarget + '\\nRestart=always\\nRestartSec=5\\n\\n' +
        '[Install]\\nWantedBy=default.target\\n';
      fs.writeFileSync(loc.startupFile, unit, 'utf8');
      await runSyncExec('systemctl', ['--user', 'daemon-reload']);
      await runSyncExec('systemctl', ['--user', 'enable', '--now', svcName]);
      console.log('[RAY Bridge] Installed & started Linux systemd user service:', loc.startupFile);
    }
    process.exit(0);
  }

  if (args.includes('--status')) {
    await ensureOllamaRunning(false);
    console.log(JSON.stringify({
      bridgeVersion: BRIDGE_VERSION,
      roomId: ROOM_ID,
      localPort: LOCAL_PORT,
      startupInstalled: isStartupInstalled(),
      ollamaRunning: ollamaState.running,
      ollamaModels: ollamaState.models,
    }, null, 2));
    process.exit(0);
  }
}

const ollamaState = {
  running: false,
  models: [],
  lastCheck: 0,
  autoStartAttempted: false,
};

function findOllamaBinary() {
  const candidates = [];
  if (os.platform() === 'win32') {
    if (process.env.LOCALAPPDATA) {
      candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe'));
    }
    if (process.env.ProgramFiles) {
      candidates.push(path.join(process.env.ProgramFiles, 'Ollama', 'ollama.exe'));
    }
    candidates.push('ollama.exe', 'ollama');
  } else {
    candidates.push('/opt/homebrew/bin/ollama', '/usr/local/bin/ollama', '/usr/bin/ollama', 'ollama');
  }
  for (const c of candidates) {
    if (!c.includes(path.sep)) return c;
    try {
      if (fs.existsSync(c)) return c;
    } catch {}
  }
  return 'ollama';
}

async function pingOllamaOnce() {
  try {
    const r = await fetch(OLLAMA_HOST.replace(/\\/+$/, '') + '/api/tags', { signal: AbortSignal.timeout(2500) });
    if (r.ok) {
      const data = await r.json();
      ollamaState.running = true;
      ollamaState.models = Array.isArray(data?.models) ? data.models.map((m) => m.name).filter(Boolean) : [];
      ollamaState.lastCheck = Date.now();
      return true;
    }
  } catch {}
  ollamaState.running = false;
  ollamaState.models = [];
  ollamaState.lastCheck = Date.now();
  return false;
}

async function ensureOllamaRunning(allowSpawn = true) {
  const alive = await pingOllamaOnce();
  if (alive) return true;
  if (!allowSpawn) return false;
  try {
    const bin = findOllamaBinary();
    const child = spawn(bin, ['serve'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, OLLAMA_ORIGINS: '*' },
    });
    child.on('error', () => {});
    child.unref();
    if (!ollamaState.autoStartAttempted) {
      ollamaState.autoStartAttempted = true;
      console.log('[RAY Bridge] Auto-starting Ollama background daemon (' + bin + ')...');
    }
    await new Promise((r) => setTimeout(r, 1800));
    return await pingOllamaOnce();
  } catch {
    return false;
  }
}

await handleCliFlags();

fs.mkdirSync(VAULT_ROOT_RAW, { recursive: true });
const VAULT_ROOT = fs.realpathSync(VAULT_ROOT_RAW);

function buildAllowedFsRoots() {
  const candidates = [
    { id: 'desktop', label: 'Desktop', dir: path.join(os.homedir(), 'Desktop') },
    { id: 'documents', label: 'Documents', dir: path.join(os.homedir(), 'Documents') },
    { id: 'downloads', label: 'Downloads', dir: path.join(os.homedir(), 'Downloads') },
    { id: 'vault', label: 'RAY Brain Vault', dir: VAULT_ROOT },
  ];
  const extraRaw = String(process.env.RELAY_ALLOWED_DIRS || '').trim();
  if (extraRaw) {
    extraRaw.split(',').map((s) => s.trim()).filter(Boolean).forEach((dir, idx) => {
      candidates.push({ id: 'custom-' + (idx + 1), label: path.basename(dir) || dir, dir });
    });
  }
  const seen = new Set();
  const roots = [];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c.dir)) {
        const real = fs.realpathSync(c.dir);
        if (!seen.has(real)) {
          seen.add(real);
          roots.push({ id: c.id, label: c.label, path: real });
        }
      }
    } catch {}
  }
  return roots;
}

const ALLOWED_FS_ROOTS = buildAllowedFsRoots();

const PROTECTED_PROCESSES = new Set([
  'system', 'csrss.exe', 'smss.exe', 'svchost.exe', 'services.exe',
  'lsass.exe', 'explorer.exe', 'dwm.exe', 'python.exe', 'python3',
  'jarvis.exe', 'tray.py', 'taskmgr.exe', 'chrome.exe', 'chrome',
  'firefox.exe', 'firefox', 'msedge.exe', 'notepad.exe', 'code.exe',
  'code', 'winword.exe', 'excel.exe', 'powerpnt.exe', 'outlook.exe',
  'node', 'node.exe', 'launchd', 'kernel_task', 'systemd', 'init', 'finder', 'brave'
]);

const BLOCKED_HOTKEYS = new Set([
  'ctrl+alt+del', 'ctrl+alt+delete', 'control+alt+delete',
  'cmd+q', 'command+q', 'alt+f4', 'win+r', 'meta+r', 'cmd+shift+q', 'ctrl+shift+q'
]);

const ALLOWED_APPS = {
  chrome: { darwin: 'Google Chrome', win32: 'chrome.exe', linux: 'google-chrome' },
  brave: { darwin: 'Brave Browser', win32: 'brave.exe', linux: 'brave-browser' },
  firefox: { darwin: 'Firefox', win32: 'firefox.exe', linux: 'firefox' },
  notion: { darwin: 'Notion', win32: 'Notion.exe', linux: 'notion-app' },
  obsidian: { darwin: 'Obsidian', win32: 'Obsidian.exe', linux: 'obsidian' },
  whatsapp: { darwin: 'WhatsApp', win32: 'WhatsApp.exe', linux: 'whatsapp-for-linux' },
  instagram: { darwin: 'https://www.instagram.com', win32: 'https://www.instagram.com', linux: 'https://www.instagram.com' },
  notebooklm: { darwin: 'https://notebooklm.google.com', win32: 'https://notebooklm.google.com', linux: 'https://notebooklm.google.com' },
  vscode: { darwin: 'Visual Studio Code', win32: 'code', linux: 'code' },
  notepad: { darwin: 'TextEdit', win32: 'notepad.exe', linux: 'gedit' },
  calc: { darwin: 'Calculator', win32: 'calc.exe', linux: 'gnome-calculator' },
  explorer: { darwin: 'Finder', win32: 'explorer.exe', linux: 'xdg-open' },
  terminal: { darwin: 'Terminal', win32: 'wt.exe', linux: 'x-terminal-emulator' },
};

function isProtected(name) {
  const clean = String(name || '').trim().toLowerCase();
  if (!clean) return true;
  if (/^\\d+$/.test(clean) && Number(clean) <= 1) return true;
  return PROTECTED_PROCESSES.has(clean);
}

function validateSafeUrl(raw, allowDeepLinks = false) {
  const u = new URL(String(raw || '').trim());
  const p = u.protocol.toLowerCase();
  const allowed = allowDeepLinks
    ? ['http:', 'https:', 'whatsapp:', 'notion:', 'obsidian:', 'vscode:', 'spotify:']
    : ['http:', 'https:'];
  if (!allowed.includes(p)) {
    throw new Error('Blocked URL protocol: ' + p);
  }
  return u.toString();
}

function resolveSafeVaultPath(relPath) {
  const cleanRel = String(relPath || '').replace(/\\\\/g, '/').replace(/^\\/+/, '');
  if (!cleanRel || cleanRel.includes('\\0')) {
    throw new Error('Invalid vault note path.');
  }
  const normalizedName = cleanRel.endsWith('.md') ? cleanRel : cleanRel + '.md';
  const candidate = path.resolve(VAULT_ROOT, normalizedName);
  const parentReal = fs.existsSync(path.dirname(candidate))
    ? fs.realpathSync(path.dirname(candidate))
    : VAULT_ROOT;
  if (parentReal !== VAULT_ROOT && !parentReal.startsWith(VAULT_ROOT + path.sep)) {
    throw new Error('Path escapes RELAY_VAULT_DIR sandbox.');
  }
  if (candidate !== VAULT_ROOT && !candidate.startsWith(VAULT_ROOT + path.sep)) {
    throw new Error('Path traversal blocked.');
  }
  return candidate;
}

function resolveSafeFsPath(rawInput, mustExist = true) {
  const raw = String(rawInput || '').trim();
  const alias = raw.toLowerCase();
  let candidate = raw;
  const matchedAlias = ALLOWED_FS_ROOTS.find((r) => r.id === alias || r.label.toLowerCase() === alias);
  if (matchedAlias) {
    candidate = matchedAlias.path;
  } else if (!raw) {
    candidate = (ALLOWED_FS_ROOTS[0] && ALLOWED_FS_ROOTS[0].path) || VAULT_ROOT;
  } else if (!path.isAbsolute(raw)) {
    const base = (ALLOWED_FS_ROOTS[0] && ALLOWED_FS_ROOTS[0].path) || VAULT_ROOT;
    candidate = path.resolve(base, raw);
  } else {
    candidate = path.resolve(raw);
  }

  let realTarget;
  if (mustExist) {
    if (!fs.existsSync(candidate)) throw new Error('Path does not exist: ' + candidate);
    realTarget = fs.realpathSync(candidate);
  } else {
    const parent = path.dirname(candidate);
    if (!fs.existsSync(parent)) {
      const grand = path.dirname(parent);
      if (!fs.existsSync(grand)) throw new Error('Parent directory does not exist.');
    }
    const existingParent = fs.existsSync(parent) ? fs.realpathSync(parent) : fs.realpathSync(path.dirname(parent));
    realTarget = path.join(existingParent, path.basename(candidate));
  }

  const insideRoot = ALLOWED_FS_ROOTS.some(
    (r) => realTarget === r.path || realTarget.startsWith(r.path + path.sep)
  );
  if (!insideRoot) {
    throw new Error('Blocked: Path is outside allowed desktop roots (Desktop, Documents, Downloads, Vault, or RELAY_ALLOWED_DIRS).');
  }

  const normalizedCheck = realTarget.replace(/\\\\/g, '/').toLowerCase();
  const baseName = path.basename(normalizedCheck);
  if (
    baseName === '.env' ||
    baseName.startsWith('.env.') ||
    baseName === 'id_rsa' ||
    baseName === 'id_ed25519' ||
    baseName === '.npmrc' ||
    baseName === '.pypirc' ||
    baseName === '.netrc' ||
    baseName === '.git-credentials' ||
    /\\.(pem|key|pfx|p12)$/i.test(baseName) ||
    /(service[-_]?account|credentials|secrets).*\\.json$/i.test(baseName) ||
    normalizedCheck.includes('/.ssh/') ||
    normalizedCheck.includes('/.aws/') ||
    normalizedCheck.includes('/.gnupg/')
  ) {
    throw new Error('Blocked by RAY Security Shield: sensitive credential/key file access is prohibited.');
  }

  return realTarget;
}

function listDirectoryEntries(dirPath, limit = 150) {
  const safeDir = resolveSafeFsPath(dirPath, true);
  const rawEntries = fs.readdirSync(safeDir, { withFileTypes: true });
  const items = [];
  for (const entry of rawEntries) {
    if (entry.name === 'node_modules' || entry.name === '$RECYCLE.BIN' || entry.name === 'System Volume Information') continue;
    const full = path.join(safeDir, entry.name);
    try {
      const stat = fs.statSync(full);
      items.push({
        name: entry.name,
        path: full,
        kind: entry.isDirectory() ? 'dir' : 'file',
        sizeBytes: entry.isDirectory() ? 0 : stat.size,
        updatedAt: stat.mtimeMs,
        ext: entry.isDirectory() ? '' : path.extname(entry.name).toLowerCase(),
      });
    } catch {}
    if (items.length >= limit) break;
  }
  items.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
  return { currentPath: safeDir, parentPath: path.dirname(safeDir), items };
}

function readSafeTextFile(filePath, startLine = 1, endLine = 400) {
  const safePath = resolveSafeFsPath(filePath, true);
  const stat = fs.statSync(safePath);
  if (stat.isDirectory()) throw new Error('Target is a directory, not a file.');
  if (stat.size > 300 * 1024) {
    throw new Error('File is too large for inline text read (' + Math.round(stat.size / 1024) + 'KB > 300KB limit).');
  }
  const buf = fs.readFileSync(safePath);
  if (buf.includes(0)) {
    throw new Error('Binary file detected; inline text preview is restricted to UTF-8 text/code files.');
  }
  const allLines = buf.toString('utf8').split(/\\r?\\n/);
  const s = Math.max(1, Number(startLine || 1));
  const e = Math.min(allLines.length, Math.max(s, Number(endLine || s + 399)));
  return {
    path: safePath,
    name: path.basename(safePath),
    sizeBytes: stat.size,
    totalLines: allLines.length,
    startLine: s,
    endLine: e,
    content: allLines.slice(s - 1, e).join('\\n'),
  };
}

function searchSafeFiles(query, dirPath, maxResults = 35) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const startDirs = dirPath ? [resolveSafeFsPath(dirPath, true)] : ALLOWED_FS_ROOTS.map((r) => r.path);
  const results = [];
  const TEXT_EXTS = new Set(['.txt', '.md', '.json', '.ts', '.tsx', '.js', '.jsx', '.py', '.csv', '.log', '.html', '.css', '.yml', '.yaml', '.toml', '.sql']);

  function walk(dir, depth) {
    if (depth > 4 || results.length >= maxResults) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (results.length >= maxResults) break;
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.toLowerCase().includes(q)) {
          results.push({ name: entry.name, path: full, kind: 'dir', matchType: 'name' });
        }
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        try {
          resolveSafeFsPath(full, true);
        } catch {
          continue;
        }
        const nameHit = entry.name.toLowerCase().includes(q);
        let snippet = '';
        const ext = path.extname(entry.name).toLowerCase();
        if (TEXT_EXTS.has(ext)) {
          try {
            const stat = fs.statSync(full);
            if (stat.size <= 160 * 1024) {
              const raw = fs.readFileSync(full, 'utf8');
              const idx = raw.toLowerCase().indexOf(q);
              if (idx >= 0) {
                snippet = raw.slice(Math.max(0, idx - 45), idx + 110).replace(/\\s+/g, ' ').trim();
              }
            }
          } catch {}
        }
        if (nameHit || snippet) {
          results.push({ name: entry.name, path: full, kind: 'file', matchType: snippet ? 'content' : 'name', snippet });
        }
      }
    }
  }

  for (const d of startDirs) {
    walk(d, 0);
  }
  return results;
}

function listVaultFiles(dir = VAULT_ROOT, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    const rel = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) {
      out.push(...listVaultFiles(full, rel));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const stat = fs.statSync(full);
      out.push({ path: rel, content: fs.readFileSync(full, 'utf8').slice(0, 100000), updatedAt: stat.mtimeMs });
    }
  }
  return out.slice(0, 120);
}

function runSafeCommand(cmd, args, cb) {
  execFile(cmd, args, { timeout: 7000 }, (err, stdout, stderr) => {
    cb(err ? (stderr || err.message) : (stdout || 'OK'), !err);
  });
}

function launchUrlSafely(urlStr, cb) {
  const plat = os.platform();
  if (plat === 'darwin') {
    runSafeCommand('open', [urlStr], cb);
  } else if (plat === 'win32') {
    runSafeCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process', urlStr], cb);
  } else {
    runSafeCommand('xdg-open', [urlStr], cb);
  }
}

function launchAppSafely(targetRaw, cb) {
  const key = String(targetRaw || '').trim().toLowerCase();
  const mapped = ALLOWED_APPS[key]?.[os.platform()] || String(targetRaw || '').trim();
  if (!mapped) return cb('Missing application name', false);

  if (mapped.startsWith('http://') || mapped.startsWith('https://') || /^(whatsapp|notion|obsidian|vscode|spotify):\\/\\//i.test(mapped)) {
    try {
      const safeUrl = validateSafeUrl(mapped, true);
      return launchUrlSafely(safeUrl, cb);
    } catch (err) {
      return cb(err.message, false);
    }
  }

  if (!/^[a-zA-Z0-9 ._-]{1,64}$/.test(mapped)) {
    return cb('Blocked application name containing unsafe characters.', false);
  }

  const plat = os.platform();
  if (plat === 'darwin') {
    runSafeCommand('open', ['-a', mapped], cb);
  } else if (plat === 'win32') {
    runSafeCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process', mapped], cb);
  } else {
    runSafeCommand(mapped, [], cb);
  }
}

function captureScreenPng(cb) {
  const plat = os.platform();
  const tmpFile = path.join(os.tmpdir(), 'jarvis-screen-' + Date.now() + '.png');
  const finish = (errMsg, ok) => {
    try {
      if (ok && fs.existsSync(tmpFile)) {
        const b64 = fs.readFileSync(tmpFile).toString('base64');
        fs.unlinkSync(tmpFile);
        return cb({ ok: true, dataUrl: 'data:image/png;base64,' + b64, mimeType: 'image/png' });
      }
    } catch (e) {
      return cb({ ok: false, error: e.message });
    }
    try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch {}
    cb({ ok: false, error: errMsg || 'Screen capture failed' });
  };

  if (plat === 'darwin') {
    runSafeCommand('screencapture', ['-x', tmpFile], (msg, ok) => finish(msg, ok));
  } else if (plat === 'win32') {
    const ps = \`Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp=New-Object System.Drawing.Bitmap($b.Width,$b.Height); $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $bmp.Save('\${tmpFile.replace(/'/g, "''")}',[System.Drawing.Imaging.ImageFormat]::Png);\`;
    runSafeCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], (msg, ok) => finish(msg, ok));
  } else {
    runSafeCommand('scrot', [tmpFile], (msg, ok) => {
      if (ok) return finish(msg, ok);
      runSafeCommand('gnome-screenshot', ['-f', tmpFile], (msg2, ok2) => finish(msg2, ok2));
    });
  }
}

function executeGuiControl(payload, cb) {
  const action = String(payload.action || '').toLowerCase();
  const plat = os.platform();

  if (action === 'press_hotkey') {
    const combo = String(payload.keys || '').toLowerCase().replace(/\\s+/g, '');
    if (BLOCKED_HOTKEYS.has(combo)) {
      return cb({ ok: false, error: 'Blocked hotkey: ' + combo });
    }
  }

  if (plat === 'darwin') {
    if (action === 'type_text') {
      const safe = String(payload.text || '').replace(/[\\\\"]/g, '');
      return runSafeCommand('osascript', ['-e', \`tell application "System Events" to keystroke "\${safe}"\`], (m, ok) => cb({ ok, data: m }));
    }
    if (action === 'focus_window') {
      const appName = String(payload.target || '').replace(/[^a-zA-Z0-9 ._-]/g, '');
      return runSafeCommand('osascript', ['-e', \`tell application "\${appName}" to activate\`], (m, ok) => cb({ ok, data: m }));
    }
    if (action === 'press_hotkey') {
      const parts = String(payload.keys || '').split('+');
      const key = parts.pop() || '';
      const mods = parts.map((p) => (p === 'cmd' || p === 'command' ? 'command down' : p === 'shift' ? 'shift down' : p === 'alt' ? 'option down' : 'control down'));
      const usingClause = mods.length ? \` using {\${mods.join(', ')}}\` : '';
      return runSafeCommand('osascript', ['-e', \`tell application "System Events" to keystroke "\${key}"\${usingClause}\`], (m, ok) => cb({ ok, data: m }));
    }
    if (action === 'mouse_click' || action === 'mouse_move') {
      const x = Math.round(Number(payload.x || 0));
      const y = Math.round(Number(payload.y || 0));
      return runSafeCommand('osascript', ['-e', \`tell application "System Events" to click at {\${x}, \${y}}\`], (m, ok) => cb({ ok, data: m }));
    }
    return cb({ ok: true, data: 'Executed GUI action ' + action });
  }

  if (plat === 'win32') {
    if (action === 'mouse_move' || action === 'mouse_click') {
      const x = Math.round(Number(payload.x || 0));
      const y = Math.round(Number(payload.y || 0));
      const ps = \`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(\${x}, \${y});\`;
      return runSafeCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], (m, ok) => cb({ ok, data: m }));
    }
    if (action === 'type_text') {
      const safe = String(payload.text || '').replace(/[{}+^%~()\\[\\]']/g, '');
      const ps = \`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('\${safe}');\`;
      return runSafeCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], (m, ok) => cb({ ok, data: m }));
    }
    return cb({ ok: true, data: 'Executed Windows GUI action ' + action });
  }

  if (action === 'mouse_move') {
    return runSafeCommand('xdotool', ['mousemove', String(Number(payload.x || 0)), String(Number(payload.y || 0))], (m, ok) => cb({ ok, data: m }));
  }
  if (action === 'mouse_click') {
    return runSafeCommand('xdotool', ['mousemove', String(Number(payload.x || 0)), String(Number(payload.y || 0)), 'click', payload.button === 'right' ? '3' : '1'], (m, ok) => cb({ ok, data: m }));
  }
  if (action === 'type_text') {
    return runSafeCommand('xdotool', ['type', '--clearmodifiers', String(payload.text || '')], (m, ok) => cb({ ok, data: m }));
  }
  return cb({ ok: true, data: 'Executed Linux GUI action ' + action });
}

function getActiveWindowTitle(cb) {
  const plat = os.platform();
  if (plat === 'win32') {
    const ps = \`Add-Type 'using System; using System.Runtime.InteropServices; public class WinAPI { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count); }'; $h=[WinAPI]::GetForegroundWindow(); $sb=New-Object System.Text.StringBuilder 256; [void][WinAPI]::GetWindowText($h,$sb,256); $sb.ToString()\`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 3000 }, (err, stdout) => {
      cb(err ? '' : String(stdout || '').trim());
    });
  } else if (plat === 'darwin') {
    execFile('osascript', ['-e', 'tell application "System Events" to get name of first application process whose frontmost is true'], { timeout: 2500 }, (err, stdout) => {
      cb(err ? '' : String(stdout || '').trim());
    });
  } else {
    execFile('xdotool', ['getactivewindow', 'getwindowname'], { timeout: 2500 }, (err, stdout) => {
      cb(err ? '' : String(stdout || '').trim());
    });
  }
}

function sampleTopProcesses(cb) {
  const plat = os.platform();
  if (plat === 'darwin' || plat === 'linux') {
    execFile('ps', ['-axo', 'pid,pcpu,pmem,comm'], { timeout: 3000 }, (err, stdout) => {
      if (err || !stdout) return cb([]);
      const rows = stdout.trim().split('\\n').slice(1)
        .map((line) => {
          const m = line.trim().match(/^(\\d+)\\s+([\\d.]+)\\s+([\\d.]+)\\s+(.+)$/);
          if (!m) return null;
          return {
            pid: Number(m[1]),
            cpuPercent: Number(m[2]),
            memoryPercent: Number(m[3]),
            name: m[4].split('/').pop() || m[4],
          };
        })
        .filter(Boolean)
        .sort((a, b) => b.cpuPercent - a.cpuPercent)
        .slice(0, 8);
      cb(rows);
    });
  } else if (plat === 'win32') {
    const ps = 'Get-Process | Sort-Object CPU -Descending | Select-Object -First 8 Id,ProcessName,@{N="MemPct";E={[math]::Round(($_.WorkingSet64/1MB),1)}},@{N="CpuSec";E={[math]::Round(($_.CPU),1)}} | ConvertTo-Json -Compress';
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 4000 }, (err, stdout) => {
      if (err || !stdout) return cb([]);
      try {
        const parsed = JSON.parse(stdout.trim());
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        const totalMb = Math.max(1, os.totalmem() / 1024 / 1024);
        cb(arr.map((p) => ({
          pid: Number(p.Id || 0),
          name: String(p.ProcessName || 'process'),
          cpuPercent: Math.min(99, Math.round(Number(p.CpuSec || 0) % 100)),
          memoryPercent: Number(((Number(p.MemPct || 0) / totalMb) * 100).toFixed(1)),
        })));
      } catch {
        cb([]);
      }
    });
  } else {
    cb([]);
  }
}

function getTelemetry(topProcesses = [], activeWindow = '') {
  const cpus = os.cpus();
  const load = os.loadavg()[0] || 0;
  const cpuPercent = Math.min(100, Math.round((load / Math.max(1, cpus.length)) * 100));
  const totalMb = Math.round(os.totalmem() / 1024 / 1024);
  const freeMb = Math.round(os.freemem() / 1024 / 1024);
  const memoryPercent = totalMb > 0 ? Math.round(((totalMb - freeMb) / totalMb) * 100) : 0;
  return {
    platform: os.platform() + ' ' + os.release(),
    cpuUsage: load.toFixed(2) + ' load (' + cpus.length + ' cores)',
    cpuPercent,
    memoryPercent,
    memoryFreeMb: freeMb,
    memoryTotalMb: totalMb,
    uptimeMinutes: Math.round(os.uptime() / 60),
    activeWindow: activeWindow || undefined,
    topProcesses,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    localTime: new Date().toLocaleTimeString(),
  };
}

async function runBridgeAction(action, reqData) {
  try {
    if (action === 'ollama_tags') {
      const targetBase = new URL(reqData.ollamaUrl || OLLAMA_HOST);
      if (!['127.0.0.1', 'localhost'].includes(targetBase.hostname)) {
        return { ok: false, data: null, error: 'Ollama bridge proxy only allows 127.0.0.1/localhost.' };
      }
      const safeOrigin = targetBase.origin.replace('://localhost', '://127.0.0.1');
      try {
        const r = await fetch(safeOrigin + '/api/tags', { signal: AbortSignal.timeout(6000) });
        const j = await r.json();
        return { ok: r.ok, data: j, error: r.ok ? undefined : 'Ollama returned ' + r.status };
      } catch {
        return { ok: false, data: null, error: 'Cannot reach local Ollama at ' + safeOrigin + ' — run "ollama serve" first.' };
      }
    }
    if (action === 'ollama_chat') {
      const targetBase = new URL(reqData.ollamaUrl || OLLAMA_HOST);
      if (!['127.0.0.1', 'localhost'].includes(targetBase.hostname)) {
        return { ok: false, data: null, error: 'Ollama bridge proxy only allows 127.0.0.1/localhost.' };
      }
      const safeOrigin = targetBase.origin.replace('://localhost', '://127.0.0.1');
      try {
        const r = await fetch(safeOrigin + '/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(reqData.body || {}),
          signal: AbortSignal.timeout(90000),
        });
        const j = await r.json();
        return { ok: r.ok, data: j, error: r.ok ? undefined : 'Ollama returned ' + r.status };
      } catch {
        return { ok: false, data: null, error: 'Local Ollama chat failed at ' + safeOrigin + ' — ensure "ollama serve" is running.' };
      }
    }
    if (action === 'fs_list_roots') {
      return { ok: true, data: { platform: os.platform(), hostname: os.hostname(), roots: ALLOWED_FS_ROOTS } };
    }
    if (action === 'fs_list_dir') {
      return { ok: true, data: listDirectoryEntries(reqData.dirPath || reqData.path || '', reqData.limit) };
    }
    if (action === 'fs_read_file') {
      return { ok: true, data: readSafeTextFile(reqData.filePath || reqData.path || '', reqData.startLine, reqData.endLine) };
    }
    if (action === 'fs_search_files') {
      return { ok: true, data: { query: reqData.query || '', results: searchSafeFiles(reqData.query, reqData.dirPath) } };
    }
    if (action === 'fs_write_file') {
      const target = resolveSafeFsPath(reqData.filePath || reqData.path || '', false);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, String(reqData.content || ''), 'utf8');
      return { ok: true, data: { path: target, saved: true, bytes: Buffer.byteLength(String(reqData.content || ''), 'utf8') } };
    }
    if (action === 'active_window') {
      return await new Promise((resolve) =>
        getActiveWindowTitle((title) =>
          sampleTopProcesses((procs) => resolve({ ok: true, data: { activeWindow: title || 'Desktop / Unknown', telemetry: getTelemetry(procs, title) } }))
        )
      );
    }
    if (action === 'vault_list') {
      return { ok: true, data: { vaultDir: VAULT_ROOT, notes: listVaultFiles() } };
    }
    if (action === 'vault_read') {
      const filePath = resolveSafeVaultPath(reqData.path);
      if (!fs.existsSync(filePath)) return { ok: false, data: null, error: 'Note not found in vault' };
      return { ok: true, data: { path: reqData.path, content: fs.readFileSync(filePath, 'utf8') } };
    }
    if (action === 'vault_write') {
      const filePath = resolveSafeVaultPath(reqData.path);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, String(reqData.content || ''), 'utf8');
      return { ok: true, data: { path: reqData.path, saved: true } };
    }
    if (action === 'vault_delete') {
      const filePath = resolveSafeVaultPath(reqData.path);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      return { ok: true, data: { path: reqData.path, deleted: true } };
    }
    if (action === 'screen_capture') {
      return await new Promise((resolve) => captureScreenPng((out) => resolve({ ok: out.ok, data: out, error: out.error })));
    }
    if (action === 'screen_control') {
      return await new Promise((resolve) => executeGuiControl(reqData.payload || {}, (out) => resolve({ ok: out.ok, data: out.data, error: out.error })));
    }
    if (action === 'open_app' || action === 'open_application') {
      const requested = reqData.target || reqData.application || reqData.app_name || '';
      return await new Promise((resolve) => launchAppSafely(requested, (out, ok) => resolve({ ok, data: { message: 'Launch ' + requested + ': ' + out }, error: ok ? undefined : out })));
    }
    if (action === 'open_url') {
      const safeUrl = validateSafeUrl(reqData.url || '', true);
      return await new Promise((resolve) => launchUrlSafely(safeUrl, (out, ok) => resolve({ ok, data: { message: 'Opened URL: ' + out }, error: ok ? undefined : out })));
    }
    if (action === 'system_info') {
      return await new Promise((resolve) =>
        getActiveWindowTitle((title) =>
          sampleTopProcesses((procs) => resolve({ ok: true, data: getTelemetry(procs, title) }))
        )
      );
    }
    return { ok: false, data: null, error: 'Unknown proxy action: ' + action };
  } catch (err) {
    return { ok: false, data: null, error: err instanceof Error ? err.message : String(err) };
  }
}

function startLocalDirectBridge() {
  const srv = http.createServer(async (req, res) => {
    const reqOrigin = req.headers.origin || '*';
    res.setHeader('Access-Control-Allow-Origin', reqOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Relay-Room-Token');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const urlObj = new URL(req.url || '/', 'http://127.0.0.1:' + LOCAL_PORT);
    const remoteAddr = String(req.socket?.remoteAddress || '');
    const isLoopback = !remoteAddr || remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1';

    if (req.method === 'GET' && urlObj.pathname === '/status' && isLoopback) {
      await ensureOllamaRunning(false);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          bridgeVersion: BRIDGE_VERSION,
          roomId: ROOM_ID,
          platform: os.platform(),
          deviceName: DEVICE_NAME,
          ollamaRunning: ollamaState.running,
          ollamaModels: ollamaState.models,
          startupInstalled: isStartupInstalled(),
        })
      );
      return;
    }

    if (req.method === 'GET' && urlObj.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          service: 'RAY Desktop OS Bridge',
          bridgeVersion: BRIDGE_VERSION,
          roomId: ROOM_ID,
          localPort: LOCAL_PORT,
          ollamaHost: OLLAMA_HOST,
          ollamaRunning: ollamaState.running,
          startupInstalled: isStartupInstalled(),
          message: 'RAY Local Direct Bridge is active. Return to your RAY browser tab.',
        })
      );
      return;
    }

    const tokenHeader = String(req.headers['x-relay-room-token'] || '');
    if (tokenHeader !== ROOM_TOKEN) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: false,
          code: 'TOKEN_MISMATCH',
          roomId: ROOM_ID,
          error:
            'Invalid X-Relay-Room-Token. Run "node relay-bridge-' +
            ROOM_ID.toLowerCase() +
            '.mjs --set-token <TOKEN>" or re-download from Pair Device -> Desktop OS Bridge.',
        })
      );
      return;
    }

    if (req.method === 'GET' && urlObj.pathname === '/health') {
      await pingOllamaOnce();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          bridgeVersion: BRIDGE_VERSION,
          deviceName: DEVICE_NAME,
          roomId: ROOM_ID,
          platform: os.platform(),
          ollamaHost: OLLAMA_HOST,
          ollamaRunning: ollamaState.running,
          ollamaModels: ollamaState.models,
          startupInstalled: isStartupInstalled(),
          localPort: LOCAL_PORT,
        })
      );
      return;
    }

    if (req.method === 'GET' && urlObj.pathname === '/ollama/tags') {
      await ensureOllamaRunning(true);
      const out = await runBridgeAction('ollama_tags', { ollamaUrl: urlObj.searchParams.get('url') || OLLAMA_HOST });
      const models = Array.isArray(out.data?.models) ? out.data.models.map((m) => m.name).filter(Boolean) : [];
      res.writeHead(out.ok ? 200 : 502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: out.ok, models, raw: out.data, error: out.error }));
      return;
    }

    if (req.method === 'POST' && (urlObj.pathname === '/ollama/chat' || urlObj.pathname === '/command')) {
      const chunks = [];
      let total = 0;
      for await (const chunk of req) {
        total += chunk.length;
        if (total > 12 * 1024 * 1024) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Payload too large' }));
          return;
        }
        chunks.push(chunk);
      }
      let parsed = {};
      try {
        parsed = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON body' }));
        return;
      }

      if (urlObj.pathname === '/ollama/chat') {
        const out = await runBridgeAction('ollama_chat', { ollamaUrl: parsed.ollamaUrl || OLLAMA_HOST, body: parsed.body || parsed });
        res.writeHead(out.ok ? 200 : 502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
        return;
      }

      const out = await runBridgeAction(String(parsed.action || ''), parsed);
      res.writeHead(out.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Not found' }));
  });

  srv.listen(LOCAL_PORT, '127.0.0.1', () => {
    console.log('[RAY Local Direct Bridge] Ready on http://127.0.0.1:' + LOCAL_PORT + ' (Ollama + OS control)');
  });
  srv.on('error', (err) => {
    console.warn('[RAY Local Direct Bridge] Port ' + LOCAL_PORT + ' notice:', err.message);
  });
}

let loggedProxyRedirect = false;

function connect() {
  const url = WS_URL + '?room=' + encodeURIComponent(ROOM_ID) + '&token=' + encodeURIComponent(ROOM_TOKEN);
  const ws = new WebSocket(url);

  ws.on('unexpected-response', (_req, response) => {
    if (!loggedProxyRedirect) {
      loggedProxyRedirect = true;
      console.log('[RAY Bridge] Cloud WS paused (HTTP ' + response.statusCode + ' preview auth). Local Direct Bridge on http://127.0.0.1:' + LOCAL_PORT + ' is active — keep this window open!');
    }
    try { ws.terminate(); } catch {}
  });

  ws.on('error', (err) => {
    if (!loggedProxyRedirect) {
      console.warn('[RAY Bridge] Cloud WS notice:', err.message);
    }
  });

  ws.on('open', () => {
    loggedProxyRedirect = false;
    console.log('[RAY Bridge] Connected to room', ROOM_ID, '| Vault:', VAULT_ROOT);
    sampleTopProcesses((procs) => {
      ws.send(JSON.stringify({
        event: 'device:register',
        data: {
          id: DEVICE_ID,
          name: DEVICE_NAME,
          type: 'bridge',
          os: os.type() + ' ' + os.arch(),
          browser: 'Node.js ' + process.version,
          capabilities: [
            'notify', 'clipboard', 'open_url', 'speak', 'timers',
            'os-bridge', 'open_application', 'close_application', 'kill_process',
            'adjust_volume', 'clean_slate', 'optimize_system', 'obsidian-vault', 'ollama-proxy', 'screen-control', 'fs-sandbox'
          ],
          telemetry: getTelemetry(procs),
        },
      }));
    });
  });

  const interval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      getActiveWindowTitle((title) => {
        sampleTopProcesses((procs) => {
          ws.send(JSON.stringify({ event: 'device:telemetry', data: { id: DEVICE_ID, telemetry: getTelemetry(procs, title) } }));
        });
      });
    }
  }, 10000);

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.event === 'bridge:proxy_request') {
        const reqData = msg.data || {};
        const requestId = reqData.requestId;
        const out = await runBridgeAction(reqData.action, reqData);
        ws.send(JSON.stringify({ event: 'bridge:proxy_response', data: { requestId, ok: out.ok, data: out.data, error: out.error } }));
        return;
      }

      if (msg.event !== 'command:execute') return;
      const cmd = msg.data;
      const ack = (status, message, data) => {
        ws.send(JSON.stringify({ event: 'command:ack', data: { commandId: cmd.id, deviceId: DEVICE_ID, status, message, data } }));
      };

      const platform = os.platform();
      if (cmd.type === 'open_url' && cmd.payload?.url) {
        try {
          const safeUrl = validateSafeUrl(cmd.payload.url, true);
          launchUrlSafely(safeUrl, (out, ok) => ack(ok ? 'completed' : 'failed', 'Opened URL in OS browser: ' + out));
        } catch (err) {
          ack('failed', err.message);
        }
      } else if (cmd.type === 'notify') {
        console.log('[RAY Notification]', cmd.payload?.title, '-', cmd.payload?.message);
        if (platform === 'darwin') {
          runSafeCommand('osascript', ['-e', \`display notification \${JSON.stringify(String(cmd.payload?.message || ''))} with title \${JSON.stringify(String(cmd.payload?.title || 'RAY'))}\`], () => ack('completed', 'Displayed macOS notification'));
        } else {
          ack('completed', 'Logged OS notification');
        }
      } else if (cmd.type === 'clipboard' && cmd.payload?.content) {
        if (platform === 'darwin') {
          const child = execFile('pbcopy', [], () => ack('completed', 'Copied to macOS clipboard'));
          child.stdin?.write(String(cmd.payload.content));
          child.stdin?.end();
        } else {
          ack('completed', 'Received clipboard payload in bridge');
        }
      } else if (cmd.type === 'refresh_telemetry') {
        sampleTopProcesses((procs) => {
          const t = getTelemetry(procs);
          ws.send(JSON.stringify({ event: 'device:telemetry', data: { id: DEVICE_ID, telemetry: t } }));
          ack('completed', 'OS telemetry refreshed', t);
        });
      } else if (cmd.type === 'bridge_command') {
        const action = String(cmd.payload?.action || '');
        if (action === 'system_info') {
          sampleTopProcesses((procs) => ack('completed', 'Collected live OS stats', getTelemetry(procs)));
        } else if (action === 'open_app' || action === 'open_application') {
          const requested = cmd.payload?.target || cmd.payload?.application || cmd.payload?.app_name || '';
          launchAppSafely(requested, (out, ok) => ack(ok ? 'completed' : 'failed', 'Launch ' + requested + ': ' + out));
        } else if (action === 'close_application' || action === 'kill_process') {
          const target = String(cmd.payload?.target || cmd.payload?.application || '').trim();
          if (!target) return ack('failed', 'No process or application specified.');
          if (isProtected(target)) {
            return ack('failed', 'Blocked by Protected Process Safelist: ' + target + ' cannot be terminated.');
          }
          if (!/^\\d+$/.test(target) && !/^[a-zA-Z0-9._-]{1,64}$/.test(target)) {
            return ack('failed', 'Blocked invalid process identifier.');
          }
          if (platform === 'darwin' || platform === 'linux') {
            const flag = /^\\d+$/.test(target) ? [target] : ['-x', target];
            const bin = /^\\d+$/.test(target) ? 'kill' : 'pkill';
            runSafeCommand(bin, flag, (out, ok) => ack(ok ? 'completed' : 'failed', 'Process action on ' + target + ': ' + out));
          } else if (platform === 'win32') {
            const args = /^\\d+$/.test(target) ? ['/PID', target, '/F'] : ['/IM', target, '/F'];
            runSafeCommand('taskkill', args, (out, ok) => ack(ok ? 'completed' : 'failed', 'Taskkill ' + target + ': ' + out));
          }
        } else if (action === 'adjust_volume') {
          const level = Math.max(0, Math.min(100, Number(cmd.payload?.level ?? 50)));
          if (platform === 'darwin') {
            runSafeCommand('osascript', ['-e', 'set volume output volume ' + level], () => ack('completed', 'System volume set to ' + level + '%'));
          } else {
            ack('completed', 'Volume target acknowledged: ' + level + '%');
          }
        } else if (action === 'clean_slate' || action === 'optimize_system') {
          sampleTopProcesses((procs) => {
            const nonProtected = procs.filter((p) => !isProtected(p.name));
            ack('completed', 'Safelist-verified scan complete (' + nonProtected.length + ' non-protected processes inspected; critical OS/browser processes untouched).', { telemetry: getTelemetry(procs) });
          });
        } else {
          ack('completed', 'Bridge processed action: ' + action);
        }
      } else {
        ack('acknowledged', 'Bridge received ' + cmd.type);
      }
    } catch (e) {
      console.error('Bridge error:', e);
    }
  });

  ws.on('close', () => {
    clearInterval(interval);
    if (!loggedProxyRedirect) {
      console.log('[RAY Bridge] Disconnected, retrying in 5s...');
    }
    setTimeout(connect, loggedProxyRedirect ? 30000 : 5000);
  });
}

void ensureOllamaRunning(true);
setInterval(() => {
  void ensureOllamaRunning(true);
}, 20000);

startLocalDirectBridge();
connect();
`;
}
