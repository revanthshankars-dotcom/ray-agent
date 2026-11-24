import crypto from 'crypto';
import type { TaskAnalysisResult, TaskCategory, TaskPriority } from '../src/types/relay.ts';
import { dispatchBridgeProxyCall, getRoomSnapshot, isRoomInterrupted, setRoomInterrupted } from './hub.ts';
import { sanitizeErrorMessage } from './security.ts';

function assertLocalOllamaUrl(raw?: string): string {
  const candidate = (raw || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').trim().replace(/\/+$/, '');
  const parsed = new URL(candidate);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Ollama URL must use http:// or https://');
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host !== '127.0.0.1' &&
    host !== 'localhost' &&
    host !== 'host.docker.internal' &&
    !host.startsWith('192.168.') &&
    !host.startsWith('10.')
  ) {
    throw new Error('Ollama URL must point to localhost or a local LAN host.');
  }
  return parsed.origin;
}

export async function fetchOllamaModels(params: {
  roomId: string;
  ollamaUrl?: string;
  useBridgeProxy?: boolean;
}): Promise<{ ok: boolean; models: string[]; source: 'direct' | 'bridge'; error?: string }> {
  const safeUrl = assertLocalOllamaUrl(params.ollamaUrl);

  if (params.useBridgeProxy) {
    const proxyRes = await dispatchBridgeProxyCall(
      params.roomId,
      { action: 'ollama_tags', ollamaUrl: safeUrl },
      8000
    );
    if (!proxyRes.ok) {
      return { ok: false, models: [], source: 'bridge', error: proxyRes.error || 'Bridge Ollama proxy failed' };
    }
    const payload = proxyRes.data as { models?: Array<{ name: string }> };
    return {
      ok: true,
      models: (payload?.models || []).map((m) => m.name),
      source: 'bridge',
    };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(`${safeUrl}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    if (!resp.ok) {
      return { ok: false, models: [], source: 'direct', error: `Ollama returned HTTP ${resp.status}` };
    }
    const json = (await resp.json()) as { models?: Array<{ name: string }> };
    return {
      ok: true,
      models: (json.models || []).map((m) => m.name),
      source: 'direct',
    };
  } catch (err) {
    // The RAY server usually runs in the cloud, where 127.0.0.1 is NOT your PC.
    // Transparently route through the Desktop/Android bridge that runs next to Ollama.
    const viaBridge = await dispatchBridgeProxyCall(params.roomId, { action: 'ollama_tags', ollamaUrl: safeUrl }, 8000);
    if (viaBridge.ok) {
      const payload = viaBridge.data as { models?: Array<{ name: string }> };
      return { ok: true, models: (payload?.models || []).map((m) => m.name), source: 'bridge' };
    }
    return {
      ok: false,
      models: [],
      source: 'direct',
      error: `Cannot reach Ollama at ${safeUrl}: ${sanitizeErrorMessage(err)}. Start Ollama locally or toggle Desktop Bridge Proxy.`,
    };
  }
}

async function callOllamaChat(params: {
  roomId: string;
  ollamaUrl?: string;
  useBridgeProxy?: boolean;
  autoBridgeFallback?: boolean;
  body: Record<string, unknown>;
}): Promise<{ message?: { role?: string; content?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: Record<string, unknown> } }> } }> {
  const safeUrl = assertLocalOllamaUrl(params.ollamaUrl);

  if (params.useBridgeProxy) {
    const proxyRes = await dispatchBridgeProxyCall(
      params.roomId,
      { action: 'ollama_chat', ollamaUrl: safeUrl, body: params.body },
      175000
    );
    if (!proxyRes.ok) {
      throw new Error(proxyRes.error || 'Bridge Ollama chat failed');
    }
    return proxyRes.data as {
      message?: {
        role?: string;
        content?: string;
        tool_calls?: Array<{ function?: { name?: string; arguments?: Record<string, unknown> } }>;
      };
    };
  }

  if (params.autoBridgeFallback) {
    // The RAY server usually runs in the cloud where 127.0.0.1 is not your PC:
    // probe quickly, and route through the bridge that sits next to Ollama if unreachable.
    const reachable = await fetch(`${safeUrl}/api/tags`, { signal: AbortSignal.timeout(1500) })
      .then((r) => r.ok)
      .catch(() => false);
    if (!reachable) {
      return callOllamaChat({ ...params, useBridgeProxy: true, autoBridgeFallback: false });
    }
  }
  const resp = await fetch(`${safeUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params.body),
    signal: AbortSignal.timeout(180000),
  });
  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');
    throw new Error(`Ollama API error (${resp.status}): ${errBody.slice(0, 200)}`);
  }
  return (await resp.json()) as {
    message?: {
      role?: string;
      content?: string;
      tool_calls?: Array<{ function?: { name?: string; arguments?: Record<string, unknown> } }>;
    };
  };
}

