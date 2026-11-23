import crypto from 'crypto';
import type { TaskAnalysisResult, TaskCategory, TaskPriority } from '../src/types/relay.ts';
import { getRoomSnapshot, isRoomInterrupted, setRoomInterrupted } from './hub.ts';
import { sanitizeErrorMessage } from './security.ts';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export const CURATED_OPENROUTER_MODELS = [
  'openrouter/free',
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nvidia/nemotron-3.5-super-vl:free',
  'nvidia/nemotron-3.5-lightning:free',
  'anthropic/claude-3.5-sonnet',
  'openai/gpt-4o-mini',
];

function getOpenRouterApiKey(): string {
  return (process.env.OPENROUTER_API_KEY || '').trim();
}

export function hasOpenRouterConfigured(): boolean {
  return Boolean(getOpenRouterApiKey());
}

export async function fetchOpenRouterModels(): Promise<{
  ok: boolean;
  hasKey: boolean;
  models: string[];
  error?: string;
}> {
  const hasKey = hasOpenRouterConfigured();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    const resp = await fetch(`${OPENROUTER_BASE_URL}/models`, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
      },
    });
    clearTimeout(timer);

    if (!resp.ok) {
      return {
        ok: true,
        hasKey,
        models: CURATED_OPENROUTER_MODELS,
        error: `OpenRouter catalog returned HTTP ${resp.status}; using curated list.`,
      };
    }

    const json = (await resp.json()) as {
      data?: Array<{ id?: string; pricing?: { prompt?: string; completion?: string } }>;
    };
    const remote = (json.data || [])
      .map((m) => m.id || '')
      .filter(Boolean);

    const freeModels = remote.filter((id) => id === 'openrouter/free' || id.endsWith(':free'));
    const sortedFree = [
      ...(freeModels.includes('openrouter/free') ? ['openrouter/free'] : []),
      ...freeModels.filter((id) => id !== 'openrouter/free'),
    ].slice(0, 30);
    const merged = Array.from(new Set([...sortedFree, ...remote.slice(0, 30)])).slice(0, 60);

    return {
      ok: true,
      hasKey,
      models: merged.length > 0 ? merged : CURATED_OPENROUTER_MODELS,
    };
  } catch (err) {
    return {
      ok: true,
      hasKey,
      models: CURATED_OPENROUTER_MODELS,
      error: `Using curated OpenRouter list (${sanitizeErrorMessage(err)}).`,
    };
  }
}

interface OpenRouterChoiceMessage {
  role?: string;
  content?: string | null;
  tool_calls?: Array<{
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

async function callOpenRouterCompletions(body: Record<string, unknown>): Promise<{
  choices?: Array<{ message?: OpenRouterChoiceMessage }>;
  error?: { message?: string };
}> {
  const apiKey = getOpenRouterApiKey();
  if (!apiKey) {
    throw new Error(
      'OPENROUTER_API_KEY is not configured on the server. Add OPENROUTER_API_KEY in AI Studio Secrets or your .env file.'
    );
  }

  const referer = process.env.APP_URL || 'http://localhost:3000';
  const sendRequest = async (reqBody: Record<string, unknown>) => {
    const resp = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(25000),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': referer,
        'X-Title': 'RAY Relay',
      },
      body: JSON.stringify(reqBody),
    });
    const payload = (await resp.json().catch(() => ({}))) as {
      choices?: Array<{ message?: OpenRouterChoiceMessage }>;
      error?: { message?: string; code?: number };
    };
    return { resp, payload };
  };

  const { resp, payload } = await sendRequest(body);
  const payloadErr = payload?.error?.message;

  if (!resp.ok || payloadErr) {
    const errMsg = payloadErr || `OpenRouter API error (${resp.status})`;
    const requestedModel = String(body.model || '');
    const shouldTryAutoFree =
      requestedModel !== 'openrouter/free' &&
      (resp.status === 404 ||
        resp.status === 429 ||
        resp.status >= 500 ||
        /unavailable for free|no endpoints|not found|is not a valid model|provider returned error|rate/i.test(errMsg));

    if (shouldTryAutoFree) {
      const { resp: retryResp, payload: retryPayload } = await sendRequest({
        ...body,
        model: 'openrouter/free',
      });
      if (retryResp.ok && !retryPayload?.error?.message) {
        return retryPayload;
      }
      if (body.tools) {
        const { tools: _t, tool_choice: _tc, ...noToolsBody } = body;
        const { resp: plainResp, payload: plainPayload } = await sendRequest({
          ...noToolsBody,
          model: 'openrouter/free',
        });
        if (plainResp.ok && !plainPayload?.error?.message) {
          return plainPayload;
        }
      }
    }
    throw new Error(errMsg);
  }

  return payload;
}

