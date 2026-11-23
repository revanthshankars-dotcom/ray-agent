import type { ToolCallEvent } from '../types/relay';
import { authFetch, getStoredRoomToken } from '../utils/roomAuth';

const LOCAL_BRIDGE_ORIGIN = 'http://127.0.0.1:17345';

export interface LocalBridgeHealth {
  ok: boolean;
  bridgeVersion?: string;
  deviceName?: string;
  roomId?: string;
  platform?: string;
  ollamaHost?: string;
  ollamaRunning?: boolean;
  ollamaModels?: string[];
  startupInstalled?: boolean;
  localPort?: number;
}

export interface LocalBridgeProbeResult {
  status: 'connected' | 'token_mismatch' | 'offline';
  health?: LocalBridgeHealth;
  statusRoomId?: string;
  ollamaRunning?: boolean;
  ollamaModels?: string[];
  startupInstalled?: boolean;
  error?: string;
}

export interface LocalBridgeRoot {
  id: string;
  label: string;
  path: string;
}

export interface LocalFileEntry {
  name: string;
  path: string;
  kind: 'dir' | 'file';
  sizeBytes: number;
  updatedAt: number;
  ext?: string;
}

export interface LocalFileSearchHit {
  name: string;
  path: string;
  kind: 'dir' | 'file';
  matchType: 'name' | 'content';
  snippet?: string;
}

export interface LocalFileContent {
  path: string;
  name: string;
  sizeBytes: number;
  totalLines: number;
  startLine: number;
  endLine: number;
  content: string;
}

interface LocalBridgeStatusMeta {
  roomId?: string;
  ollamaRunning?: boolean;
  ollamaModels?: string[];
  startupInstalled?: boolean;
}

export async function probeLocalDirectBridgeDetailed(roomId: string): Promise<LocalBridgeProbeResult> {
  const token = getStoredRoomToken(roomId);
  let statusMeta: LocalBridgeStatusMeta | null = null;

  try {
    const statusResp = await fetch(`${LOCAL_BRIDGE_ORIGIN}/status`, {
      signal: AbortSignal.timeout(950),
    });
    if (statusResp.ok) {
      statusMeta = (await statusResp.json().catch(() => null)) as LocalBridgeStatusMeta | null;
    } else if (statusResp.status === 404 || statusResp.status === 401) {
      const rootResp = await fetch(`${LOCAL_BRIDGE_ORIGIN}/`, {
        signal: AbortSignal.timeout(900),
      });
      if (rootResp.ok) {
        statusMeta = (await rootResp.json().catch(() => null)) as LocalBridgeStatusMeta | null;
      }
    }
  } catch {
    return { status: 'offline' };
  }

  if (!statusMeta) {
    // Try `/` in case of non-standard response
    try {
      const rootResp = await fetch(`${LOCAL_BRIDGE_ORIGIN}/`, { signal: AbortSignal.timeout(900) });
      if (!rootResp.ok) return { status: 'offline' };
      statusMeta = (await rootResp.json().catch(() => ({}))) as LocalBridgeStatusMeta;
    } catch {
      return { status: 'offline' };
    }
  }

  if (!token) {
    return {
      status: 'token_mismatch',
      statusRoomId: statusMeta?.roomId,
      ollamaRunning: statusMeta?.ollamaRunning,
      ollamaModels: statusMeta?.ollamaModels,
      startupInstalled: statusMeta?.startupInstalled,
      error: 'Bridge 127.0.0.1:17345 is running, waiting for room token synchronization.',
    };
  }

  try {
    const resp = await fetch(`${LOCAL_BRIDGE_ORIGIN}/health`, {
      headers: { 'X-Relay-Room-Token': token },
      signal: AbortSignal.timeout(950),
    });
    if (resp.status === 401) {
      return {
        status: 'token_mismatch',
        statusRoomId: statusMeta?.roomId,
        ollamaRunning: statusMeta?.ollamaRunning,
        ollamaModels: statusMeta?.ollamaModels,
        startupInstalled: statusMeta?.startupInstalled,
        error: `Local Bridge (127.0.0.1:17345) is running, but its room token does not match room ${roomId}. Run the --set-token command or re-download from Pair Device.`,
      };
    }
    if (!resp.ok) {
      return { status: 'offline' };
    }
    const health = (await resp.json()) as LocalBridgeHealth;
    if (!health.ok) return { status: 'offline' };
    return {
      status: 'connected',
      health,
      statusRoomId: health.roomId || statusMeta?.roomId,
      ollamaRunning: health.ollamaRunning ?? statusMeta?.ollamaRunning,
      ollamaModels: health.ollamaModels ?? statusMeta?.ollamaModels,
      startupInstalled: health.startupInstalled ?? statusMeta?.startupInstalled,
    };
  } catch {
    return { status: 'offline' };
  }
}

