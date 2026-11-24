/**
 * HOME — RAY controls lights, plugs, fans, AC, TV, locks, covers and scenes through Home Assistant
 * (free, open source). Two routes, picked automatically:
 *   • a public https Home Assistant URL (e.g. a free Cloudflare Tunnel) → called directly
 *   • a home-network URL (homeassistant.local:8123) → relayed by Ray's PC bridge on that network
 * The long-lived access token is stored sealed. Locks, garage doors and alarms need Ray's approval.
 */
import type { Express } from 'express';
import { Type } from '@google/genai';
import type { FunctionDeclaration } from '@google/genai';
import { createConfirmationRequest } from './capabilities.ts';
import { broadcastHudSound, dispatchBridgeProxyCall, normalizeRoomId } from './hub.ts';
import { loadJson, scheduleSave } from './persistence.ts';
import { seal, unseal } from './accounts.ts';
import type { ConfirmationRequest } from '../src/types/relay.ts';

interface HomeLink {
  url: string; // '' = auto-discover on the LAN through the bridge
  token: string; // sealed
  connectedAt: number;
}
interface HaState {
  entity_id: string;
  state: string;
  attributes?: { friendly_name?: string; unit_of_measurement?: string; brightness?: number; temperature?: number; current_temperature?: number };
}

const links = new Map<string, HomeLink | null>();
const stateCache = new Map<string, { at: number; states: HaState[] }>();

async function getLink(roomId: string): Promise<HomeLink | null> {
  if (!links.has(roomId)) {
    const l = (await loadJson<Record<string, unknown>>(`home-assistant-${roomId}`)) as unknown as HomeLink | null;
    links.set(roomId, l && l.token ? l : null);
  }
  return links.get(roomId) || null;
}
function saveLink(roomId: string, l: HomeLink | null) {
  links.set(roomId, l);
  stateCache.delete(roomId);
  scheduleSave(`home-assistant-${roomId}`, () => (l ? ({ ...l } as unknown as Record<string, unknown>) : {}), 200);
}

const isPublicHttps = (url: string) => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !/^(localhost|.*\.local|.*\.lan|.*\.home|homeassistant|10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(u.hostname);
  } catch {
    return false;
  }
};

async function ha(roomId: string, method: 'GET' | 'POST', path: string, body?: unknown, link?: HomeLink): Promise<unknown> {
  const l = link || (await getLink(roomId));
  if (!l) throw new Error('Home Assistant is not connected. JARVIS Core → Home → paste its address and a long-lived token.');
  const token = unseal(l.token) || '';
  if (l.url && isPublicHttps(l.url)) {
    const r = await fetch(l.url.replace(/\/+$/, '') + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: method === 'POST' ? JSON.stringify(body || {}) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(12000),
    });
    if (r.status === 401) throw new Error('Home Assistant refused the token (401).');
    if (!r.ok) throw new Error(`Home Assistant answered ${r.status}`);
    return r.json().catch(() => ({}));
  }
  const out = await dispatchBridgeProxyCall(roomId, { action: 'home_assistant', url: l.url || '', token, method, path, body }, 20000);
  if (!out.ok) throw new Error(/No online Desktop OS Bridge/.test(out.error || '') ? 'Your PC bridge is offline, and it is how RAY reaches Home Assistant on your home network.' : out.error || 'Home Assistant call failed');
  const data = out.data as { base?: string; result?: unknown };
  if (data?.base && !l.url) saveLink(roomId, { ...l, url: data.base }); // remember the discovered address
  return data?.result;
}

async function states(roomId: string, fresh = false): Promise<HaState[]> {
  const c = stateCache.get(roomId);
  if (!fresh && c && Date.now() - c.at < 30_000) return c.states;
  const s = ((await ha(roomId, 'GET', '/api/states')) as HaState[]) || [];
  stateCache.set(roomId, { at: Date.now(), states: s });
  return s;
}

const CONTROLLABLE = /^(light|switch|fan|climate|cover|lock|media_player|scene|script|input_boolean|vacuum|humidifier|water_heater|alarm_control_panel|button|siren|valve)\./;
const name = (e: HaState) => e.attributes?.friendly_name || e.entity_id;

