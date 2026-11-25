/**
 * WHATSAPP (free) — RAY as a linked device on Ray's own WhatsApp, like WhatsApp Web, using the open
 * source Baileys library (github.com/WhiskeySockets/Baileys, MIT). No Business API, no fees:
 *   read every chat (incl. groups) · send text, photos, videos, voice notes, documents ·
 *   download photos/videos/voice notes people send · new messages flow into RAY's inbox & Autopilot.
 * Runs on the RAY server, so it works while the PC and phone app are off. The login keys are stored
 * encrypted (RELAY_MASTER_SECRET). Sending always needs Ray's command (and approval unless
 * RAY_AUTO_SEND_MESSAGES=true). Unofficial: WhatsApp may restrict accounts that act like spam, so RAY
 * only sends what Ray asks for.
 */
import type { Express } from 'express';
import { Type } from '@google/genai';
import type { FunctionDeclaration } from '@google/genai';
import { createConfirmationRequest } from './capabilities.ts';
import { broadcastHudSound, broadcastRoomEvent, listRoomIds, normalizeRoomId, recordIncomingMessage } from './hub.ts';
import { loadJson, saveNow, scheduleSave } from './persistence.ts';
import { seal, unseal } from './accounts.ts';
import { scoreName } from './nameMatch.ts';
import { resolveContact } from './contactFinder.ts';
import type { ConfirmationRequest } from '../src/types/relay.ts';

type Baileys = typeof import('baileys');
let lib: Baileys | null = null;
async function baileys(): Promise<Baileys> {
  if (!lib) lib = await import('baileys');
  return lib;
}

const silent = {
  level: 'silent',
  child() {
    return silent;
  },
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
};

interface StoredMsg {
  id: string;
  chat: string;
  from: string;
  fromMe: boolean;
  text: string;
  kind: string;
  at: number;
  raw?: unknown; // kept for media download
}
interface Session {
  roomId: string;
  sock: ReturnType<Baileys['makeWASocket']> | null;
  status: 'off' | 'linking' | 'connected' | 'reconnecting';
  qr: string | null;
  pairingCode: string | null;
  me: { id: string; name?: string } | null;
  names: Map<string, string>; // jid → display name
  pn: Map<string, string>; // @lid jid → phone-number jid (WhatsApp hides numbers behind LIDs)
  chats: Map<string, { name: string; lastAt: number; unread: number }>;
  msgs: Map<string, StoredMsg[]>; // jid → recent messages (memory only)
  wanted: boolean;
  error: string | null;
  // The login being built: reused across WhatsApp's "restart required" reconnect right after pairing.
  auth: Awaited<ReturnType<typeof kvAuthState>> | null;
}
const sessions = new Map<string, Session>();

function session(roomId: string): Session {
  let s = sessions.get(roomId);
  if (!s) {
    s = { roomId, sock: null, status: 'off', qr: null, pairingCode: null, me: null, names: new Map(), pn: new Map(), chats: new Map(), msgs: new Map(), wanted: false, error: null, auth: null };
    sessions.set(roomId, s);
  }
  return s;
}
function publicStatus(s: Session) {
  return { status: s.status, qr: s.qr, pairingCode: s.pairingCode, me: s.me, chats: s.chats.size, error: s.error };
}
function emit(s: Session) {
  broadcastRoomEvent(s.roomId, 'whatsapp:status', publicStatus(s));
}

// --- auth state in RAY storage (sealed) -----------------------------------------------------------
async function kvAuthState(roomId: string) {
  const { initAuthCreds, BufferJSON, proto } = await baileys();
  const raw = (await loadJson<Record<string, unknown>>(`wa-auth-${roomId}`).catch(() => null)) as { blob?: string } | null;
  let data: { creds?: unknown; keys?: Record<string, Record<string, unknown>> } = {};
  if (raw?.blob) {
    const plain = unseal(raw.blob);
    if (plain) data = JSON.parse(plain, BufferJSON.reviver);
  }
  const creds = (data.creds as ReturnType<typeof initAuthCreds>) || initAuthCreds();
  const keys: Record<string, Record<string, unknown>> = data.keys || {};
  const value = () => ({ blob: seal(JSON.stringify({ creds, keys }, BufferJSON.replacer)) });
  const save = () => scheduleSave(`wa-auth-${roomId}`, value, 1500);
  return {
    saveNow: () => saveNow(`wa-auth-${roomId}`, value),
    state: {
      creds,
      keys: {
        get: async (type: string, ids: string[]) => {
          const out: Record<string, unknown> = {};
          for (const id of ids) {
            let v = keys[type]?.[id];
            if (v && type === 'app-state-sync-key') v = proto.Message.AppStateSyncKeyData.fromObject(v as object);
            if (v) out[id] = v;
          }
          return out;
        },
        set: async (d: Record<string, Record<string, unknown>>) => {
          for (const type of Object.keys(d)) {
            keys[type] ||= {};
            for (const id of Object.keys(d[type])) {
              const v = d[type][id];
              if (v) keys[type][id] = v;
              else delete keys[type][id];
            }
          }
          save();
        },
      },
    },
    saveCreds: save,
  };
}
async function hasSavedLogin(roomId: string) {
  const raw = (await loadJson<Record<string, unknown>>(`wa-auth-${roomId}`).catch(() => null)) as { blob?: string } | null;
  return Boolean(raw?.blob);
}