export async function probeLocalDirectBridge(roomId: string): Promise<LocalBridgeHealth | null> {
  const res = await probeLocalDirectBridgeDetailed(roomId);
  return res.status === 'connected' ? res.health || { ok: true } : null;
}

export async function forwardBridgeProxyActionToLocal(
  roomId: string,
  payload: Record<string, unknown>
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const token = getStoredRoomToken(roomId);
  if (!token) {
    return { ok: false, error: 'Missing local room token.' };
  }
  const action = String(payload.action || '');
  try {
    if (action === 'ollama_tags') {
      const qs = new URLSearchParams({ url: String(payload.ollamaUrl || 'http://127.0.0.1:11434') });
      const r = await fetch(`${LOCAL_BRIDGE_ORIGIN}/ollama/tags?${qs.toString()}`, {
        headers: { 'X-Relay-Room-Token': token },
        signal: AbortSignal.timeout(7000),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; raw?: unknown; models?: string[]; error?: string };
      return { ok: Boolean(r.ok && j.ok), data: j.raw ?? { models: (j.models || []).map((name) => ({ name })) }, error: j.error };
    }
    if (action === 'ollama_chat') {
      const r = await fetch(`${LOCAL_BRIDGE_ORIGIN}/ollama/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Relay-Room-Token': token },
        body: JSON.stringify({ ollamaUrl: payload.ollamaUrl, body: payload.body }),
        signal: AbortSignal.timeout(90000),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; data?: unknown; error?: string };
      return { ok: Boolean(r.ok && j.ok), data: j.data, error: j.error };
    }
    const r = await fetch(`${LOCAL_BRIDGE_ORIGIN}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Relay-Room-Token': token },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(14000),
    });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; data?: unknown; error?: string };
    return { ok: Boolean(r.ok && j.ok), data: j.data, error: j.error };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Local bridge unreachable' };
  }
}

async function runDirectOrServerCommand<T>(
  roomId: string,
  action: string,
  payload: Record<string, unknown>,
  serverEndpoint?: string
): Promise<{ ok: boolean; data?: T; via?: 'local-bridge' | 'server-ws'; error?: string }> {
  const token = getStoredRoomToken(roomId);
  if (token) {
    try {
      const resp = await fetch(`${LOCAL_BRIDGE_ORIGIN}/command`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Relay-Room-Token': token,
        },
        body: JSON.stringify({ action, ...payload }),
        signal: AbortSignal.timeout(8000),
      });
      const json = (await resp.json().catch(() => ({}))) as { ok?: boolean; data?: T; error?: string };
      if (resp.ok && json.ok) {
        return { ok: true, data: json.data, via: 'local-bridge' };
      }
      if (resp.status === 401) {
        return {
          ok: false,
          error: `Local Bridge token mismatch on 127.0.0.1:17345. Re-download relay-bridge-${roomId.toLowerCase()}.mjs from Pair Device -> Desktop OS Bridge.`,
        };
      }
      if (json.error) {
        return { ok: false, error: json.error };
      }
    } catch {
      // Fall back to server WS endpoint
    }
  }

  if (serverEndpoint) {
    try {
      const resp = await authFetch(serverEndpoint, roomId, {
        method: 'POST',
        body: JSON.stringify({ roomId, ...payload }),
      });
      const json = (await resp.json().catch(() => ({}))) as T & { error?: string };
      if (!resp.ok) {
        return { ok: false, error: (json as { error?: string }).error || `Request failed (${resp.status})` };
      }
      return { ok: true, data: json, via: 'server-ws' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Server fallback failed' };
    }
  }

  return { ok: false, error: 'Desktop OS Bridge not detected (127.0.0.1:17345 or WS mesh).' };
}

