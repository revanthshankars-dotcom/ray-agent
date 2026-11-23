import crypto from 'crypto';
import type { TaskAnalysisResult, TaskCategory, TaskPriority } from '../src/types/relay.ts';
import { getRoomSnapshot, isRoomInterrupted, setRoomInterrupted } from './hub.ts';
import { sanitizeErrorMessage } from './security.ts';

const HF_BASE_URL = 'https://api-inference.huggingface.co/models';

export const CURATED_HF_MODELS = [
  'meta-llama/Meta-Llama-3-8B-Instruct',
  'mistralai/Mistral-7B-Instruct-v0.3',
  'google/gemma-2-9b-it',
];

function getHfApiKey(): string {
  return (process.env.HUGGINGFACE_API_KEY || process.env.HF_API_KEY || '').trim();
}

export function hasHfConfigured(): boolean {
  return Boolean(getHfApiKey());
}

export async function fetchHfModels(): Promise<{
  ok: boolean;
  hasKey: boolean;
  models: string[];
  error?: string;
}> {
  const hasKey = hasHfConfigured();
  return {
    ok: true,
    hasKey,
    models: CURATED_HF_MODELS,
    error: hasKey ? undefined : 'Add HUGGINGFACE_API_KEY in AI Studio Secrets or .env for serverless free tier inference.',
  };
}

async function callHfCompletions(model: string, prompt: string): Promise<string> {
  const apiKey = getHfApiKey();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const resp = await fetch(`${HF_BASE_URL}/${model}`, {
    method: 'POST',
    signal: AbortSignal.timeout(25000),
    headers,
    body: JSON.stringify({
      inputs: prompt,
      parameters: { max_new_tokens: 1024, temperature: 0.7, return_full_text: false },
    }),
  });

  const payload = (await resp.json().catch(() => ([]))) as Array<{ generated_text?: string }> | { error?: string };
  if (!resp.ok || ('error' in payload && payload.error)) {
    const err = 'error' in payload ? payload.error : `Hugging Face API error (${resp.status})`;
    throw new Error(err);
  }

  if (Array.isArray(payload) && payload[0]?.generated_text) {
    return payload[0].generated_text;
  }
  if (typeof payload === 'object' && 'generated_text' in payload && typeof payload.generated_text === 'string') {
    return payload.generated_text;
  }
  return JSON.stringify(payload);
}

export async function runHfChatTurn(input: {
  roomId: string;
  sourceDeviceName: string;
  targetDeviceHint?: string;
  message: string;
  history: Array<{ role: 'user' | 'assistant'; text: string }>;
  hfModel: string;
  systemInstruction: string;
  onEvent: (event: { type: string; data: unknown }) => void;
}): Promise<void> {
  setRoomInterrupted(input.roomId, false);
  const model = (input.hfModel || CURATED_HF_MODELS[0]).trim();

  const conversation = [
    `System: ${input.systemInstruction}`,
    ...input.history.slice(-6).map((h) => `${h.role === 'assistant' ? 'Assistant' : 'User'}: ${h.text}`),
    `User: ${input.message || 'Please assist.'}`,
    'Assistant:',
  ].join('\n\n');

  try {
    const reply = await callHfCompletions(model, conversation);
    input.onEvent({ type: 'text', data: reply.trim() || `Standing by, Ray via Hugging Face (${model}).` });
    input.onEvent({ type: 'done', data: { toolCalls: [], sources: [] } });
  } catch (err) {
    input.onEvent({ type: 'error', data: sanitizeErrorMessage(err, 'Hugging Face inference failed') });
  }
}

export async function analyzeTaskGoalWithHf(params: {
  roomId: string;
  goal: string;
  hfModel: string;
}): Promise<TaskAnalysisResult> {
  const model = (params.hfModel || CURATED_HF_MODELS[0]).trim();
  const prompt = `Analyze Ray's task: "${params.goal}". Output JSON with fields: category (coding|system|research|personal|workflow|general), priority (critical|high|medium|low), effortMinutes, recommendedDevice, safetyLevel, summary, blockers, subtasks, executableSteps.`;
  const raw = await callHfCompletions(model, prompt);
  const stripped = raw.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  let parsed: Partial<TaskAnalysisResult> = {};
  try {
    parsed = JSON.parse(stripped) as Partial<TaskAnalysisResult>;
  } catch {
    parsed = { summary: raw || 'Hugging Face analysis complete.' };
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
    summary: (parsed.summary || 'Hugging Face task analysis complete.').slice(0, 1500),
    blockers: Array.isArray(parsed.blockers) ? parsed.blockers.slice(0, 12).map((b) => String(b).slice(0, 300)) : [],
    subtasks: Array.isArray(parsed.subtasks) ? parsed.subtasks.slice(0, 15).map((s) => String(s).slice(0, 240)) : [],
    executableSteps: Array.isArray(parsed.executableSteps) ? parsed.executableSteps.slice(0, 10) : [],
    createdAt: Date.now(),
  };
}