// --- messages --------------------------------------------------------------------------------------
function textOf(m: Record<string, unknown> | null | undefined): { text: string; kind: string } {
  if (!m) return { text: '', kind: 'unknown' };
  const g = (k: string) => m[k] as Record<string, unknown> | undefined;
  if (typeof m.conversation === 'string') return { text: m.conversation, kind: 'text' };
  if (g('extendedTextMessage')) return { text: String(g('extendedTextMessage')!.text || ''), kind: 'text' };
  for (const k of ['imageMessage', 'videoMessage', 'documentMessage', 'audioMessage', 'stickerMessage']) {
    const x = g(k);
    if (x) return { text: String(x.caption || x.fileName || '') || `[${k.replace('Message', '')}]`, kind: k.replace('Message', '') };
  }
  for (const k of ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'documentWithCaptionMessage']) {
    const inner = g(k)?.message as Record<string, unknown> | undefined;
    if (inner) return textOf(inner);
  }
  if (g('locationMessage')) return { text: '[location]', kind: 'location' };
  if (g('contactMessage')) return { text: `[contact ${String(g('contactMessage')!.displayName || '')}]`, kind: 'contact' };
  return { text: '', kind: 'other' };
}

/** Saves a contact's name under every id WhatsApp gives it (phone-number jid and LID). */
function learnContact(s: Session, c: { id?: string; lid?: string; phoneNumber?: string; name?: string; notify?: string; verifiedName?: string }) {
  if (!c?.id) return;
  const pn = c.phoneNumber || (c.id.endsWith('@s.whatsapp.net') ? c.id : '');
  const lid = c.lid || (c.id.endsWith('@lid') ? c.id : '');
  if (lid && pn) s.pn.set(lid, pn);
  // Ray's own saved name wins over the name they set for themselves.
  const name = c.name || (s.names.has(c.id) ? '' : c.notify || c.verifiedName);
  if (!name) return;
  for (const id of [c.id, pn, lid]) if (id) s.names.set(id, String(name));
}

/** Phone-number jid for a chat id, resolving hidden-number LIDs when WhatsApp told us the mapping. */
async function phoneJid(s: Session, jid: string): Promise<string | null> {
  if (jid.endsWith('@s.whatsapp.net')) return jid;
  if (!jid.endsWith('@lid')) return null;
  const known = s.pn.get(jid);
  if (known) return known;
  try {
    const repo = (s.sock as unknown as { signalRepository?: { lidMapping?: { getPNForLID(l: string): Promise<string | null> } } } | null)?.signalRepository;
    const pn = await repo?.lidMapping?.getPNForLID(jid);
    if (pn) {
      const full = pn.includes('@') ? pn.replace(/:\d+@/, '@') : `${pn}@s.whatsapp.net`;
      s.pn.set(jid, full);
      return full;
    }
  } catch {
    // mapping not known yet
  }
  return null;
}

function nameFor(s: Session, jid: string): string {
  const known = s.names.get(jid) || s.chats.get(jid)?.name;
  if (known && !/^\+?\d+$/.test(known)) return known;
  if (jid.endsWith('@g.us')) return 'a WhatsApp group';
  return known || jid.replace(/@.*/, '').replace(/^(\d+)$/, '+$1');
}
const askedGroups = new Set<string>();
function learnGroupName(s: Session, jid: string) {
  if (!jid.endsWith('@g.us') || s.names.has(jid) || askedGroups.has(jid) || !s.sock) return;
  askedGroups.add(jid);
  const sock = s.sock;
  void Promise.resolve()
    .then(() => sock.groupMetadata(jid))
    .then((md) => {
      if (md?.subject) {
        s.names.set(jid, md.subject);
        const c = s.chats.get(jid);
        if (c) c.name = md.subject;
      }
    })
    .catch(() => undefined);
}