export async function runOpenRouterChatTurn(input: {
  roomId: string;
  sourceDeviceName: string;
  targetDeviceHint?: string;
  message: string;
  history: Array<{ role: 'user' | 'assistant'; text: string }>;
  attachments?: Array<{ mimeType: string; dataBase64: string }>;
  openrouterModel: string;
  systemInstruction: string;
  tools: Array<{
    type: 'function';
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }>;
  executeTool: (name: string, args: Record<string, unknown>) => Promise<{ result: string; confirmation?: unknown }>;
  onEvent: (event: { type: string; data: unknown }) => void;
}): Promise<void> {
  setRoomInterrupted(input.roomId, false);
  const model = (input.openrouterModel || CURATED_OPENROUTER_MODELS[0]).trim();

  const messages: Array<Record<string, unknown>> = [
    { role: 'system', content: input.systemInstruction },
    ...input.history.slice(-10).map((h) => ({
      role: h.role === 'assistant' ? 'assistant' : 'user',
      content: h.text,
    })),
  ];

  const imageAttachments = (input.attachments || []).filter((a) => a.mimeType.startsWith('image/'));
  if (imageAttachments.length > 0) {
    const contentParts: Array<Record<string, unknown>> = [
      { type: 'text', text: input.message || 'Analyze the attached screen or image.' },
      ...imageAttachments.map((img) => ({
        type: 'image_url',
        image_url: {
          url: `data:${img.mimeType};base64,${img.dataBase64}`,
        },
      })),
    ];
    messages.push({ role: 'user', content: contentParts });
  } else {
    messages.push({ role: 'user', content: input.message || 'Please assist.' });
  }

  const toolLogs: Array<Record<string, unknown>> = [];

  for (let round = 0; round < 4; round++) {
    if (isRoomInterrupted(input.roomId)) {
      input.onEvent({ type: 'text', data: 'Standing down, Ray. OpenRouter execution halted.' });
      input.onEvent({ type: 'done', data: { toolCalls: toolLogs, sources: [] } });
      return;
    }

    let data;
    try {
      data = await callOpenRouterCompletions({
        model,
        messages,
        tools: input.tools,
        tool_choice: 'auto',
      });
    } catch (err) {
      const msg = sanitizeErrorMessage(err);
      if (/tool|function|404|400|502|unsupported|schema|provider returned error/i.test(msg)) {
        data = await callOpenRouterCompletions({
          model,
          messages,
        });
      } else {
        throw err;
      }
    }

    const assistantMsg = data.choices?.[0]?.message || {};
    const toolCalls = assistantMsg.tool_calls || [];

    if (toolCalls.length === 0) {
      const reply = (assistantMsg.content || '').trim() || `Standing by, Ray. (${model})`;
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
      let args: Record<string, unknown> = {};
      try {
        args = tc.function?.arguments ? (JSON.parse(tc.function.arguments) as Record<string, unknown>) : {};
      } catch {
        args = {};
      }

      const callId = tc.id || `${toolName}-${Date.now()}`;
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
        tool_call_id: callId,
        content: resultStr,
      });
    }
  }

  input.onEvent({ type: 'text', data: `OpenRouter model ${model} finished executing your requests, Ray.` });
  input.onEvent({ type: 'done', data: { toolCalls: toolLogs, sources: [] } });
}

export async function analyzeTaskGoalWithOpenRouter(params: {
  roomId: string;
  goal: string;
  openrouterModel: string;
}): Promise<TaskAnalysisResult> {
  const snapshot = getRoomSnapshot(params.roomId);
  const deviceList =
    snapshot.devices.map((d) => `${d.name} (${d.type}, os=${d.os}, online=${d.online})`).join('; ') || 'Web Workstation';

  const res = await callOpenRouterCompletions({
    model: (params.openrouterModel || CURATED_OPENROUTER_MODELS[0]).trim(),
    messages: [
      {
        role: 'system',
        content:
          'You are RAY. Output strictly valid JSON (no markdown fences) matching {category, priority, effortMinutes, recommendedDevice, safetyLevel, summary, blockers, subtasks, executableSteps}.',
      },
      {
        role: 'user',
        content: `Analyze Ray's task: "${params.goal}"\nConnected devices: ${deviceList}\ncategory must be one of: coding, system, research, personal, workflow, general\npriority: critical, high, medium, low\nsafetyLevel: safe, moderate, sensitive`,
      },
    ],
  });

  const rawContent = (res.choices?.[0]?.message?.content || '{}').trim();
  const stripped = rawContent.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  let parsed: Partial<TaskAnalysisResult> = {};
  try {
    parsed = JSON.parse(stripped) as Partial<TaskAnalysisResult>;
  } catch {
    parsed = { summary: rawContent || 'OpenRouter analysis complete.' };
  }

  const validCategories: TaskCategory[] = ['coding', 'system', 'research', 'personal', 'workflow', 'general'];
  const validPriorities: TaskPriority[] = ['critical', 'high', 'medium', 'low'];

  return {
    id: `analysis_${crypto.randomUUID().slice(0, 12)}`,
    goal: params.goal.trim().slice(0, 600),
    category: validCategories.includes(parsed.category as TaskCategory) ? (parsed.category as TaskCategory) : 'general',
    priority: validPriorities.includes(parsed.priority as TaskPriority) ? (parsed.priority as TaskPriority) : 'medium',
    effortMinutes: Math.max(1, Math.min(2400, Math.round(Number(parsed.effortMinutes || 20)))),
    recommendedDevice: (parsed.recommendedDevice || 'Web Workstation').slice(0, 100),
    safetyLevel: parsed.safetyLevel === 'sensitive' || parsed.safetyLevel === 'moderate' ? parsed.safetyLevel : 'safe',
    summary: (parsed.summary || 'OpenRouter task analysis complete.').slice(0, 1500),
    blockers: Array.isArray(parsed.blockers) ? parsed.blockers.slice(0, 12).map((b) => String(b).slice(0, 300)) : [],
    subtasks: Array.isArray(parsed.subtasks) ? parsed.subtasks.slice(0, 15).map((s) => String(s).slice(0, 240)) : [],
    executableSteps: Array.isArray(parsed.executableSteps) ? parsed.executableSteps.slice(0, 10) : [],
    createdAt: Date.now(),
  };
}
