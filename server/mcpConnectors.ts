/**
 * CONNECTORS — plug any remote MCP server into RAY (Streamable HTTP transport).
 *
 * Ray adds a server once in JARVIS Core → Connectors (URL + optional key). RAY then sees every tool
 * that server offers and can call it from any device / voice / Autopilot:
 *   mcp_servers  → what is connected and which tools each server has (with input schemas on request)
 *   mcp_call     → call one tool on one server
 * Examples: AgentPhone (numbers, SMS, calls), CallForMe, an n8n instance, a course/challenge server,
 * skills from a catalog that ship as hosted MCP servers.
 *
 * URLs and keys are stored sealed (AES-GCM). Private/loopback hosts are refused (SSRF guard) unless
 * RAY_ALLOW_LOCAL_MCP=1. Tools that send, call, buy, post or delete need Ray's approval.
 */
import crypto from 'crypto';
import type { Express } from 'express';
import { Type } from '@google/genai';
import type { FunctionDeclaration } from '@google/genai';
import { createConfirmationRequest } from './capabilities.ts';
import { broadcastHudSound, normalizeRoomId } from './hub.ts';
import { loadJson, scheduleSave } from './persistence.ts';
import { seal, unseal } from './accounts.ts';
import type { ConfirmationRequest } from '../src/types/relay.ts';

interface McpToolInfo {
  name: string;
  description: string;
  inputSchema?: unknown;
  readOnly?: boolean;
  destructive?: boolean;
}
interface Connector {
  id: string;
  name: string;
  url: string; // sealed
  auth: string; // sealed bearer token or ''
  host: string; // shown in the UI
  tools: McpToolInfo[];
  addedAt: number;
  refreshedAt: number;
  lastError?: string;
}

const PROTOCOL_VERSION = '2025-06-18';
const rooms = new Map<string, Connector[]>();
const sessions = new Map<string, string>(); // connector id → Mcp-Session-Id
const knownWords = new Set<string>();

async function getConnectors(roomId: string): Promise<Connector[]> {
  if (!rooms.has(roomId)) {
    const stored = await loadJson<{ connectors?: Connector[] }>(`mcp-connectors-${roomId}`);
    rooms.set(roomId, stored?.connectors || []);
    indexWords(rooms.get(roomId)!);
  }
  return rooms.get(roomId)!;
}
function saveConnectors(roomId: string) {
  indexWords(rooms.get(roomId) || []);
  scheduleSave(`mcp-connectors-${roomId}`, () => ({ connectors: rooms.get(roomId) || [] }), 300);
}
function indexWords(list: Connector[]) {
  for (const c of list) {
    knownWords.add(c.name.toLowerCase());
    for (const t of c.tools) for (const w of t.name.toLowerCase().split(/[_\-.]+/)) if (w.length > 3) knownWords.add(w);
  }
}

/** Lower-case connector names / tool words seen so far — lets the router offer mcp_call when Ray mentions them. */
export function mcpKnownWords(): Set<string> {
  return knownWords;
}

// --- URL safety -----------------------------------------------------------------

function checkUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error('That is not a valid URL.');
  }
  const allowLocal = process.env.RAY_ALLOW_LOCAL_MCP === '1';
  if (u.protocol !== 'https:' && !(allowLocal && u.protocol === 'http:')) throw new Error('MCP server URL must start with https://');
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const privateHost =
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.internal') ||
    h.endsWith('.local') ||
    /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) ||
    h === '::1' ||
    /^f[cd][0-9a-f]{2}:/.test(h) ||
    /^fe80:/.test(h);
  if (privateHost && !allowLocal) throw new Error('Private or local addresses are not allowed for connectors.');
  return u;
}

// --- Streamable HTTP client -------------------------------------------------------

interface RpcResult {
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
}

async function readRpc(r: Response, id: number): Promise<RpcResult> {
  const type = r.headers.get('content-type') || '';
  const text = await r.text();
  if (type.includes('text/event-stream')) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (!data) continue;
      try {
        const msg = JSON.parse(data) as RpcResult & { id?: number };
        if (msg.id === id) return msg;
      } catch {
        /* keep scanning */
      }
    }
    throw new Error('The server stream ended without an answer.');
  }
  if (/^\s*</.test(text)) throw new Error('That URL returned a web page, not an MCP endpoint.');
  try {
    return JSON.parse(text) as RpcResult;
  } catch {
    throw new Error(`Unexpected reply (${r.status}): ${text.slice(0, 120)}`);
  }
}