export function getLocalBridgeRoots(roomId: string) {
  return runDirectOrServerCommand<{ platform: string; hostname: string; roots: LocalBridgeRoot[] }>(
    roomId,
    'fs_list_roots',
    {},
    '/api/files/roots'
  );
}

export function listBridgeDirectory(roomId: string, dirPath = '') {
  return runDirectOrServerCommand<{ currentPath: string; parentPath: string; items: LocalFileEntry[] }>(
    roomId,
    'fs_list_dir',
    { dirPath, limit: 150 },
    '/api/files/list'
  );
}

export function readBridgeFile(roomId: string, filePath: string, startLine = 1, endLine = 400) {
  return runDirectOrServerCommand<LocalFileContent>(
    roomId,
    'fs_read_file',
    { filePath, startLine, endLine },
    '/api/files/read'
  );
}

export function searchBridgeFiles(roomId: string, query: string, dirPath?: string) {
  return runDirectOrServerCommand<{ query: string; results: LocalFileSearchHit[] }>(
    roomId,
    'fs_search_files',
    { query, dirPath },
    '/api/files/search'
  );
}

export function writeBridgeFile(roomId: string, filePath: string, content: string) {
  return runDirectOrServerCommand<{ path: string; saved: boolean; bytes: number }>(
    roomId,
    'fs_write_file',
    { filePath, content, confirmed: true },
    '/api/files/write'
  );
}

export function captureScreenViaLocalBridge(roomId: string) {
  return runDirectOrServerCommand<{ ok: boolean; dataUrl?: string; mimeType?: string }>(
    roomId,
    'screen_capture',
    {},
    '/api/screen/capture'
  );
}

export function getActiveWindowViaLocalBridge(roomId: string) {
  return runDirectOrServerCommand<{ activeWindow: string; telemetry: Record<string, unknown> }>(
    roomId,
    'active_window',
    {},
    '/api/system/window'
  );
}

export async function fetchLocalOllamaTags(
  roomId: string,
  ollamaUrl: string
): Promise<{ ok: boolean; via?: 'local-bridge' | 'direct-loopback'; models: string[]; error?: string }> {
  const token = getStoredRoomToken(roomId);
  const targetUrl = (ollamaUrl || 'http://127.0.0.1:11434').replace('://localhost', '://127.0.0.1');

  if (token) {
    try {
      const qs = new URLSearchParams({ url: targetUrl });
      const resp = await fetch(`${LOCAL_BRIDGE_ORIGIN}/ollama/tags?${qs.toString()}`, {
        headers: { 'X-Relay-Room-Token': token },
        signal: AbortSignal.timeout(4000),
      });
      const json = (await resp.json().catch(() => ({}))) as {
        ok?: boolean;
        models?: string[];
        error?: string;
      };
      if (resp.status === 401) {
        return {
          ok: false,
          models: [],
          error:
            `Local Bridge (127.0.0.1:17345) is running, but its room token is from an earlier session. Re-download relay-bridge-${roomId.toLowerCase()}.mjs from Pair Device → Desktop OS Bridge and restart node.`,
        };
      }
      if (resp.ok && json.ok) {
        return {
          ok: true,
          via: 'local-bridge',
          models: Array.isArray(json.models) ? json.models : [],
        };
      }
      if (json.error) {
        return { ok: false, models: [], error: json.error };
      }
    } catch {
      // Local direct bridge not running; try direct loopback below
    }
  }

  try {
    const resp = await fetch(`${targetUrl.replace(/\/+$/, '')}/api/tags`, {
      signal: AbortSignal.timeout(2500),
    });
    if (resp.ok) {
      const data = (await resp.json()) as { models?: Array<{ name?: string }> };
      const models = (data.models || []).map((m) => m.name || '').filter(Boolean);
      return { ok: true, via: 'direct-loopback', models };
    }
  } catch {
    // Browser cannot reach loopback Ollama directly
  }

  return {
    ok: false,
    models: [],
    error:
      'Local Desktop Bridge (127.0.0.1:17345) not detected. Download and run relay-bridge-' +
      roomId.toLowerCase() +
      '.mjs and ensure "ollama serve" is running.',
  };
}