function storeMessage(s: Session, wm: { key?: { id?: string | null; remoteJid?: string | null; fromMe?: boolean | null; participant?: string | null }; message?: unknown; messageTimestamp?: unknown; pushName?: string | null }, live: boolean) {
  const chat = wm.key?.remoteJid;
  if (!chat || chat === 'status@broadcast') return;
  const { text, kind } = textOf(wm.message as Record<string, unknown>);
  if (!text) return;
  const senderJid = wm.key?.participant || chat;
  learnGroupName(s, chat);
  if (wm.pushName && !wm.key?.fromMe) s.names.set(senderJid, wm.pushName);
  const at = Number(wm.messageTimestamp || 0) * 1000 || Date.now();
  const msg: StoredMsg = { id: String(wm.key?.id || ''), chat, from: wm.key?.fromMe ? 'Ray' : nameFor(s, senderJid), fromMe: Boolean(wm.key?.fromMe), text: text.slice(0, 4000), kind, at, raw: kind !== 'text' ? wm : undefined };
  const list = s.msgs.get(chat) || [];
  if (list.some((x) => x.id === msg.id)) return;
  list.push(msg);
  list.sort((a, b) => a.at - b.at);
  s.msgs.set(chat, list.slice(-60));
  const c = s.chats.get(chat) || { name: nameFor(s, chat), lastAt: 0, unread: 0 };
  c.lastAt = Math.max(c.lastAt, at);
  if (live && !msg.fromMe) c.unread++;
  s.chats.set(chat, c);
  if (live && !msg.fromMe) {
    const group = chat.endsWith('@g.us');
    recordIncomingMessage(s.roomId, { app: 'whatsapp', from: group ? `${msg.from} in ${nameFor(s, chat)}` : msg.from, text: msg.text, receivedAt: at, viaDevice: 'WhatsApp (linked)' });
  }
}