function findEntity(list: HaState[], q: string): HaState | null {
  const t = q.trim().toLowerCase();
  if (!t) return null;
  const exact = list.find((e) => e.entity_id === t) || list.find((e) => name(e).toLowerCase() === t);
  if (exact) return exact;
  const words = t.split(/\s+/).filter((w) => w.length > 1 && !/^(the|my|a|in|on|of)$/.test(w));
  const scored = list
    .filter((e) => CONTROLLABLE.test(e.entity_id))
    .map((e) => {
      const hay = `${name(e)} ${e.entity_id.replace(/[._]/g, ' ')}`.toLowerCase();
      return { e, s: words.filter((w) => hay.includes(w)).length };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
  return scored[0]?.e || null;
}

function serviceFor(entity: HaState, action: string, value?: unknown): { domain: string; service: string; data: Record<string, unknown> } | null {
  const domain = entity.entity_id.split('.')[0];
  const a = action.toLowerCase().replace(/\s+/g, '_');
  const data: Record<string, unknown> = { entity_id: entity.entity_id };
  const n = Number(value);
  if (['on', 'turn_on', 'start', 'activate', 'run'].includes(a)) {
    if (domain === 'scene' || domain === 'script') return { domain, service: 'turn_on', data };
    if (domain === 'cover') return { domain, service: 'open_cover', data };
    if (domain === 'lock') return { domain, service: 'unlock', data };
    if (domain === 'vacuum') return { domain, service: 'start', data };
    if (domain === 'button') return { domain, service: 'press', data };
    return { domain: domain === 'media_player' || domain === 'climate' || CONTROLLABLE.test(entity.entity_id) ? domain : 'homeassistant', service: 'turn_on', data };
  }
  if (['off', 'turn_off', 'stop'].includes(a)) {
    if (domain === 'cover') return { domain, service: 'close_cover', data };
    if (domain === 'lock') return { domain, service: 'lock', data };
    if (domain === 'vacuum') return { domain, service: 'return_to_base', data };
    return { domain, service: 'turn_off', data };
  }
  if (a === 'toggle') return { domain, service: 'toggle', data };
  if (a === 'lock' || a === 'unlock') return { domain: 'lock', service: a, data };
  if (a === 'open' || a === 'close') return domain === 'cover' ? { domain, service: `${a}_cover`, data } : domain === 'valve' ? { domain, service: `${a}_valve`, data } : null;
  if ((a === 'brightness' || a === 'dim' || a === 'set_brightness') && Number.isFinite(n)) return { domain: 'light', service: 'turn_on', data: { ...data, brightness_pct: Math.max(0, Math.min(100, n)) } };
  if (a === 'color' || a === 'colour') return { domain: 'light', service: 'turn_on', data: { ...data, color_name: String(value || 'white') } };
  if ((a === 'temperature' || a === 'set_temperature') && Number.isFinite(n)) return { domain: 'climate', service: 'set_temperature', data: { ...data, temperature: n } };
  if (a === 'play') return { domain: 'media_player', service: 'media_play', data };
  if (a === 'pause') return { domain: 'media_player', service: 'media_pause', data };
  if (a === 'next') return { domain: 'media_player', service: 'media_next_track', data };
  if ((a === 'volume' || a === 'set_volume') && Number.isFinite(n)) return { domain: 'media_player', service: 'volume_set', data: { ...data, volume_level: Math.max(0, Math.min(1, n > 1 ? n / 100 : n)) } };
  if (a === 'arm') return { domain: 'alarm_control_panel', service: 'alarm_arm_away', data };
  if (a === 'disarm') return { domain: 'alarm_control_panel', service: 'alarm_disarm', data };
  return null;
}

const SENSITIVE = (entity: HaState, svc: { domain: string; service: string }) =>
  svc.domain === 'lock' || svc.domain === 'alarm_control_panel' || (svc.domain === 'cover' && /garage|gate|door/i.test(`${entity.entity_id} ${name(entity)}`)) || /siren/.test(svc.domain);

export async function homeStatus(roomId: string) {
  const l = await getLink(roomId);
  return { connected: Boolean(l), url: l?.url || (l ? 'auto (home network via PC)' : null), connectedAt: l?.connectedAt || null };
}

export function registerHomeRoutes(app: Express, requireRoomAuth: Parameters<Express['get']>[1]) {
  app.get('/api/home', requireRoomAuth, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await homeStatus(normalizeRoomId(String(req.query.room || 'RLY-HOME'))));
  });
  app.post('/api/home/connect', requireRoomAuth, async (req, res) => {
    const b = req.body as { roomId?: string; url?: string; token?: string };
    const roomId = normalizeRoomId(String(b.roomId || ''));
    const token = String(b.token || '').trim();
    const url = String(b.url || '').trim().replace(/\/+$/, '');
    if (!token) return res.status(400).json({ ok: false, error: 'Paste a long-lived access token (Home Assistant → your profile → Security).' });
    if (url && !/^https?:\/\//i.test(url)) return res.status(400).json({ ok: false, error: 'Address must start with http:// or https://' });
    const link: HomeLink = { url, token: seal(token), connectedAt: Date.now() };
    try {
      const all = (await ha(roomId, 'GET', '/api/states', undefined, link)) as HaState[];
      saveLink(roomId, { ...link, url: link.url || (await getLink(roomId))?.url || '' });
      res.json({ ok: true, devices: (all || []).filter((e) => CONTROLLABLE.test(e.entity_id)).length });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
  app.post('/api/home/disconnect', requireRoomAuth, (req, res) => {
    saveLink(normalizeRoomId(String((req.body as { roomId?: string }).roomId || '')), null);
    res.json({ ok: true });
  });
}

export const homeToolDeclarations: FunctionDeclaration[] = [
  {
    name: 'home_devices',
    description:
      'List Ray’s smart-home devices from Home Assistant (lights, plugs, fans, AC, TV, locks, blinds, scenes, sensors) with their current state. query filters by name/room, e.g. "bedroom", "temperature". Read-only.',
    parameters: { type: Type.OBJECT, properties: { query: { type: Type.STRING } } },
  },
  {
    name: 'home_control',
    description:
      'Control a smart-home device through Home Assistant. entity: name or entity_id ("bedroom light", "light.desk"). action: on | off | toggle | brightness | color | temperature | open | close | lock | unlock | play | pause | next | volume | arm | disarm. value: number or colour when needed. Locks, garage doors and alarms ask Ray first.',
    parameters: {
      type: Type.OBJECT,
      properties: { entity: { type: Type.STRING }, action: { type: Type.STRING }, value: { type: Type.STRING } },
      required: ['entity', 'action'],
    },
  },
];

export async function executeHomeTool(
  roomId: string,
  nameArg: string,
  args: Record<string, unknown>,
  opts: { confirmed: boolean }
): Promise<{ result: string; confirmation?: ConfirmationRequest } | null> {
  if (nameArg !== 'home_devices' && nameArg !== 'home_control') return null;
  try {
    if (nameArg === 'home_devices') {
      const q = String(args.query || '').toLowerCase();
      const list = (await states(roomId, true))
        .filter((e) => CONTROLLABLE.test(e.entity_id) || /^sensor\.|^binary_sensor\./.test(e.entity_id))
        .filter((e) => !q || `${name(e)} ${e.entity_id}`.toLowerCase().includes(q))
        .slice(0, 60)
        .map((e) => `${name(e)} (${e.entity_id}): ${e.state}${e.attributes?.unit_of_measurement ? ` ${e.attributes.unit_of_measurement}` : ''}`);
      return { result: list.length ? list.join('\n') : 'No matching devices in Home Assistant.' };
    }
    const all = await states(roomId);
    const entity = findEntity(all, String(args.entity || ''));
    if (!entity) return { result: `No device matching "${args.entity}". Use home_devices to see names.` };
    const svc = serviceFor(entity, String(args.action || ''), args.value);
    if (!svc) return { result: `"${args.action}" doesn't apply to ${name(entity)} (${entity.entity_id}).` };
    if (SENSITIVE(entity, svc) && !opts.confirmed) {
      const req = createConfirmationRequest({ roomId, toolName: nameArg, safetyLevel: 'sensitive', summary: `${svc.domain}.${svc.service} → ${name(entity)}`, targetDevice: 'Home', args });
      broadcastHudSound(roomId, 'alert');
      return { result: `REQUIRES_CONFIRMATION: ${name(entity)} is a security device — waiting for Ray's Approve (confirmationId=${req.id}).`, confirmation: req };
    }
    await ha(roomId, 'POST', `/api/services/${svc.domain}/${svc.service}`, svc.data);
    stateCache.delete(roomId);
    return { result: `${name(entity)}: ${svc.service.replace(/_/g, ' ')}${svc.data.brightness_pct != null ? ` ${svc.data.brightness_pct}%` : ''}${svc.data.temperature != null ? ` ${svc.data.temperature}°` : ''} — done.` };
  } catch (err) {
    return { result: `Home: ${err instanceof Error ? err.message : err}` };
  }
}