export async function runOllamaChatTurn(input: {
  roomId: string;
  sourceDeviceName: string;
  targetDeviceHint?: string;
  message: string;
  history: Array<{ role: 'user' | 'assistant'; text: string }>;
  attachments?: Array<{ mimeType: string; dataBase64: string }>;
  ollamaUrl?: string;
  ollamaModel: string;
  useBridgeProxy?: boolean;
  autoBridgeFallback?: boolean;
  systemInstruction: string;
  ollamaTools: Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }>;
  executeTool: (name: string, args: Record<string, unknown>) => Promise<{ result: string; confirmation?: unknown }>;
  onEvent: (event: { type: string; data: unknown }) => void;
}): Promise<void> {
  setRoomInterrupted(input.roomId, false);
  const model = (input.ollamaModel || 'llama3.2').trim();

  const messages: Array<Record<string, unknown>> = [
    { role: 'system', content: input.systemInstruction },
    ...input.history.slice(-10).map((h) => ({
      role: h.role === 'assistant' ? 'assistant' : 'user',
      content: h.text,
    })),
  ];

  const userMsg: Record<string, unknown> = {
    role: 'user',
    content: input.message || 'Please assist.',
  };
  if (input.attachments && input.attachments.length > 0) {
    const imgs = input.attachments
      .filter((a) => a.mimeType.startsWith('image/'))
      .map((a) => a.dataBase64);
    if (imgs.length > 0) {
      userMsg.images = imgs;
    }
  }
  messages.push(userMsg);

  const toolLogs: Array<Record<string, unknown>> = [];

  for (let round = 0; round < 4; round++) {
    if (isRoomInterrupted(input.roomId)) {
      input.onEvent({ type: 'text', data: 'Standing down, Ray. Local Ollama execution halted.' });
      input.onEvent({ type: 'done', data: { toolCalls: toolLogs, sources: [] } });
      return;
    }

    let data;
    try {
      data = await callOllamaChat({
        roomId: input.roomId,
        ollamaUrl: input.ollamaUrl,
        useBridgeProxy: input.useBridgeProxy,
        autoBridgeFallback: input.autoBridgeFallback ?? !input.useBridgeProxy,
        body: {
          model,
          stream: false,
          messages,
          tools: input.ollamaTools,
        },
      });
    } catch (err) {
      // Fallback without tools in case the selected local Ollama model doesn't support native tool calling
      // A 400 means Ollama rejected the request itself (model can't do tools or images, bad tool schema,
      // older bridges hide the reason). Retry without tools and images instead of failing.
      const msg = sanitizeErrorMessage(err);
      if (/does not support|returned 400|\(400\)|invalid|unmarshal|images?/i.test(msg)) {
        const plain = messages.map((m) => {
          const { images: _drop, ...rest } = m as Record<string, unknown> & { images?: unknown };
          return rest;
        });
        data = await callOllamaChat({
          roomId: input.roomId,
          ollamaUrl: input.ollamaUrl,
          useBridgeProxy: input.useBridgeProxy,
          autoBridgeFallback: input.autoBridgeFallback ?? !input.useBridgeProxy,
          body: { model, stream: false, messages: plain },
        });
      } else {
        throw err;
      }
    }

    const assistantMsg = data.message || {};
    const toolCalls = assistantMsg.tool_calls || [];

    if (toolCalls.length === 0) {
      const reply = (assistantMsg.content || '').trim() || `Standing by, Ray. (Local ${model})`;
      input.onEvent({ type: 'text', data: reply });
      input.onEvent({ type: 'done', data: { toolCalls: toolLogs, sources: [] } });
      return;
    }

    messages.push({
      role: 'assistant',
      content: assistantMsg.content || '',
      tool_calls: toolCalls,
    });

    for (const tc of toolCalls) {
      const toolName = tc.function?.name || 'unknown_tool';
      const args = (tc.function?.arguments || {}) as Record<string, unknown>;
      const callId = `${toolName}-${Date.now()}`;
      const logEntry: Record<string, unknown> = {
        id: callId,
        name: toolName,
        args,
        status: 'running',
      };
      toolLogs.push(logEntry);
      input.onEvent({ type: 'tool_start', data: logEntry });

      let resultStr = '';
      try {
        const execOut = await input.executeTool(toolName, args);
        resultStr = execOut.result;
        if (execOut.confirmation) {
          logEntry.status = 'awaiting_confirmation';
          logEntry.result = resultStr;
          input.onEvent({ type: 'confirmation_required', data: execOut.confirmation });
        } else {
          logEntry.status = 'completed';
          logEntry.result = resultStr;
        }
      } catch (err) {
        resultStr = sanitizeErrorMessage(err);
        logEntry.status = 'error';
        logEntry.result = resultStr;
      }
      input.onEvent({ type: 'tool_end', data: logEntry });

      messages.push({
        role: 'tool',
        content: resultStr,
      });
    }
  }

  input.onEvent({ type: 'text', data: `Local model ${model} finished executing your requests, Ray.` });
  input.onEvent({ type: 'done', data: { toolCalls: toolLogs, sources: [] } });
}

