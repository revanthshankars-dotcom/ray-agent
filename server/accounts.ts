/**
 * ACCOUNTS CLAUSE — RAY's own, always-on access to Ray's Google and Meta accounts.
 *
 * Google: one-time "Connect Google" (server-side OAuth with a refresh token, stored encrypted per
 * room). RAY can then use Gmail, Calendar, Drive, Docs, Sheets, Slides, Tasks, Contacts, YouTube
 * from ANY device or voice command, even when no browser tab is open (Autopilot too).
 *   google_api_request = any Google REST API call within the granted scopes ("do almost
 *   everything the app offers"). Reads run freely; writes need Ray's command; deleting and
 *   sending email need one Approve.
 * Meta: official Graph API with tokens from Render env (INSTAGRAM_ACCESS_TOKEN / META_PAGE_TOKEN /
 *   WHATSAPP_TOKEN). meta_api_request = any Instagram/Facebook Graph call (publish posts & reels,
 *   read & reply to comments, DMs within Meta's rules, insights). Personal (non-professional)
 *   Instagram accounts have no API — RAY uses the browser/phone instead (browse_web / operate_computer).
 */
import crypto from 'crypto';
import type { Express, Request } from 'express';
import { Type } from '@google/genai';
import type { FunctionDeclaration } from '@google/genai';
import { createConfirmationRequest } from './capabilities.ts';
import { broadcastHudSound, normalizeRoomId, verifyRoomToken } from './hub.ts';
import { loadJson, scheduleSave } from './persistence.ts';
import type { ConfirmationRequest } from '../src/types/relay.ts';

export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/presentations',
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/contacts',
  'https://www.googleapis.com/auth/youtube',
];

function env(name: string): string {
  const v = (process.env[name] || '').trim();
  return /^(unset|none)$/i.test(v) ? '' : v;
}
const clientId = () => env('GOOGLE_OAUTH_CLIENT_ID') || env('GOOGLE_CLIENT_ID');
const clientSecret = () => env('GOOGLE_OAUTH_CLIENT_SECRET') || env('GOOGLE_CLIENT_SECRET');

// --- encrypted token store ---------------------------------------------------
function key(): Buffer {
  return crypto.createHash('sha256').update(`ray-accounts:${env('RELAY_MASTER_SECRET') || env('RAY_SECRET') || 'local-dev'}`).digest();
}
export function seal(text: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}
export function unseal(blob: string): string | null {
  try {
    const [iv, tag, enc] = blob.split('.').map((s) => Buffer.from(s, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

interface GoogleLink {
  refresh: string; // sealed
  email?: string;
  scopes?: string;
  connectedAt: number;
}
const links = new Map<string, GoogleLink | null>();
const accessCache = new Map<string, { token: string; exp: number }>();

async function getLink(roomId: string): Promise<GoogleLink | null> {
  if (!links.has(roomId)) links.set(roomId, ((await loadJson<Record<string, unknown>>(`google-link-${roomId}`)) as unknown as GoogleLink) || null);
  const l = links.get(roomId);
  return l && l.refresh ? l : null;
}
function saveLink(roomId: string, link: GoogleLink | null) {
  links.set(roomId, link);
  accessCache.delete(roomId);
  scheduleSave(`google-link-${roomId}`, () => (link ? { ...link } : {}), 200);
}

/** A fresh Google access token for this room (server-side connection), or null. */
export async function getServerGoogleToken(roomId: string): Promise<string | null> {
  const cached = accessCache.get(roomId);
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const link = await getLink(roomId);
  const refresh = link ? unseal(link.refresh) : null;
  if (!refresh || !clientId() || !clientSecret()) return null;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId(), client_secret: clientSecret(), refresh_token: refresh, grant_type: 'refresh_token' }),
    signal: AbortSignal.timeout(15000),
  });
  const j = (await r.json()) as { access_token?: string; expires_in?: number; error?: string };
  if (!r.ok || !j.access_token) {
    if (j.error === 'invalid_grant') saveLink(roomId, null); // revoked by Ray → ask to reconnect
    return null;
  }
  accessCache.set(roomId, { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 });
  return j.access_token;
}

export async function accountsStatus(roomId: string) {
  const link = await getLink(roomId);
  return {
    google: {
      configured: Boolean(clientId() && clientSecret()),
      connected: Boolean(link),
      email: link?.email || null,
      connectedAt: link?.connectedAt || null,
    },
    meta: {
      instagram: Boolean(env('INSTAGRAM_ACCESS_TOKEN')),
      facebookPage: Boolean(env('META_PAGE_TOKEN')),
      whatsapp: Boolean(env('WHATSAPP_TOKEN') && env('WHATSAPP_PHONE_NUMBER_ID')),
    },
  };
}

// --- OAuth routes --------------------------------------------------------------
const pendingStates = new Map<string, { roomId: string; exp: number; redirect: string }>();