// --- connection ------------------------------------------------------------------------------------
export async function linkWhatsApp(roomId: string, opts: { phone?: string } = {}): Promise<ReturnType<typeof publicStatus>> {
  const s = session(roomId);
  s.wanted = true;
  if (s.sock && s.status === 'connected') return publicStatus(s);
  if (s.sock && s.status === 'linking') {
    // Asking again while a code is waiting means "give me a fresh code": drop the old attempt.
    if (!opts.phone && s.qr) return publicStatus(s);
    const old = s.sock;
    s.sock = null;
    if (!s.auth?.state.creds.registered) s.auth = null;
    try {
      old.end(undefined);
    } catch {
      // already closed
    }
  }
  const { makeWASocket, makeCacheableSignalKeyStore, Browsers, DisconnectReason, fetchLatestBaileysVersion } = await baileys();
  // Reuse the login in memory: right after pairing WhatsApp asks for a restart (code 515), and the
  // new keys may not be in storage yet — reloading from storage would throw the pairing away.
  s.auth ||= await kvAuthState(roomId);
  const { state, saveCreds, saveNow: saveLoginNow } = s.auth;
  let version: [number, number, number] | undefined;
  try {
    version = (await fetchLatestBaileysVersion()).version as [number, number, number];
  } catch {
    version = undefined;
  }
  const sock = makeWASocket({
    ...(version ? { version } : {}),
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys as never, silent as never) },
    browser: Browsers.ubuntu('RAY'),
    logger: silent as never,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
  });
  s.sock = sock;
  s.status = state.creds.registered ? 'reconnecting' : 'linking';
  s.error = null;
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', (u) => {
    if (s.sock !== sock) return;
    if (u.qr) {
      s.qr = u.qr;
      s.status = 'linking';
      emit(s);
    }
    if (u.connection === 'open') {
      s.status = 'connected';
      s.qr = null;
      s.pairingCode = null;
      s.me = sock.user ? { id: sock.user.id, name: sock.user.name || undefined } : null;
      emit(s);
      // Store the login at once, so a server restart doesn't lose the link.
      void saveLoginNow().catch(() => undefined);
      broadcastHudSound(roomId, 'affirmative');
      console.log(`[RAY whatsapp] ${roomId} connected`);
    }
    if (u.connection === 'close') {
      if (s.sock !== sock) return; // an older attempt we replaced
      const code = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
      console.warn(`[RAY whatsapp] ${roomId} connection closed (code ${code ?? 'none'}): ${u.lastDisconnect?.error?.message || 'no reason given'}`);
      s.sock = null;
      if (code === DisconnectReason.loggedOut) {
        const wasLinked = Boolean(s.me) || state.creds.registered;
        s.status = 'off';
        s.wanted = false; // stop auto-retry — dead credentials must be re-linked manually
        s.me = null;
        s.qr = null;
        s.pairingCode = null;
        s.auth = null;
        s.error = wasLinked
          ? 'WhatsApp ended this link (RAY was removed from Linked devices, or the login expired). Link again to reconnect.'
          : 'WhatsApp refused the link. Wait a minute, then link again — use the newest code or QR and finish within 60 seconds.';
        // Wipe at once so the next attempt starts clean instead of reusing the refused login.
        void saveNow(`wa-auth-${roomId}`, () => ({})).catch(() => undefined);
        emit(s);
        return;
      }
      if (code === 408 && !state.creds.registered) {
        // The QR / pairing code expired without being used: stop instead of looping.
        s.status = 'off';
        s.qr = null;
        s.pairingCode = null;
        s.auth = null;
        s.error = 'The code expired before it was used. Press Link again and enter the new code within 60 seconds.';
        // Wipe stale half-registered creds so the next attempt starts clean.
        void saveNow(`wa-auth-${roomId}`, () => ({})).catch(() => undefined);
        emit(s);
        return;
      }
      if (s.wanted) {
        s.status = 'reconnecting';
        emit(s);
        // Guard: skip retry if another attempt already started a new socket.
        setTimeout(() => { if (s.wanted && !s.sock) void linkWhatsApp(roomId).catch(() => undefined); }, code === DisconnectReason.restartRequired ? 500 : 4000).unref?.();
      } else {
        s.status = 'off';
        emit(s);
      }
    }
  });
  sock.ev.on('messaging-history.set', ({ chats, contacts, messages }) => {
    for (const c of contacts || []) learnContact(s, c);
    for (const c of chats || []) if (c.id) s.chats.set(c.id, { name: String(c.name || nameFor(s, c.id)), lastAt: Number(c.conversationTimestamp || 0) * 1000, unread: Number(c.unreadCount || 0) });
    for (const m of (messages || []).slice(-2000)) storeMessage(s, m, false);
  });
  sock.ev.on('contacts.upsert', (list) => {
    for (const c of list) learnContact(s, c);
  });
  // Renames and newly saved contacts after linking.
  sock.ev.on('contacts.update', (list) => {
    for (const c of list) learnContact(s, c);
  });
  sock.ev.on('lid-mapping.update', (m) => {
    if (m?.lid && m?.pn) s.pn.set(m.lid, m.pn.includes('@') ? m.pn : `${m.pn}@s.whatsapp.net`);
  });
  sock.ev.on('chats.upsert', (list) => {
    for (const c of list) if (c.id && !s.chats.has(c.id)) s.chats.set(c.id, { name: String(c.name || nameFor(s, c.id)), lastAt: Number(c.conversationTimestamp || 0) * 1000, unread: Number(c.unreadCount || 0) });
  });
  sock.ev.on('messages.upsert', ({ messages, type }) => {
    for (const m of messages) storeMessage(s, m, type === 'notify');
  });
  // No camera to scan with? Link with an 8-character code instead (WhatsApp → Linked devices → Link with phone number).
  const digits = String(opts.phone || '').replace(/\D/g, '');
  if (digits.length >= 8 && !state.creds.registered) {
    await new Promise((r) => setTimeout(r, 2500));
    try {
      s.pairingCode = await sock.requestPairingCode(digits);
      s.status = 'linking';
    } catch (err) {
      s.error = `Pairing code failed: ${err instanceof Error ? err.message : err}`;
    }
  }
  emit(s);
  return publicStatus(s);
}

export async function unlinkWhatsApp(roomId: string) {
  const s = session(roomId);
  s.wanted = false;
  try {
    await s.sock?.logout();
  } catch {
    // already gone
  }
  s.sock = null;
  s.status = 'off';
  s.me = null;
  s.qr = null;
  s.pairingCode = null;
  s.chats.clear();
  s.msgs.clear();
  s.auth = null;
  await saveNow(`wa-auth-${roomId}`, () => ({})).catch(() => undefined);
  emit(s);
}