export async function analyzeTaskGoalWithOllama(params: {
  roomId: string;
  goal: string;
  ollamaUrl?: string;
  ollamaModel: string;
  useBridgeProxy?: boolean;
}): Promise<TaskAnalysisResult> {
  const snapshot = getRoomSnapshot(params.roomId);
  const deviceList =
    snapshot.devices.map((d) => `${d.name} (${d.type}, os=${d.os}, online=${d.online})`).join('; ') || 'Local Workstation';

  const res = await callOllamaChat({
    roomId: params.roomId,
    ollamaUrl: params.ollamaUrl,
    useBridgeProxy: params.useBridgeProxy,
    body: {
      model: (params.ollamaModel || 'llama3.2').trim(),
      stream: false,
      format: 'json',
      messages: [
        {
          role: 'system',
          content:
            'You are RAY. Output strictly valid JSON matching {category, priority, effortMinutes, recommendedDevice, safetyLevel, summary, blockers, subtasks, executableSteps}.',
        },
        {
          role: 'user',
          content: `Analyze Ray's task: "${params.goal}"\nConnected devices: ${deviceList}\ncategory must be one of: coding, system, research, personal, workflow, general\npriority: critical, high, medium, low\nsafetyLevel: safe, moderate, sensitive`,
        },
      ],
    },
  });

  let parsed: Partial<TaskAnalysisResult> = {};
  try {
    parsed = JSON.parse(res.message?.content || '{}') as Partial<TaskAnalysisResult>;
  } catch {
    parsed = { summary: res.message?.content || 'Local analysis complete.' };
  }

  const validCategories: TaskCategory[] = ['coding', 'system', 'research', 'personal', 'workflow', 'general'];
  const validPriorities: TaskPriority[] = ['critical', 'high', 'medium', 'low'];

  return {
    id: `analysis_${crypto.randomUUID().slice(0, 12)}`,
    goal: params.goal.trim().slice(0, 600),
    category: validCategories.includes(parsed.category as TaskCategory) ? (parsed.category as TaskCategory) : 'general',
    priority: validPriorities.includes(parsed.priority as TaskPriority) ? (parsed.priority as TaskPriority) : 'medium',
    effortMinutes: Math.max(1, Math.min(2400, Math.round(Number(parsed.effortMinutes || 20)))),
    recommendedDevice: (parsed.recommendedDevice || 'Local Workstation').slice(0, 100),
    safetyLevel: parsed.safetyLevel === 'sensitive' || parsed.safetyLevel === 'moderate' ? parsed.safetyLevel : 'safe',
    summary: (parsed.summary || 'Offline local analysis complete.').slice(0, 1500),
    blockers: Array.isArray(parsed.blockers) ? parsed.blockers.slice(0, 12).map((b) => String(b).slice(0, 300)) : [],
    subtasks: Array.isArray(parsed.subtasks) ? parsed.subtasks.slice(0, 15).map((s) => String(s).slice(0, 240)) : [],
    executableSteps: Array.isArray(parsed.executableSteps) ? parsed.executableSteps.slice(0, 10) : [],
    createdAt: Date.now(),
  };
}
