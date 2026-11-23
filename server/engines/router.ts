/**
 * RAY Engine Router
 * -----------------
 * Picks the best FREE engine for each request and switches automatically:
 *
 *  1. Classify the task (quick / chat / code / reasoning / vision / tools / web).
 *  2. Build a ranked chain of provider+model candidates for that task.
 *  3. Skip providers that are unconfigured, cooling down after a 429/5xx, over their
 *     per-minute rate, or at ≥98% of their daily free quota.
 *  4. On failure mid-conversation, fail over to the next candidate with the same context.
 *  5. When the big models are near their daily limits (≥85%) — or the user asks for it —
 *     run a "swarm": a small planner splits the task, several small models work the
 *     sub-tasks IN PARALLEL across different providers, and a synthesizer merges them.
 *     This spends cheap, high-quota requests instead of scarce large-model requests.
 *
 * The user can still force a specific engine; "auto" is the default.
 */
import { isRoomInterrupted, setRoomInterrupted } from '../hub.ts';
import { sanitizeErrorMessage } from '../security.ts';
import {
  PROVIDERS,
  type ModelTier,
  type ProviderDef,
  type TaskKind,
  isAvailable,
  isProviderConfigured,
  loadUsage,
  quotaUsed,
  recordFailure,
  recordUsage,
  resolveModel,
} from './providers.ts';

export interface RouterChatInput {
  roomId: string;
  message: string;
  history: Array<{ role: 'user' | 'assistant'; text: string }>;
  attachments?: Array<{ mimeType: string; dataBase64: string }>;
  systemInstruction: string;
  tools: Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }>;
  executeTool: (name: string, args: Record<string, unknown>) => Promise<{ result: string; confirmation?: unknown }>;
  onEvent: (event: { type: string; data: unknown }) => void;
  /** 'auto' (default) | 'swarm' (force parallel sub-agents) | provider id to pin. */
  mode?: string;
  deepThinking?: boolean;
}

// ---------------------------------------------------------------------------
// Task classification (cheap heuristics – no LLM call, no quota spent)
// ---------------------------------------------------------------------------

const TOOL_HINTS =
  /\b(open|launch|start|close|kill|play|search|find|show|list|read|send|message|whatsapp|instagram|text|call|notify|remind|timer|alarm|tab|tabs|app|apps|file|files|folder|screen|screenshot|click|type|press|volume|clipboard|copy|phone|pc|laptop|desktop|device|note|brain|save|calendar|email|gmail|drive|task|todo|protocol|wake)\b/i;