const LOCAL_OLLAMA_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'open_application',
      description: 'Launch an application on Ray’s desktop computer (e.g., Brave, Chrome, Obsidian, Notion, VS Code, Terminal, Calculator).',
      parameters: {
        type: 'object',
        properties: {
          application: { type: 'string', description: 'Application name to open' },
        },
        required: ['application'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_url',
      description: 'Open a safe https:// URL in Ray’s desktop browser.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full URL starting with https://' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_system_telemetry',
      description: 'Read live CPU, RAM, uptime, and top process statistics from Ray’s desktop PC.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_system_files',
      description: 'List files inside Desktop, Documents, Downloads, or RAY Brain Vault on Ray’s PC.',
      parameters: {
        type: 'object',
        properties: {
          dirPath: { type: 'string', description: 'Root alias ("desktop", "documents", "downloads", "vault") or full folder path.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_system_files',
      description: 'Search filenames and text files inside Desktop, Documents, Downloads, and Vault.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search keyword or filename' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_system_file',
      description: 'Read UTF-8 text or code file contents from Desktop, Documents, Downloads, or Vault.',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Path to file' },
        },
        required: ['filePath'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_brain_note',
      description: 'Create or update a markdown note in Ray’s Obsidian Second Brain.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Note title' },
          folder: { type: 'string', description: 'Folder e.g. Projects, Knowledge, Journal' },
          content: { type: 'string', description: 'Markdown body' },
        },
        required: ['title', 'content'],
      },
    },
  },
];

async function executeLocalBridgeTool(
  roomId: string,
  via: 'local-bridge' | 'direct-loopback',
  toolName: string,
  args: Record<string, unknown>
): Promise<string> {
  const token = getStoredRoomToken(roomId);

  if (toolName === 'create_brain_note') {
    const title = String(args.title || 'Untitled Note').trim();
    const folder = String(args.folder || 'Inbox').trim();
    const content = String(args.content || '');
    const resp = await authFetch('/api/brain/notes', roomId, {
      method: 'POST',
      body: JSON.stringify({
        roomId,
        note: {
          title,
          folder,
          content,
          tags: ['ray', 'ollama'],
        },
      }),
    });
    const data = (await resp.json().catch(() => ({}))) as { note?: { title?: string }; error?: string };
    return resp.ok ? `Saved note "${data.note?.title || title}" to Second Brain (${folder}).` : data.error || 'Failed to save note.';
  }

  if (via !== 'local-bridge') {
    return `Action ${toolName} requires the Desktop OS Bridge (node relay-bridge-${roomId.toLowerCase()}.mjs) to be running.`;
  }

  let action = toolName;
  let payload: Record<string, unknown> = { ...args };
  if (toolName === 'open_application') {
    action = 'open_app';
    payload = { target: args.application || args.target || '' };
  } else if (toolName === 'get_system_telemetry') {
    action = 'system_info';
  } else if (toolName === 'list_system_files') {
    action = 'fs_list_dir';
    payload = { dirPath: args.dirPath || 'desktop', limit: 100 };
  } else if (toolName === 'search_system_files') {
    action = 'fs_search_files';
    payload = { query: args.query || '' };
  } else if (toolName === 'read_system_file') {
    action = 'fs_read_file';
    payload = { filePath: args.filePath || '' };
  }

  const resp = await fetch(`${LOCAL_BRIDGE_ORIGIN}/command`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Relay-Room-Token': token,
    },
    body: JSON.stringify({ action, ...payload }),
  });
  const out = (await resp.json().catch(() => ({}))) as { ok?: boolean; data?: unknown; error?: string };
  if (!out.ok) return out.error || `Local bridge failed for ${toolName}`;
  return typeof out.data === 'string' ? out.data : JSON.stringify(out.data);
}