/** Reconnect rooms that linked WhatsApp before a restart. */
export function startWhatsAppLinks() {
  setTimeout(async () => {
    for (const roomId of listRoomIds()) {
      if (await hasSavedLogin(roomId)) void linkWhatsApp(roomId).catch((e) => console.warn('[RAY whatsapp]', e instanceof Error ? e.message : e));
    }
  }, 8000).unref?.();
}

export function whatsappStatus(roomId: string) {
  return publicStatus(session(roomId));
}

// --- helpers for tools -------------------------------------------------------------------------------
function findChat(s: Session, q: string): string | null {
  const t = q.trim();
  if (!t) return null;
  if (/@(s\.whatsapp\.net|g\.us|lid)$/.test(t)) return t;
  const digits = t.replace(/[^\d]/g, '');
  if (digits.length >= 8 && /^[+\d\s()-]+$/.test(t)) return `${digits}@s.whatsapp.net`;
  const all = new Map<string, string>();
  for (const [jid, c] of s.chats) all.set(jid, c.name);
  for (const [jid, n] of s.names) if (!all.has(jid) || /^\+?\d+$/.test(all.get(jid) || '')) all.set(jid, n);
  // Fuzzy: first names, initials, small typos; ties go to the most recent chat.
  const ranked = [...all.entries()]
    .map(([jid, n]) => ({ jid, score: scoreName(t, n), lastAt: s.chats.get(jid)?.lastAt || 0 }))
    .filter((x) => x.score >= 0.6)
    .sort((a, b) => b.score - a.score || b.lastAt - a.lastAt);
  return ranked[0]?.jid || null;
}

/** A person (fuzzy, asks Ray when two fit) or a group; '?message' when Ray still has to pick. */
async function pickChat(roomId: string, s: Session, said: string): Promise<string | null> {
  const t = said.trim();
  if (!t) return null;
  if (/@(s\.whatsapp\.net|g\.us|lid)$/.test(t)) return t;
  const groupHit = findChat(s, t);
  if (groupHit?.endsWith('@g.us') && scoreName(t, nameFor(s, groupHit)) >= 0.9) return groupHit;
  const r = await resolveContact(roomId, t, 'whatsapp', { ask: true, why: `WhatsApp chat "${t}"` });
  if (r.status === 'found') return r.hit.jid || (r.hit.digits ? `${r.hit.digits}@s.whatsapp.net` : null) || groupHit;
  if (r.status === 'ambiguous') return `?${r.note}. Tell me which one (or answer RAY's question).`;
  return groupHit;
}

const MEDIA_KIND = (url: string) =>
  /\.(jpe?g|png|webp|gif)(\?|$)/i.test(url) ? 'image' : /\.(mp4|mov|webm|3gp)(\?|$)/i.test(url) ? 'video' : /\.(mp3|ogg|opus|m4a|wav|aac)(\?|$)/i.test(url) ? 'audio' : 'document';

const mediaCache = new Map<string, { buf: Buffer; mime: string; at: number }>();

export function registerWhatsAppRoutes(app: Express, requireRoomAuth: Parameters<Express['get']>[1]) {
  app.get('/api/whatsapp', requireRoomAuth, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(whatsappStatus(normalizeRoomId(String(req.query.room || 'RLY-HOME'))));
  });
  app.post('/api/whatsapp/link', requireRoomAuth, async (req, res) => {
    const b = req.body as { roomId?: string; phone?: string };
    try {
      res.json(await linkWhatsApp(normalizeRoomId(String(b.roomId || '')), { phone: b.phone }));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  app.post('/api/whatsapp/unlink', requireRoomAuth, async (req, res) => {
    await unlinkWhatsApp(normalizeRoomId(String((req.body as { roomId?: string }).roomId || '')));
    res.json({ ok: true });
  });
  app.get('/api/whatsapp/media/:id', requireRoomAuth, (req, res) => {
    const m = mediaCache.get(String(req.params.id));
    if (!m) return res.status(404).end();
    res.setHeader('Content-Type', m.mime);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.end(m.buf);
  });
}

export const whatsappToolDeclarations: FunctionDeclaration[] = [
  {
    name: 'whatsapp',
    description:
      'Ray’s own WhatsApp, linked to RAY (free, like WhatsApp Web). action: status | chats (recent chats, unread first) | read (last messages of one chat) | send (text) | send_media (photo/video/voice/document from an https URL) | download (a photo/video/voice note someone sent; gives a link). chat = contact or group name, phone number (+91…) or id. Reading is free; sending needs Ray’s command.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        action: { type: Type.STRING },
        chat: { type: Type.STRING },
        text: { type: Type.STRING, description: 'Message text (send) or caption (send_media).' },
        mediaUrl: { type: Type.STRING, description: 'https URL of the file to send.' },
        messageId: { type: Type.STRING, description: 'For download: the message id from read.' },
        limit: { type: Type.NUMBER },
      },
      required: ['action'],
    },
  },
];