let rpcId = 1;
async function post(url: string, auth: string, sessionId: string | undefined, body: Record<string, unknown>, timeoutMs = 30000) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': PROTOCOL_VERSION,
  };
  if (auth) headers.Authorization = /^(bearer|basic|token)\s/i.test(auth) ? auth : `Bearer ${auth}`;
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  return fetch(url, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
}

async function initialize(url: string, auth: string): Promise<string | undefined> {
  const id = rpcId++;
  const r = await post(url, auth, undefined, {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'RAY', version: '3.2' } },
  }, 20000);
  if (r.status === 401 || r.status === 403) throw new Error('The server refused the key (401/403). Check the token.');
  if (!r.ok) throw new Error(`The server answered ${r.status}.`);
  const sessionId = r.headers.get('mcp-session-id') || undefined;
  const msg = await readRpc(r, id);
  if (msg.error) throw new Error(msg.error.message || 'initialize failed');
  await post(url, auth, sessionId, { jsonrpc: '2.0', method: 'notifications/initialized' }, 10000)
    .then((x) => x.body?.cancel())
    .catch(() => undefined);
  return sessionId;
}

async function rpc(c: Connector, method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> {
  const url = unseal(c.url);
  if (!url) throw new Error('Stored connector could not be decrypted — remove and add it again.');
  const auth = c.auth ? unseal(c.auth) || '' : '';
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!sessions.has(c.id)) sessions.set(c.id, (await initialize(url, auth)) || '');
    const id = rpcId++;
    const r = await post(url, auth, sessions.get(c.id) || undefined, { jsonrpc: '2.0', id, method, params }, timeoutMs);
    if ((r.status === 404 || r.status === 400) && attempt === 0 && sessions.get(c.id)) {
      sessions.delete(c.id); // session expired → re-initialize once
      continue;
    }
    if (!r.ok) throw new Error(`The server answered ${r.status}.`);
    const msg = await readRpc(r, id);
    if (msg.error) throw new Error(msg.error.message || `${method} failed`);
    return msg.result || {};
  }
  throw new Error('Could not keep a session with the server.');
}

async function listTools(c: Connector): Promise<McpToolInfo[]> {
  const out: McpToolInfo[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const res = await rpc(c, 'tools/list', cursor ? { cursor } : {});
    const tools = (res.tools as Array<Record<string, unknown>>) || [];
    for (const t of tools) {
      const ann = (t.annotations || {}) as { readOnlyHint?: boolean; destructiveHint?: boolean };
      out.push({
        name: String(t.name),
        description: String(t.description || '').slice(0, 400),
        inputSchema: t.inputSchema,
        readOnly: ann.readOnlyHint === true,
        destructive: ann.destructiveHint === true,
      });
    }
    cursor = res.nextCursor ? String(res.nextCursor) : undefined;
    if (!cursor) break;
  }
  return out;
}

/** Candidate endpoints: the URL as given, then common MCP paths on the same site (keeps the query string). */
function candidates(u: URL): string[] {
  const list = [u.toString()];
  if (!/\/(mcp|sse)\/?$/i.test(u.pathname)) {
    for (const path of ['/mcp', '/api/mcp']) {
      const v = new URL(u.toString());
      v.pathname = path;
      list.push(v.toString());
    }
  }
  return list;
}