function publicBase(req: Request): string {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0];
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000').split(',')[0];
  return env('PUBLIC_BASE_URL').replace(/\/+$/, '') || `${proto}://${host}`;
}

export function registerAccountRoutes(app: Express, requireRoomAuth: Parameters<Express['get']>[1]) {
  app.get('/api/accounts', requireRoomAuth, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await accountsStatus(normalizeRoomId(String(req.query.room || 'RLY-HOME'))));
  });

  app.post('/api/accounts/google/disconnect', requireRoomAuth, async (req, res) => {
    const roomId = normalizeRoomId(String((req.body as { roomId?: string }).roomId || ''));
    const link = await getLink(roomId);
    const refresh = link ? unseal(link.refresh) : null;
    if (refresh) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refresh)}`, { method: 'POST' }).catch(() => undefined);
    saveLink(roomId, null);
    res.json({ ok: true });
  });

  // Opened in a browser tab: /api/accounts/google/start?room=…&token=…
  app.get('/api/accounts/google/start', (req, res) => {
    const roomId = normalizeRoomId(String(req.query.room || ''));
    if (!verifyRoomToken(roomId, String(req.query.token || ''))) return void res.status(401).send('Invalid room link — open this from RAY.');
    if (!clientId() || !clientSecret()) {
      return void res
        .status(503)
        .send('Google is not set up on the server yet: add GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in Render (see README → Accounts).');
    }
    const state = crypto.randomBytes(16).toString('hex');
    const redirect = `${publicBase(req)}/api/accounts/google/callback`;
    pendingStates.set(state, { roomId, exp: Date.now() + 15 * 60_000, redirect });
    const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    u.search = new URLSearchParams({
      client_id: clientId(),
      redirect_uri: redirect,
      response_type: 'code',
      scope: GOOGLE_SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    }).toString();
    res.redirect(u.toString());
  });

  app.get('/api/accounts/google/callback', async (req, res) => {
    const st = pendingStates.get(String(req.query.state || ''));
    pendingStates.delete(String(req.query.state || ''));
    const page = (msg: string) =>
      `<!doctype html><meta name=viewport content="width=device-width"><body style="font-family:system-ui;padding:32px;max-width:520px;margin:auto"><h2>RAY</h2><p>${msg}</p><p><a href="/?room=${encodeURIComponent(st?.roomId || '')}">Back to RAY</a></p></body>`;
    if (!st || st.exp < Date.now()) return void res.status(400).send(page('This link expired. Press “Connect Google” in RAY again.'));
    if (req.query.error) return void res.status(400).send(page(`Google said: ${String(req.query.error).replace(/[<>]/g, '')}`));
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: String(req.query.code || ''), client_id: clientId(), client_secret: clientSecret(), redirect_uri: st.redirect, grant_type: 'authorization_code' }),
    });
    const j = (await r.json()) as { refresh_token?: string; access_token?: string; expires_in?: number; scope?: string; id_token?: string };
    if (!r.ok || !j.refresh_token) return void res.status(400).send(page('Google did not return a long-lived token. Remove RAY at myaccount.google.com/permissions and connect again.'));
    let email: string | undefined;
    try {
      email = JSON.parse(Buffer.from(String(j.id_token || '').split('.')[1] || '', 'base64url').toString()).email;
    } catch {
      email = undefined;
    }
    saveLink(st.roomId, { refresh: seal(j.refresh_token), email, scopes: j.scope, connectedAt: Date.now() });
    if (j.access_token) accessCache.set(st.roomId, { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 });
    res.send(page(`Connected${email ? ` as <b>${email}</b>` : ''}. RAY can now use Gmail, Calendar, Drive, Docs, Sheets, Slides, Tasks, Contacts and YouTube from any device. You can close this tab.`));
  });
}

// --- Generic API tools -----------------------------------------------------------
const GOOGLE_HOST = /^https:\/\/([a-z0-9-]+\.)?googleapis\.com\//i;
const META_HOST = /^https:\/\/graph\.(facebook|instagram)\.com\//i;

async function callApi(url: string, method: string, token: string, body?: unknown) {
  const r = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined && method !== 'GET' ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await r.text();
  return `${r.status} ${r.ok ? 'OK' : 'ERROR'}\n${text.slice(0, 14000)}`;
}

function parseBody(raw: unknown): unknown {
  if (raw == null || raw === '') return undefined;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export const accountToolDeclarations: FunctionDeclaration[] = [
  {
    name: 'google_api_request',
    description:
      'Call ANY Google REST API on Ray’s connected Google account (Gmail, Calendar, Drive, Docs, Sheets, Slides, Tasks, People/Contacts, YouTube). Use the official endpoint, e.g. GET https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread, POST https://www.googleapis.com/calendar/v3/calendars/primary/events, POST https://docs.googleapis.com/v1/documents/{id}:batchUpdate. Chain calls to finish the whole job. Reads are free; writes only when Ray asked; deletes and sending email need his approval.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        method: { type: Type.STRING, description: 'GET | POST | PUT | PATCH | DELETE' },
        url: { type: Type.STRING, description: 'Full https://…googleapis.com/… URL with query string.' },
        bodyJson: { type: Type.STRING, description: 'JSON request body for POST/PUT/PATCH.' },
      },
      required: ['method', 'url'],
    },
  },
  {
    name: 'meta_api_request',
    description:
      'Call the Instagram / Facebook Graph API with Ray’s Meta tokens (Instagram professional account or Facebook Page): read media, comments, insights; reply to comments; publish photos/reels/carousels (create container → media_publish); DMs within Meta’s 24-hour rule. URL like https://graph.facebook.com/v21.0/{ig-user-id}/media?fields=caption,like_count. account: "instagram" (default) or "page".',
    parameters: {
      type: Type.OBJECT,
      properties: {
        method: { type: Type.STRING, description: 'GET | POST | DELETE' },
        url: { type: Type.STRING, description: 'Full https://graph.facebook.com/… or graph.instagram.com URL.' },
        bodyJson: { type: Type.STRING, description: 'JSON body for POST.' },
        account: { type: Type.STRING, description: '"instagram" or "page".' },
      },
      required: ['method', 'url'],
    },
  },
  {
    name: 'connected_accounts',
    description: 'Which of Ray’s accounts RAY can use right now (Google, Instagram, Facebook Page, WhatsApp) and how to connect the rest. Read-only.',
    parameters: { type: Type.OBJECT, properties: {} },
  },
];

export async function executeAccountTool(
  roomId: string,
  name: string,
  args: Record<string, unknown>,
  opts: { confirmed: boolean; clientGoogleToken?: string }
): Promise<{ result: string; confirmation?: ConfirmationRequest } | null> {
  if (name === 'connected_accounts') {
    const s = await accountsStatus(roomId);
    return {
      result: JSON.stringify({
        ...s,
        howToConnect: {
          google: s.google.connected ? undefined : s.google.configured ? 'JARVIS Core → Accounts → Connect Google' : 'Server needs GOOGLE_OAUTH_CLIENT_ID/SECRET in Render first',
          instagram: s.meta.instagram ? undefined : 'Instagram professional account + INSTAGRAM_ACCESS_TOKEN in Render; personal accounts: RAY uses the browser/phone',
        },
      }),
    };
  }
  if (name !== 'google_api_request' && name !== 'meta_api_request') return null;
  const method = String(args.method || 'GET').toUpperCase();
  const url = String(args.url || '').trim();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return { result: 'Invalid method.' };
  const isGoogle = name === 'google_api_request';
  if (!(isGoogle ? GOOGLE_HOST : META_HOST).test(url)) return { result: `URL must start with ${isGoogle ? 'https://…googleapis.com/' : 'https://graph.facebook.com/ or https://graph.instagram.com/'}` };

  let token: string | null = null;
  if (isGoogle) {
    token = (await getServerGoogleToken(roomId)) || opts.clientGoogleToken || null;
    if (!token) return { result: 'Google is not connected. Ask Ray to open JARVIS Core → Accounts → Connect Google (one time).' };
  } else {
    token = String(args.account || '').toLowerCase() === 'page' ? env('META_PAGE_TOKEN') : env('INSTAGRAM_ACCESS_TOKEN') || env('META_PAGE_TOKEN');
    if (!token) return { result: 'No Meta token configured. Instagram needs a professional account and INSTAGRAM_ACCESS_TOKEN in Render. For a personal account use browse_web (mode "do") or operate_computer on the phone.' };
  }

  const sensitive = method === 'DELETE' || /\/messages\/send|\/drafts\/send|media_publish|\/messages(\?|$)/i.test(url);
  if (sensitive && !opts.confirmed) {
    const req = createConfirmationRequest({
      roomId,
      toolName: name,
      safetyLevel: 'sensitive',
      summary: `${method} ${url.replace(/access_token=[^&]+/, 'access_token=…').slice(0, 160)}${args.bodyJson ? ` with ${String(args.bodyJson).slice(0, 200)}` : ''}`,
      targetDevice: isGoogle ? 'Google account' : 'Meta account',
      args,
    });
    broadcastHudSound(roomId, 'alert');
    return { result: `REQUIRES_CONFIRMATION: this ${method === 'DELETE' ? 'deletes data' : 'sends/publishes for Ray'} — waiting for his Approve (confirmationId=${req.id}).`, confirmation: req };
  }
  try {
    return { result: await callApi(url, method, token, parseBody(args.bodyJson)) };
  } catch (err) {
    return { result: `Request failed: ${err instanceof Error ? err.message : err}` };
  }
}