export async function executeWhatsAppTool(
  roomId: string,
  name: string,
  args: Record<string, unknown>,
  opts: { confirmed: boolean }
): Promise<{ result: string; confirmation?: ConfirmationRequest } | null> {
  if (name !== 'whatsapp') return null;
  const s = session(roomId);
  const action = String(args.action || 'status').toLowerCase();
  if (action === 'status') return { result: JSON.stringify(publicStatus(s)) };
  if (s.status !== 'connected' || !s.sock) {
    return { result: `WhatsApp is not linked to RAY yet (status: ${s.status}). Ray: JARVIS Core → Accounts → WhatsApp → Link, then scan the QR in WhatsApp → Linked devices. Until then use read_incoming_messages / send_chat_message (phone).` };
  }
  const limit = Math.max(1, Math.min(50, Number(args.limit || 15)));
  if (action === 'chats') {
    const list = [...s.chats.entries()]
      .sort((a, b) => b[1].unread - a[1].unread || b[1].lastAt - a[1].lastAt)
      .slice(0, limit)
      .map(([jid, c]) => `- ${c.name}${jid.endsWith('@g.us') ? ' (group)' : ''}${c.unread ? ` · ${c.unread} unread` : ''}${c.lastAt ? ` · ${new Date(c.lastAt).toISOString().slice(0, 16).replace('T', ' ')}` : ''}`);
    return { result: list.join('\n') || 'No chats synced yet (they appear as messages arrive).' };
  }
  const jid = args.__jid ? String(args.__jid) : await pickChat(roomId, s, String(args.chat || ''));
  if (jid && jid.startsWith('?')) return { result: jid.slice(1) };
  if (!jid) return { result: `No WhatsApp chat or contact matches "${args.chat}". Use action "chats" to see names, or give the number with country code once — I'll remember it.` };
  // Keep the resolved chat in the approval's args so Ray isn't asked "which one" again after approving.
  args.__jid = jid;
  const chatName = nameFor(s, jid);
  if (action === 'read') {
    const list = (s.msgs.get(jid) || []).slice(-limit);
    const c = s.chats.get(jid);
    if (c) c.unread = 0;
    return {
      result: list.length
        ? `${chatName}:\n${list.map((m) => `[${new Date(m.at).toISOString().slice(5, 16).replace('T', ' ')}] ${m.from}: ${m.text}${m.kind !== 'text' ? ` (${m.kind}, messageId=${m.id})` : ''}`).join('\n')}`
        : `No recent messages with ${chatName} in RAY yet (new ones appear as they arrive).`,
    };
  }
  if (action === 'download') {
    const m = (s.msgs.get(jid) || []).find((x) => x.id === String(args.messageId || '')) || [...(s.msgs.get(jid) || [])].reverse().find((x) => x.raw);
    if (!m?.raw) return { result: 'No photo/video/voice note found in that chat.' };
    const { downloadMediaMessage } = await baileys();
    const buf = (await downloadMediaMessage(m.raw as never, 'buffer', {})) as Buffer;
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const mime = m.kind === 'image' ? 'image/jpeg' : m.kind === 'video' ? 'video/mp4' : m.kind === 'audio' ? 'audio/ogg' : 'application/octet-stream';
    mediaCache.set(id, { buf, mime, at: Date.now() });
    for (const [k, v] of mediaCache) if (Date.now() - v.at > 3600_000) mediaCache.delete(k);
    return { result: `Downloaded the ${m.kind} from ${m.from} (${Math.round(buf.length / 1024)} KB): /api/whatsapp/media/${id}?room=${encodeURIComponent(roomId)} — open it on a device with open_url_on_device.` };
  }
  if (action === 'send' || action === 'send_media') {
    const text = String(args.text || '').trim().slice(0, 4000);
    const mediaUrl = String(args.mediaUrl || '').trim();
    if (action === 'send' && !text) return { result: 'Nothing to send.' };
    if (action === 'send_media' && !/^https:\/\//i.test(mediaUrl)) return { result: 'send_media needs an https URL to the file.' };
    const auto = /^(1|true|yes)$/i.test(process.env.RAY_AUTO_SEND_MESSAGES || '');
    if (!opts.confirmed && !auto) {
      const req = createConfirmationRequest({
        roomId,
        toolName: name,
        safetyLevel: 'sensitive',
        summary: `WhatsApp to ${chatName}: ${action === 'send' ? `“${text.slice(0, 200)}”` : `${MEDIA_KIND(mediaUrl)} ${mediaUrl.slice(0, 80)}${text ? ` — “${text.slice(0, 120)}”` : ''}`}`,
        targetDevice: 'WhatsApp',
        args,
      });
      broadcastHudSound(roomId, 'alert');
      return { result: `REQUIRES_CONFIRMATION: WhatsApp message to ${chatName} — waiting for Ray (confirmationId=${req.id}).`, confirmation: req };
    }
    const content =
      action === 'send'
        ? { text }
        : MEDIA_KIND(mediaUrl) === 'image'
          ? { image: { url: mediaUrl }, caption: text || undefined }
          : MEDIA_KIND(mediaUrl) === 'video'
            ? { video: { url: mediaUrl }, caption: text || undefined }
            : MEDIA_KIND(mediaUrl) === 'audio'
              ? { audio: { url: mediaUrl }, mimetype: 'audio/mp4' }
              : { document: { url: mediaUrl }, fileName: decodeURIComponent(mediaUrl.split('/').pop()?.split('?')[0] || 'file'), mimetype: 'application/octet-stream', caption: text || undefined };
    try {
      const sent = await s.sock.sendMessage(jid, content as never);
      if (sent) storeMessage(s, sent as never, false);
      return { result: `Sent to ${chatName} on WhatsApp.` };
    } catch (err) {
      return { result: `WhatsApp send failed: ${err instanceof Error ? err.message : err}` };
    }
  }
  return { result: `Unknown action "${action}".` };
}

/** Internals for tests (message parsing, chat lookup, session state). */
export const __whatsappInternals = { session, storeMessage, textOf, findChat, learnContact };

/** Every person (not group) the linked WhatsApp knows: name, chat id, number when known, last chat time. */
export async function whatsappContactList(roomId: string): Promise<Array<{ name: string; jid: string; digits?: string; lastAt: number }>> {
  const s = sessions.get(roomId);
  if (!s) return [];
  const byJid = new Map<string, { name: string; jid: string; digits?: string; lastAt: number }>();
  const ids = new Set<string>([...s.names.keys(), ...s.chats.keys()]);
  for (const jid of ids) {
    if (!/@(s\.whatsapp\.net|lid)$/.test(jid)) continue;
    const name = s.names.get(jid) || s.chats.get(jid)?.name || '';
    if (!name || /^\+?\d+$/.test(name)) continue;
    const pn = await phoneJid(s, jid);
    const key = pn || jid;
    const lastAt = Math.max(s.chats.get(jid)?.lastAt || 0, pn ? s.chats.get(pn)?.lastAt || 0 : 0);
    const prev = byJid.get(key);
    if (!prev || lastAt > prev.lastAt) byJid.set(key, { name, jid: key, digits: pn ? pn.replace(/@.*/, '').replace(/:.*/, '') : undefined, lastAt });
  }
  return [...byJid.values()];
}

/** Phone number (digits) for a contact name/number via the linked WhatsApp, or null. */
export function whatsappNumberFor(roomId: string, who: string): { digits: string; name: string } | null {
  const s = sessions.get(roomId);
  const t = who.trim();
  const direct = t.replace(/[^\d]/g, '');
  if (direct.length >= 8 && /^[+\d\s()-]+$/.test(t)) return { digits: direct, name: t };
  if (!s) return null;
  const jid = findChat(s, t);
  if (!jid || !jid.endsWith('@s.whatsapp.net')) return null;
  return { digits: jid.replace(/@.*/, '').replace(/:.*/, ''), name: nameFor(s, jid) };
}
