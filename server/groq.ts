import crypto from 'crypto';
import type { TaskAnalysisResult, TaskCategory, TaskPriority } from '../src/types/relay.ts';
import { getRoomSnapshot, isRoomInterrupted, setRoomInterrupted } from './hub.ts';
import { sanitizeErrorMessage } from './security.ts';

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

export const CURATED_GROQ_MODELS = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'mixtral-8x7b-32768',
  'gemma2-9b-it',
];

function getGroqApiKey(): string {
  return (process.env.GROQ_API_KEY || '').trim();
}

export function hasGroqConfigured(): boolean {
  return Boolean(getGroqApiKey());
}

export async function fetchGroqModels(): Promise<{
  ok: boolean;
  hasKey: boolean;
  models: string[];
  error?: string;
}> {
  const hasKey = hasGroqConfigured();
  if (!hasKey) {
    return {
      ok: true,
      hasKey: false,
      models: CURATED_GROQ_MODELS,
      error: 'GROQ_API_KEY not configured; using curated Groq free tier models.',
    };
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    const resp = await fetch(`${GROQ_BASE_URL}/models`, {
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${getGroqApiKey()}`,
        Accept: 'application/json',
      },
    });
    clearTimeout(timer);

    if (!resp.ok) {
      return {
        ok: true,
        hasKey,
        models: CURATED_GROQ_MODELS,
        error: `Groq models returned HTTP ${resp.status}; using curated list.`,
      };
    }

    const json = (await resp.json()) as { data?: Array<{ id?: string }> };
    const remote = (json.data || []).map((m) => m.id || '').filter(Boolean);
    return {
      ok: true,
      hasKey,
      models: remote.length > 0 ? remote : CURATED_GROQ_MODELS,
    };
  } catch (err) {
    return {
      ok: true,
      hasKey,
      models: CURATED_GROQ_MODELS,
      error: `Using curated Groq list (${sanitizeErrorMessage(err)}).`,
    };
  }
}

interface GroqChoiceMessage {
  role?: string;
  content?: string | null;
  tool_calls?: Array<{
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

async function callGroqCompletions(body: Record<string, unknown>): Promise<{
  choices?: Array<{ message?: GroqChoiceMessage }>;
  error?: { message?: string };
}> {
  const apiKey = getGroqApiKey();
  if (!apiKey) {
    throw new Error(
      'GROQ_API_KEY is not configured on the server. Add GROQ_API_KEY in AI Studio Secrets or your .env file.'
    );
  }

  const resp = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(25000),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const payload = (await resp.json().catch(() => ({}))) as {
    choices?: Array<{ message?: GroqChoiceMessage }>;
    error?: { message?: string };
  };

  if (!resp.ok || payload?.error?.message) {
    throw new Error(payload?.error?.message || `Groq API error (${resp.status})`);
  }

  return payload;
}

export async function runGroqChatTurn(input: {
  roomId: string;
  sourceDeviceName: string;
  targetDeviceHint?: string;
  message: string;
  history: Array<{ role: 'user' | 'assistant'; text: string }>;
  attachments?: Array<{ mimeType: string; dataBase64: string }>;
  groqModel: string;
  systemInstruction: string;
  tools: Array<{
    type: 'function';
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }>;
  executeTool: (name: string, args: Record<string, unknown>) => Promise<{ result: string; confirmation?: unknown }>;
  onEvent: (event: { type: string; data: unknown }) => void;
}): Promise<void> {
  setRoomInterrupted(input.roomId, false);
  const model = (input.groqModel || CURATED_GROQ_MODELS[0]).trim();

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
      { type: 'text', text: input.message || 'Analyze the attached image.' },
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
      input.onEvent({ type: 'text', data: 'Standing down, Ray. Groq execution halted.' });
      input.onEvent({ type: 'done', data: { toolCalls: toolLogs, sources: [] } });
      return;
    }

    let data;
    try {
      data = await callGroqCompletions({
        model,
        messages,
        tools: input.tools,
        tool_choice: 'auto',
      });
    } catch (err) {
      const msg = sanitizeErrorMessage(err);
      if (/tool|function|404|400|502|unsupported|schema/i.test(msg)) {
        data = await callGroqCompletions({
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
      const reply = (assistantMsg.content || '').trim() || `Standing by, Ray via Groq (${model}).`;
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

  input.onEvent({ type: 'text', data: `Groq model ${model} finished executing your requests, Ray.` });
  input.onEvent({ type: 'done', data: { toolCalls: toolLogs, sources: [] } });
}

export async function analyzeTaskGoalWithGroq(params: {
  roomId: string;
  goal: string;
  groqModel: string;
}): Promise<TaskAnalysisResult> {
  const snapshot = getRoomSnapshot(params.roomId);
  const deviceList =
    snapshot.devices.map((d) => `${d.name} (${d.type}, os=${d.os}, online=${d.online})`).join('; ') || 'Web Workstation';

  const res = await callGroqCompletions({
    model: (params.groqModel || CURATED_GROQ_MODELS[0]).trim(),
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
    parsed = { summary: rawContent || 'Groq analysis complete.' };
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
    summary: (parsed.summary || 'Groq task analysis complete.').slice(0, 1500),
    blockers: Array.isArray(parsed.blockers) ? parsed.blockers.slice(0, 12).map((b) => String(b).slice(0, 300)) : [],
    subtasks: Array.isArray(parsed.subtasks) ? parsed.subtasks.slice(0, 15).map((s) => String(s).slice(0, 240)) : [],
    executableSteps: Array.isArray(parsed.executableSteps) ? parsed.executableSteps.slice(0, 10) : [],
    createdAt: Date.now(),
  };
}