const CODE_HINTS = /\b(code|function|bug|error|stack ?trace|typescript|javascript|python|java|rust|golang|sql|regex|compile|refactor|api|script|class|component|debug)\b|```/i;
const REASONING_HINTS =
  /\b(why|analy[sz]e|compare|plan|strategy|design|architecture|prove|derive|step[- ]by[- ]step|pros and cons|trade-?offs?|research|explain in depth|deep dive|evaluate)\b/i;
const WEB_HINTS = /\b(latest|today|news|current|price|weather|score|stock|right now|this week|recent|2026|2027)\b/i;

export function classifyTask(
  message: string,
  attachments: RouterChatInput['attachments'],
  deepThinking?: boolean
): { kind: TaskKind; needsTools: boolean; needsWeb: boolean } {
  const text = message || '';
  const hasImage = (attachments || []).some((a) => a.mimeType.startsWith('image/'));
  const needsTools = TOOL_HINTS.test(text);
  const needsWeb = WEB_HINTS.test(text);
  let kind: TaskKind = 'chat';
  if (hasImage) kind = 'vision';
  else if (CODE_HINTS.test(text)) kind = 'code';
  else if (deepThinking || REASONING_HINTS.test(text) || text.length > 600) kind = 'reasoning';
  else if (needsTools) kind = 'tools';
  else if (text.length < 80) kind = 'quick';
  return { kind, needsTools, needsWeb };
}

const CHAINS: Record<TaskKind, Array<[string, ModelTier]>> = {
  quick: [['groq', 'fast'], ['cerebras', 'fast'], ['gemini', 'fast'], ['mistral', 'fast'], ['sambanova', 'fast'], ['nvidia', 'fast'], ['github', 'fast'], ['cloudflare', 'fast'], ['openrouter', 'fast'], ['custom', 'large'], ['llm7', 'fast']],
  chat: [['groq', 'large'], ['cerebras', 'large'], ['gemini', 'large'], ['mistral', 'large'], ['github', 'large'], ['nvidia', 'large'], ['sambanova', 'large'], ['openrouter', 'large'], ['cohere', 'large'], ['cloudflare', 'large'], ['huggingface', 'large'], ['custom', 'large'], ['llm7', 'large']],
  tools: [['groq', 'large'], ['cerebras', 'large'], ['gemini', 'large'], ['mistral', 'large'], ['github', 'large'], ['nvidia', 'large'], ['openrouter', 'large'], ['sambanova', 'large'], ['custom', 'large'], ['llm7', 'large']],
  code: [['mistral', 'code'], ['cerebras', 'code'], ['github', 'code'], ['groq', 'code'], ['gemini', 'code'], ['nvidia', 'code'], ['openrouter', 'code'], ['cloudflare', 'code'], ['huggingface', 'code'], ['custom', 'large'], ['llm7', 'code']],
  reasoning: [['gemini', 'reasoning'], ['github', 'reasoning'], ['cerebras', 'reasoning'], ['groq', 'reasoning'], ['mistral', 'reasoning'], ['nvidia', 'reasoning'], ['sambanova', 'reasoning'], ['openrouter', 'reasoning'], ['cloudflare', 'reasoning'], ['custom', 'large'], ['llm7', 'reasoning']],
  vision: [['gemini', 'vision'], ['mistral', 'vision'], ['groq', 'vision'], ['github', 'vision'], ['nvidia', 'vision'], ['openrouter', 'vision']],
};

function providerById(id: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

async function buildCandidates(kind: TaskKind, needsTools: boolean, pinned?: string) {
  const chain = CHAINS[kind];
  const ordered = pinned && providerById(pinned)
    ? [[pinned, chain.find(([id]) => id === pinned)?.[1] || 'large'] as [string, ModelTier], ...chain.filter(([id]) => id !== pinned)]
    : chain;
  const out: Array<{ p: ProviderDef; model: string; tier: ModelTier }> = [];
  for (const [id, tier] of ordered) {
    const p = providerById(id);
    if (!p || !isAvailable(p)) continue;
    if (needsTools && !p.supportsTools) continue;
    const model = await resolveModel(p, tier);
    if (model) out.push({ p, model, tier });
  }
  return out;
}

// ---------------------------------------------------------------------------
// OpenAI-compatible call with error classification
// ---------------------------------------------------------------------------

class ProviderError extends Error {
  constructor(message: string, public status: number, public retryAfter?: number) {
    super(message);
  }
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: unknown;
  tool_calls?: unknown;
  tool_call_id?: string;
}

interface CompletionResult {
  content: string;
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  rawToolCalls: unknown;
  tokens: number;
}

async function callCompletion(
  p: ProviderDef,
  model: string,
  messages: ChatMessage[],
  tools?: RouterChatInput['tools'],
  opts?: { maxTokens?: number; timeoutMs?: number }
): Promise<CompletionResult> {
  const base = p.baseUrl();
  const key = p.apiKey();
  if (!base || !key) throw new ProviderError(`${p.label} not configured`, 401);
  const body: Record<string, unknown> = { model, messages, temperature: 0.4 };
  if (opts?.maxTokens) body.max_tokens = opts.maxTokens;
  if (tools && tools.length && p.supportsTools) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  let resp: Response;
  try {
    resp = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(p.extraHeaders?.() || {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts?.timeoutMs || 45000),
    });
  } catch (err) {
    throw new ProviderError(`${p.label} network error: ${sanitizeErrorMessage(err)}`, 0);
  }
  const json = (await resp.json().catch(() => ({}))) as {
    choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }>;
    usage?: { total_tokens?: number };
    error?: { message?: string } | string;
  };
  if (!resp.ok) {
    const errMsg = typeof json.error === 'string' ? json.error : json.error?.message || `HTTP ${resp.status}`;
    const ra = Number(resp.headers.get('retry-after') || '') || undefined;
    throw new ProviderError(`${p.label}: ${errMsg}`.slice(0, 300), resp.status, ra);
  }
  const msg = json.choices?.[0]?.message || {};
  const rawCalls = msg.tool_calls || [];
  const toolCalls = rawCalls.map((tc, i) => {
    let args: Record<string, unknown> = {};
    try {
      args = tc.function?.arguments ? (JSON.parse(tc.function.arguments) as Record<string, unknown>) : {};
    } catch {
      args = {};
    }
    return { id: tc.id || `call_${Date.now()}_${i}`, name: tc.function?.name || 'unknown_tool', args };
  });
  // Strip <think> blocks that some reasoning models leak into content.
  const content = String(msg.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  return { content, toolCalls, rawToolCalls: rawCalls, tokens: json.usage?.total_tokens || 0 };
}

/** Try candidates in order until one answers. Marks failures/cooldowns. */
async function completeWithFailover(
  candidates: Array<{ p: ProviderDef; model: string }>,
  messages: ChatMessage[],
  tools: RouterChatInput['tools'] | undefined,
  onSwitch?: (info: { provider: string; model: string; reason?: string }) => void,
  opts?: { maxTokens?: number; timeoutMs?: number }
): Promise<CompletionResult & { provider: ProviderDef; model: string }> {
  const errors: string[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const { p, model } = candidates[i];
    if (!isAvailable(p)) continue;
    onSwitch?.({ provider: p.label, model, reason: i === 0 ? undefined : errors[errors.length - 1] });
    try {
      let out: CompletionResult;
      try {
        out = await callCompletion(p, model, messages, tools, opts);
      } catch (err) {
        // Some models reject tool schemas – retry once without tools on the same provider.
        if (err instanceof ProviderError && err.status === 400 && tools?.length && /tool|function|schema/i.test(err.message)) {
          out = await callCompletion(p, model, messages, undefined, opts);
        } else throw err;
      }
      recordUsage(p.id, out.tokens);
      return { ...out, provider: p, model };
    } catch (err) {
      const pe = err instanceof ProviderError ? err : new ProviderError(sanitizeErrorMessage(err), 0);
      recordFailure(p.id, pe.status, pe.retryAfter);
      errors.push(pe.message);
    }
  }
  throw new Error(
    errors.length
      ? `All free engines failed: ${errors.slice(-3).join(' | ')}`
      : 'No free AI engine is configured. Add at least one key (e.g. GROQ_API_KEY or CEREBRAS_API_KEY) — LLM7 works without a key if outbound internet is available.'
  );
}

function sanitizeTools(tools: RouterChatInput['tools']): RouterChatInput['tools'] {
  return tools.map((t) => {
    const props = (t.function.parameters?.properties || {}) as Record<string, Record<string, unknown>>;
    const fixed: Record<string, Record<string, unknown>> = {};
    for (const [k, v] of Object.entries(props)) {
      fixed[k] = v.type === 'array' && !v.items ? { ...v, items: { type: 'string' } } : v;
    }
    return { ...t, function: { ...t.function, parameters: { ...t.function.parameters, properties: fixed } } };
  });
}

// ---------------------------------------------------------------------------
// Swarm: parallel small agents instead of one large model
// ---------------------------------------------------------------------------

function largeQuotaPressure(): number {
  const large = ['gemini', 'github', 'groq', 'cerebras', 'mistral'].map(providerById).filter((p): p is ProviderDef => Boolean(p && isProviderConfigured(p)));
  if (large.length === 0) return 1;
  return Math.min(...large.map(quotaUsed));
}

async function runSwarm(input: RouterChatInput, emitEngine: (d: Record<string, unknown>) => void): Promise<string> {
  const fastCandidates = await buildCandidates('quick', false);
  if (fastCandidates.length === 0) throw new Error('No small models available for swarm mode.');

  // 1) Planner (smallest/fastest model)
  emitEngine({ phase: 'swarm-plan', provider: fastCandidates[0].p.label, model: fastCandidates[0].model });
  const plan = await completeWithFailover(
    fastCandidates,
    [
      {
        role: 'system',
        content:
          'You split a task into 2-4 independent sub-questions that can be answered in parallel. Reply ONLY with JSON: {"subtasks":["...","..."]}',
      },
      { role: 'user', content: input.message },
    ],
    undefined,
    undefined,
    { maxTokens: 400, timeoutMs: 20000 }
  );
  let subtasks: string[] = [];
  try {
    const m = plan.content.match(/\{[\s\S]*\}/);
    subtasks = (JSON.parse(m ? m[0] : plan.content).subtasks || []).map(String).slice(0, 4);
  } catch {
    subtasks = [];
  }
  if (subtasks.length < 2) subtasks = [input.message];

  // 2) Workers in parallel — spread across DIFFERENT providers to spread quota.
  const workerPool = (await buildCandidates('chat', false)).filter((c) => c.p.rpd >= 1000 || quotaUsed(c.p) < 0.85);
  const pool = workerPool.length ? workerPool : fastCandidates;
  emitEngine({ phase: 'swarm-run', workers: subtasks.length, providers: Array.from(new Set(pool.slice(0, subtasks.length).map((c) => c.p.label))) });
  const results = await Promise.allSettled(
    subtasks.map((sub, i) => {
      const rotated = [...pool.slice(i % pool.length), ...pool.slice(0, i % pool.length)];
      return completeWithFailover(
        rotated,
        [
          { role: 'system', content: 'You are a focused research sub-agent. Answer the sub-question concisely and factually.' },
          { role: 'user', content: `Overall task: ${input.message}\n\nYour sub-question: ${sub}` },
        ],
        undefined,
        undefined,
        { maxTokens: 700, timeoutMs: 30000 }
      ).then((r) => ({ sub, text: r.content, by: `${r.provider.label}/${r.model}` }));
    })
  );
  const findings = results
    .map((r, i) => (r.status === 'fulfilled' ? `### ${r.value.sub}\n(${r.value.by})\n${r.value.text}` : `### ${subtasks[i]}\n(failed)`))
    .join('\n\n');

  // 3) Synthesizer
  const synthCandidates = await buildCandidates('chat', false);
  emitEngine({ phase: 'swarm-merge', provider: synthCandidates[0]?.p.label });
  const merged = await completeWithFailover(
    synthCandidates.length ? synthCandidates : fastCandidates,
    [
      { role: 'system', content: input.systemInstruction },
      ...input.history.slice(-6).map((h) => ({ role: h.role, content: h.text }) as ChatMessage),
      {
        role: 'user',
        content: `${input.message}\n\n---\nFindings from parallel sub-agents (merge them into one clear answer for Ray, resolve conflicts, no meta-commentary):\n\n${findings}`,
      },
    ],
    undefined,
    undefined,
    { maxTokens: 1500 }
  );
  return merged.content;
}