export async function runLocalOllamaChatViaBridge(input: {
  roomId: string;
  userName: string;
  ollamaUrl: string;
  model: string;
  message: string;
  history: Array<{ role: 'user' | 'assistant'; text: string }>;
  attachments: Array<{ mimeType: string; dataBase64: string }>;
  onToolEvent: (ev: ToolCallEvent, finished: boolean) => void;
  onText: (text: string) => void;
}): Promise<boolean> {
  const token = getStoredRoomToken(input.roomId);
  const safeOrigin = (input.ollamaUrl || 'http://127.0.0.1:11434').replace('://localhost', '://127.0.0.1').replace(/\/+$/, '');

  const bridgeAlive = await probeLocalDirectBridge(input.roomId);
  let via: 'local-bridge' | 'direct-loopback' | null = bridgeAlive ? 'local-bridge' : null;

  if (!via) {
    try {
      const ping = await fetch(`${safeOrigin}/api/tags`, { signal: AbortSignal.timeout(1200) });
      if (ping.ok) via = 'direct-loopback';
    } catch {
      via = null;
    }
  }

  if (!via) return false;

  const messages: Array<Record<string, unknown>> = [
    {
      role: 'system',
      content: `You are RAY, ${input.userName}'s loyal, calm, witty personal AI assistant & systems engineer inspired by J.A.R.V.I.S., running locally via Ollama (${input.model}). Address the user naturally as Ray (or Revanth). Be crisp, accurate, and practical.`,
    },
    ...input.history.slice(-10).map((h) => ({
      role: h.role === 'assistant' ? 'assistant' : 'user',
      content: h.text,
    })),
    {
      role: 'user',
      content: input.message,
      ...(input.attachments.some((a) => a.mimeType.startsWith('image/'))
        ? {
            images: input.attachments.filter((a) => a.mimeType.startsWith('image/')).map((a) => a.dataBase64),
          }
        : {}),
    },
  ];

  const callChat = async (withTools: boolean) => {
    const body = {
      model: input.model,
      messages,
      stream: false,
      ...(withTools ? { tools: LOCAL_OLLAMA_TOOLS } : {}),
    };

    if (via === 'local-bridge') {
      const resp = await fetch(`${LOCAL_BRIDGE_ORIGIN}/ollama/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Relay-Room-Token': token,
        },
        body: JSON.stringify({ ollamaUrl: safeOrigin, body }),
      });
      const wrapped = (await resp.json()) as {
        ok?: boolean;
        data?: { message?: { content?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: Record<string, unknown> } }> } };
        error?: string;
      };
      if (!resp.ok || !wrapped.ok) {
        throw new Error(wrapped.error || `Local Ollama error (${resp.status})`);
      }
      return wrapped.data || {};
    }

    const resp = await fetch(`${safeOrigin}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw new Error(`Direct Ollama error (${resp.status})`);
    }
    return (await resp.json()) as {
      message?: { content?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: Record<string, unknown> } }> };
    };
  };

  for (let round = 0; round < 3; round++) {
    let data;
    try {
      data = await callChat(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/does not support tools|400|502|tool/i.test(msg)) {
        data = await callChat(false);
      } else {
        throw err;
      }
    }

    const toolCalls = data.message?.tool_calls || [];
    if (toolCalls.length === 0) {
      input.onText((data.message?.content || '').trim() || `Standing by, ${input.userName}. (${input.model})`);
      return true;
    }

    messages.push({
      role: 'assistant',
      content: data.message?.content || '',
      tool_calls: toolCalls,
    });

    for (const tc of toolCalls) {
      const name = tc.function?.name || 'unknown_tool';
      const args = (tc.function?.arguments || {}) as Record<string, unknown>;
      const callEv: ToolCallEvent = {
        id: `${name}-${Date.now()}`,
        name,
        args,
        status: 'running',
      };
      input.onToolEvent(callEv, false);

      let result = '';
      try {
        result = await executeLocalBridgeTool(input.roomId, via, name, args);
        callEv.status = 'completed';
        callEv.result = result;
      } catch (err) {
        result = err instanceof Error ? err.message : String(err);
        callEv.status = 'error';
        callEv.result = result;
      }
      input.onToolEvent(callEv, true);

      messages.push({
        role: 'tool',
        content: result,
      });
    }
  }

  input.onText(`Local Ollama (${input.model}) completed your request, ${input.userName}.`);
  return true;
}