export async function addConnector(roomId: string, input: { name?: string; url: string; token?: string }): Promise<Connector> {
  const u = checkUrl(input.url);
  const token = (input.token || '').trim();
  const list = await getConnectors(roomId);
  let lastErr: Error | null = null;
  for (const url of candidates(u)) {
    const c: Connector = {
      id: crypto.randomUUID().slice(0, 10),
      name: (input.name || u.hostname.replace(/^(www|mcp|api)\./, '').split('.')[0]).trim().slice(0, 40) || 'server',
      url: seal(url),
      auth: token ? seal(token) : '',
      host: new URL(url).host + new URL(url).pathname,
      tools: [],
      addedAt: Date.now(),
      refreshedAt: Date.now(),
    };
    try {
      c.tools = await listTools(c);
      const existing = list.findIndex((x) => x.name.toLowerCase() === c.name.toLowerCase());
      if (existing >= 0) list.splice(existing, 1);
      list.push(c);
      saveConnectors(roomId);
      return c;
    } catch (err) {
      sessions.delete(c.id);
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastErr || new Error('Could not connect.');
}

export async function removeConnector(roomId: string, id: string): Promise<boolean> {
  const list = await getConnectors(roomId);
  const i = list.findIndex((c) => c.id === id);
  if (i < 0) return false;
  list.splice(i, 1);
  sessions.delete(id);
  saveConnectors(roomId);
  return true;
}

async function refreshConnector(roomId: string, c: Connector) {
  try {
    c.tools = await listTools(c);
    c.lastError = undefined;
  } catch (err) {
    c.lastError = err instanceof Error ? err.message : String(err);
  }
  c.refreshedAt = Date.now();
  saveConnectors(roomId);
}

function publicView(c: Connector) {
  return { id: c.id, name: c.name, host: c.host, hasKey: Boolean(c.auth), tools: c.tools.map((t) => ({ name: t.name, description: t.description.slice(0, 160) })), addedAt: c.addedAt, refreshedAt: c.refreshedAt, lastError: c.lastError || null };
}

/** Compact catalog for the system prompt (cached; empty until the room's connectors were loaded once). */
export function mcpCatalogExcerpt(roomId: string): string {
  const list = rooms.get(roomId);
  if (!list) {
    void getConnectors(roomId);
    return '';
  }
  return list
    .map((c) => `- ${c.name}: ${c.tools.slice(0, 25).map((t) => t.name).join(', ')}${c.tools.length > 25 ? ` (+${c.tools.length - 25} more)` : ''}`)
    .join('\n');
}

// --- routes ---------------------------------------------------------------------

export function registerConnectorRoutes(app: Express, requireRoomAuth: Parameters<Express['get']>[1]) {
  app.get('/api/mcp', requireRoomAuth, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const roomId = normalizeRoomId(String(req.query.room || 'RLY-HOME'));
    res.json({ connectors: (await getConnectors(roomId)).map(publicView) });
  });
  app.post('/api/mcp/add', requireRoomAuth, async (req, res) => {
    const b = req.body as { roomId?: string; name?: string; url?: string; token?: string };
    const roomId = normalizeRoomId(String(b.roomId || ''));
    try {
      const c = await addConnector(roomId, { name: b.name, url: String(b.url || ''), token: b.token });
      res.json({ ok: true, connector: publicView(c) });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
  app.post('/api/mcp/remove', requireRoomAuth, async (req, res) => {
    const b = req.body as { roomId?: string; id?: string };
    res.json({ ok: await removeConnector(normalizeRoomId(String(b.roomId || '')), String(b.id || '')) });
  });
  app.post('/api/mcp/refresh', requireRoomAuth, async (req, res) => {
    const b = req.body as { roomId?: string; id?: string };
    const roomId = normalizeRoomId(String(b.roomId || ''));
    const c = (await getConnectors(roomId)).find((x) => x.id === b.id);
    if (!c) return res.status(404).json({ ok: false });
    await refreshConnector(roomId, c);
    res.json({ ok: !c.lastError, connector: publicView(c) });
  });
}

// --- tools ----------------------------------------------------------------------

export const connectorToolDeclarations: FunctionDeclaration[] = [
  {
    name: 'mcp_servers',
    description:
      'List the external MCP servers Ray connected (JARVIS Core → Connectors) and their tools. Pass server (and optionally tool) to get the exact input schemas before calling mcp_call. Read-only.',
    parameters: {
      type: Type.OBJECT,
      properties: { server: { type: Type.STRING, description: 'Connector name for full tool schemas.' }, tool: { type: Type.STRING, description: 'One tool name.' } },
    },
  },
  {
    name: 'mcp_call',
    description:
      'Call a tool on one of Ray’s connected MCP servers (e.g. AgentPhone, CallForMe, n8n, a course server). argsJson must match the tool’s input schema (check mcp_servers first). Chain calls to finish the job. Tools that send, call, buy, post or delete need Ray’s approval — after approval pass any confirm flag the tool itself requires.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        server: { type: Type.STRING, description: 'Connector name.' },
        tool: { type: Type.STRING, description: 'Tool name on that server.' },
        argsJson: { type: Type.STRING, description: 'JSON object of arguments.' },
      },
      required: ['server', 'tool'],
    },
  },
];

const SENSITIVE = /(send|sms|message|call|dial|buy|purchase|pay|charge|transfer|order|delete|remove|destroy|drop|publish|post|tweet|email|invite|book|cancel|deploy|execute|run_workflow|trigger)/i;
const READ_NAME = /^(get|list|search|read|find|fetch|query|describe|check|lookup|show|view|count|status)/i;

function findTool(list: Connector[], server: string, tool: string): { c?: Connector; t?: McpToolInfo } {
  const s = server.trim().toLowerCase();
  const c = list.find((x) => x.name.toLowerCase() === s) || list.find((x) => x.name.toLowerCase().includes(s) || x.host.includes(s));
  const t = c?.tools.find((x) => x.name === tool) || c?.tools.find((x) => x.name.toLowerCase() === tool.trim().toLowerCase());
  return { c, t };
}

/** Policy hook: true when this mcp_call only reads (so it is allowed on questions too). */
export function isMcpReadOnlyCall(args: Record<string, unknown>): boolean {
  for (const list of rooms.values()) {
    const { t } = findTool(list, String(args.server || ''), String(args.tool || ''));
    if (t) return t.readOnly === true || (!t.destructive && READ_NAME.test(t.name) && !SENSITIVE.test(t.name));
  }
  return READ_NAME.test(String(args.tool || ''));
}

function formatContent(res: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const item of (res.content as Array<Record<string, unknown>>) || []) {
    if (item.type === 'text') parts.push(String(item.text));
    else if (item.type === 'resource' && item.resource) parts.push(JSON.stringify(item.resource).slice(0, 2000));
    else parts.push(`[${item.type}]`);
  }
  if (!parts.length && res.structuredContent) parts.push(JSON.stringify(res.structuredContent));
  const text = parts.join('\n').slice(0, 12000) || '(no content)';
  return res.isError ? `Tool error: ${text}` : text;
}

export async function executeConnectorTool(
  roomId: string,
  name: string,
  args: Record<string, unknown>,
  opts: { confirmed: boolean }
): Promise<{ result: string; confirmation?: ConfirmationRequest } | null> {
  if (name !== 'mcp_servers' && name !== 'mcp_call') return null;
  const list = await getConnectors(roomId);
  if (!list.length) return { result: 'No MCP servers connected. Ray can add one in JARVIS Core → Connectors (paste the server URL and key).' };

  if (name === 'mcp_servers') {
    if (!args.server) return { result: JSON.stringify(list.map(publicView)) };
    const { c } = findTool(list, String(args.server), '');
    if (!c) return { result: `No connector named "${args.server}". Connected: ${list.map((x) => x.name).join(', ')}` };
    const tools = args.tool ? c.tools.filter((t) => t.name === String(args.tool)) : c.tools;
    return { result: JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))).slice(0, 15000) };
  }

  const { c, t } = findTool(list, String(args.server || ''), String(args.tool || ''));
  if (!c) return { result: `No connector named "${args.server}". Connected: ${list.map((x) => x.name).join(', ')}` };
  if (!t) return { result: `"${c.name}" has no tool "${args.tool}". Tools: ${c.tools.map((x) => x.name).join(', ')}` };
  let callArgs: Record<string, unknown> = {};
  if (args.argsJson) {
    try {
      callArgs = typeof args.argsJson === 'string' ? (JSON.parse(args.argsJson) as Record<string, unknown>) : (args.argsJson as Record<string, unknown>);
    } catch {
      return { result: 'argsJson is not valid JSON.' };
    }
  }
  const sensitive = !t.readOnly && (t.destructive || SENSITIVE.test(t.name));
  if (sensitive && !opts.confirmed) {
    const req = createConfirmationRequest({
      roomId,
      toolName: name,
      safetyLevel: 'sensitive',
      summary: `${c.name} → ${t.name}(${JSON.stringify(callArgs).slice(0, 220)})`,
      targetDevice: c.name,
      args,
    });
    broadcastHudSound(roomId, 'alert');
    return { result: `REQUIRES_CONFIRMATION: ${c.name}.${t.name} acts for Ray — waiting for his Approve (confirmationId=${req.id}).`, confirmation: req };
  }
  try {
    const res = await rpc(c, 'tools/call', { name: t.name, arguments: callArgs }, 120000);
    return { result: formatContent(res) };
  } catch (err) {
    return { result: `${c.name}.${t.name} failed: ${err instanceof Error ? err.message : err}` };
  }
}