// ---------------------------------------------------------------------------
// Main entry: auto-routed chat turn with tool loop + failover
// ---------------------------------------------------------------------------

export async function runAutoChatTurn(input: RouterChatInput): Promise<{ handled: boolean; needsGeminiNative?: boolean }> {
  await loadUsage();
  setRoomInterrupted(input.roomId, false);
  const { kind, needsTools, needsWeb } = classifyTask(input.message, input.attachments, input.deepThinking);
  const emitEngine = (d: Record<string, unknown>) => input.onEvent({ type: 'engine', data: { task: kind, ...d } });

  // Live web questions are best served by Gemini's native Google Search grounding.
  const gemini = providerById('gemini');
  if (needsWeb && !needsTools && gemini && isAvailable(gemini) && input.mode !== 'swarm') {
    emitEngine({ provider: 'Google Gemini', model: 'native + Google Search', reason: 'live web question' });
    return { handled: false, needsGeminiNative: true };
  }

  const pinned = input.mode && input.mode !== 'auto' && input.mode !== 'swarm' ? input.mode : undefined;
  const pressure = largeQuotaPressure();
  const wantSwarm =
    input.mode === 'swarm' || (!needsTools && (kind === 'reasoning' || kind === 'chat') && pressure >= 0.85 && input.message.length > 40);

  if (wantSwarm) {
    try {
      emitEngine({ phase: 'swarm', reason: input.mode === 'swarm' ? 'requested' : `large-model quota at ${Math.round(pressure * 100)}%` });
      const text = await runSwarm(input, emitEngine);
      input.onEvent({ type: 'text', data: text });
      input.onEvent({ type: 'done', data: { toolCalls: [], sources: [] } });
      return { handled: true };
    } catch (err) {
      emitEngine({ phase: 'swarm-failed', reason: sanitizeErrorMessage(err) });
      // fall through to single-agent
    }
  }

  const candidates = await buildCandidates(needsTools ? 'tools' : kind, needsTools, pinned);
  // Always keep a tool-capable fallback list when tools are involved.
  const fallbackTools = needsTools ? candidates : await buildCandidates('tools', true);
  const all = [...candidates, ...fallbackTools.filter((c) => !candidates.some((x) => x.p.id === c.p.id))];
  if (all.length === 0) {
    return { handled: false };
  }

  const tools = sanitizeTools(input.tools);
  const messages: ChatMessage[] = [
    { role: 'system', content: input.systemInstruction },
    ...input.history.slice(-10).map((h) => ({ role: h.role, content: h.text }) as ChatMessage),
  ];
  const images = (input.attachments || []).filter((a) => a.mimeType.startsWith('image/'));
  messages.push(
    images.length
      ? {
          role: 'user',
          content: [
            { type: 'text', text: input.message || 'Analyze the attached image.' },
            ...images.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.dataBase64}` } })),
          ],
        }
      : { role: 'user', content: input.message || 'Please assist.' }
  );

  const toolLogs: Array<Record<string, unknown>> = [];
  let lastProvider = '';
  for (let round = 0; round < 6; round++) {
    if (isRoomInterrupted(input.roomId)) {
      input.onEvent({ type: 'text', data: 'Standing down, Ray.' });
      input.onEvent({ type: 'done', data: { toolCalls: toolLogs, sources: [] } });
      return { handled: true };
    }
    const out = await completeWithFailover(all, messages, tools, (info) => {
      if (info.provider !== lastProvider) {
        lastProvider = info.provider;
        emitEngine({ provider: info.provider, model: info.model, reason: info.reason ? `failover: ${info.reason}` : undefined });
      }
    });

    if (out.toolCalls.length === 0) {
      input.onEvent({ type: 'text', data: out.content || 'Done, Ray.' });
      input.onEvent({ type: 'done', data: { toolCalls: toolLogs, sources: [] } });
      return { handled: true };
    }

    messages.push({ role: 'assistant', content: out.content || '', tool_calls: out.rawToolCalls });
    // Independent tool calls run in parallel (e.g. "open YouTube on PC and Spotify on phone").
    const execs = await Promise.all(
      out.toolCalls.map(async (tc) => {
        const log: Record<string, unknown> = { id: tc.id, name: tc.name, args: tc.args, status: 'running' };
        toolLogs.push(log);
        input.onEvent({ type: 'tool_start', data: log });
        let resultStr = '';
        try {
          const r = await input.executeTool(tc.name, tc.args);
          resultStr = r.result;
          log.status = r.confirmation ? 'awaiting_confirmation' : 'completed';
          if (r.confirmation) input.onEvent({ type: 'confirmation_required', data: r.confirmation });
        } catch (err) {
          resultStr = sanitizeErrorMessage(err);
          log.status = 'error';
        }
        log.result = resultStr;
        input.onEvent({ type: 'tool_end', data: log });
        return { id: tc.id, resultStr };
      })
    );
    for (const e of execs) messages.push({ role: 'tool', tool_call_id: e.id, content: e.resultStr.slice(0, 12000) });
  }

  input.onEvent({ type: 'text', data: 'All requested actions have been executed, Ray.' });
  input.onEvent({ type: 'done', data: { toolCalls: toolLogs, sources: [] } });
  return { handled: true };
}

/** One-shot completion for internal helpers (summaries, classification, planning). */
export async function quickComplete(prompt: string, system = 'You are RAY, a concise assistant.', kind: TaskKind = 'quick'): Promise<string> {
  await loadUsage();
  const candidates = await buildCandidates(kind, false);
  const out = await completeWithFailover(
    candidates,
    [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ],
    undefined,
    undefined,
    { maxTokens: 800, timeoutMs: 25000 }
  );
  return out.content;
}
