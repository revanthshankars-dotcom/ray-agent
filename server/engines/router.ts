/**
 * ENGINE ASSIGNMENT CLAUSE
 * ------------------------
 * RAY assigns every request to an engine automatically; the user never has to pick one.
 *   1. Each request is classified (quick reply, chat, device action/tools, code, deep
 *      reasoning, image/vision, live web) and sent to the best FREE engine for that job.
 *   2. Every configured key is used — whatever name it was stored under — and engines
 *      without keys are skipped silently.
 *   3. If an engine errors, times out, runs out of credit or hits a rate/daily limit, the
 *      same request moves to the next engine in that job's chain within the same turn.
 *   4. When the large models approach their daily limits (≥85%), big questions are split
 *      across several small models running in parallel and merged ("swarm").
 *   5. A server-side daily token budget (RAY_DAILY_TOKEN_CAP) is never exceeded, and RAY
 *      never silently switches to a paid engine ahead of free ones.
 *   6. Every reply records which engine/model answered it.
 * Pinning an engine in the UI only moves it to the front of the chain; fallback still applies.
 *
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
import { mcpKnownWords } from '../mcpConnectors.ts';
import {
  PROVIDERS,
  type ModelTier,
  type ProviderDef,
  type TaskKind,
  dailyBudget,
  isAvailable,
  isModelAvailable,
  isProviderConfigured,
  markKeyFailed,
  maxTokensFor,
  PROVIDER_KEY_ENV,
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
  /** Exact model chosen in the UI for the pinned provider (tried first). */
  pinnedModel?: string;
  deepThinking?: boolean;
}

// ---------------------------------------------------------------------------
// Task classification (cheap heuristics – no LLM call, no quota spent)
// ---------------------------------------------------------------------------

const TOOL_HINTS =
  /\b(book|booking|buy|order|pay|flight|flights|ticket|tickets|hotel|reserve|reservation|schedule|reschedule|cancel|apply|sign up|register|submit|ask me|check with me|video call|this page|this tab|bookmarks?|history|lights?|lamp|fan|thermostat|unlock|smart home|home assistant|goodnight|mcp|connectors?|n8n|workflow|agentphone|sms|skills?|playbook|video|youtube|watch|routine|gmail|email|inbox|calendar|drive|docs|sheets|slides|youtube|instagram|facebook|reel|research|learn about|learn|keep up with|study|browse|website|repair|fix my|fix the|diagnose|frozen|not responding|free up|disk space|internet|restore|undo|health|codex|claude code|aider|coding agents?|teach|show me|how do i|how to|navigate|fill|settings?|call|ring|dial|wake|alarm|open|launch|start|close|kill|play|search|find|show|list|read|send|message|whatsapp|instagram|text|call|notify|remind|timer|alarm|tab|tabs|app|apps|file|files|folder|screen|screenshot|click|type|press|volume|clipboard|copy|phone|pc|laptop|desktop|device|note|brain|save|calendar|email|gmail|drive|task|todo|protocol|wake)\b/i;
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
  const needsTools = TOOL_HINTS.test(text) || text.toLowerCase().split(/[^a-z0-9]+/).some((w) => w.length > 3 && mcpKnownWords().has(w));
  const needsWeb = WEB_HINTS.test(text);
  let kind: TaskKind = 'chat';
  if (hasImage) kind = 'vision';
  else if (CODE_HINTS.test(text)) kind = 'code';
  else if (deepThinking || REASONING_HINTS.test(text) || text.length > 600) kind = 'reasoning';
  else if (needsTools) kind = 'tools';
  else if (text.length < 80) kind = 'quick';
  return { kind, needsTools, needsWeb };
}

// Ordered from the live test (23 Nov 2026): Groq gpt-oss-120b → gpt-oss-20b → OpenRouter
// nemotron-3.5-lightning:free → gemma-4-26b:free, then every other configured free engine.
const CHAINS: Record<TaskKind, Array<[string, ModelTier]>> = {
  quick: [['groq', 'fast'], ['openrouter', 'fast'], ['cerebras', 'fast'], ['groq', 'large'], ['gemini', 'fast'], ['mistral', 'fast'], ['opencode', 'fast'], ['sambanova', 'fast'], ['nvidia', 'fast'], ['github', 'fast'], ['cloudflare', 'fast'], ['zhipu', 'fast'], ['siliconflow', 'fast'], ['deepseek', 'fast'], ['custom', 'large'], ['llm7', 'fast']],
  chat: [['groq', 'large'], ['groq', 'fast'], ['openrouter', 'large'], ['cerebras', 'large'], ['opencode', 'large'], ['gemini', 'large'], ['mistral', 'large'], ['github', 'large'], ['nvidia', 'large'], ['sambanova', 'large'], ['cohere', 'large'], ['cloudflare', 'large'], ['huggingface', 'large'], ['deepseek', 'large'], ['zhipu', 'large'], ['dashscope', 'large'], ['siliconflow', 'large'], ['novita', 'large'], ['custom', 'large'], ['llm7', 'large']],
  tools: [['groq', 'large'], ['groq', 'fast'], ['openrouter', 'large'], ['cerebras', 'large'], ['opencode', 'large'], ['gemini', 'large'], ['mistral', 'large'], ['github', 'large'], ['nvidia', 'large'], ['sambanova', 'large'], ['deepseek', 'large'], ['zhipu', 'large'], ['dashscope', 'large'], ['custom', 'large'], ['llm7', 'large']],
  code: [['groq', 'code'], ['opencode', 'code'], ['openrouter', 'code'], ['mistral', 'code'], ['cerebras', 'code'], ['github', 'code'], ['groq', 'fast'], ['gemini', 'code'], ['nvidia', 'code'], ['cloudflare', 'code'], ['huggingface', 'code'], ['deepseek', 'code'], ['dashscope', 'code'], ['zhipu', 'code'], ['siliconflow', 'code'], ['custom', 'large'], ['llm7', 'code']],
  reasoning: [['groq', 'reasoning'], ['openrouter', 'reasoning'], ['gemini', 'reasoning'], ['github', 'reasoning'], ['cerebras', 'reasoning'], ['opencode', 'reasoning'], ['mistral', 'reasoning'], ['groq', 'fast'], ['nvidia', 'reasoning'], ['sambanova', 'reasoning'], ['cloudflare', 'reasoning'], ['deepseek', 'reasoning'], ['dashscope', 'reasoning'], ['novita', 'reasoning'], ['custom', 'large'], ['llm7', 'reasoning']],
  vision: [['openrouter', 'vision'], ['gemini', 'vision'], ['groq', 'vision'], ['mistral', 'vision'], ['github', 'vision'], ['nvidia', 'vision'], ['zhipu', 'vision'], ['dashscope', 'vision'], ['custom', 'vision']],
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
    if (model && isModelAvailable(p, model) && !out.some((c) => c.p.id === p.id && c.model === model)) out.push({ p, model, tier });
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
  opts?: { maxTokens?: number; timeoutMs?: number; kind?: string }
): Promise<CompletionResult> {
  const base = p.baseUrl();
  const key = p.apiKey();
  if (!base || !key) throw new ProviderError(`${p.label} not configured`, 401);
  const body: Record<string, unknown> = { model, messages, temperature: 0.4 };
  // Always cap output: providers default to huge budgets (65K) that exceed free credit/TPM.
  body.max_tokens = Math.min(opts?.maxTokens || 1024, maxTokensFor(p, model, opts?.kind || 'chat'));
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
      signal: AbortSignal.timeout(opts?.timeoutMs || 30000),
    });
  } catch (err) {
    const timedOut = err instanceof Error && /timeout|aborted/i.test(`${err.name} ${err.message}`);
    throw new ProviderError(`${p.label} ${timedOut ? 'timed out after 30s' : `network error: ${sanitizeErrorMessage(err)}`}`, timedOut ? 408 : 0);
  }
  const json = (await resp.json().catch(() => ({}))) as {
    choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }>;
    usage?: { total_tokens?: number };
    error?: { message?: string } | string;
  };
  if (!resp.ok) {
    const errMsg = typeof json.error === 'string' ? json.error : json.error?.message || `HTTP ${resp.status}`;
    // Retry-After header, or "Please try again in 7.5s" / "in 1m2.3s" inside the message (Groq).
    let ra = Number(resp.headers.get('retry-after') || '') || undefined;
    const m = errMsg.match(/try again in (?:(\d+)m)?([\d.]+)s/i);
    if (!ra && m) ra = Math.ceil(Number(m[1] || 0) * 60 + Number(m[2] || 0));
    let status = resp.status;
    if (status === 400 && /credit|afford|max_tokens|insufficient/i.test(errMsg)) status = 402;
    if (/request too large|tokens per minute|TPM/i.test(errMsg) && status !== 429) status = 413;
    throw new ProviderError(`${p.label} (${model}): ${errMsg}`.slice(0, 300), status, ra);
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
  opts?: { maxTokens?: number; timeoutMs?: number; kind?: string }
): Promise<CompletionResult & { provider: ProviderDef; model: string }> {
  const errors: string[] = [];
  let keyRotations = 0;
  for (let i = 0; i < candidates.length; i++) {
    const { p, model } = candidates[i];
    const usedKey = p.apiKey() || '';
    if (!isModelAvailable(p, model)) continue;
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
      // Several keys for one provider (e.g. two OpenCode keys): switch key, retry same engine.
      const keyEnv = PROVIDER_KEY_ENV[p.id];
      if (keyEnv && usedKey && [401, 402, 403, 429].includes(pe.status) && keyRotations < 4 && markKeyFailed(keyEnv, usedKey, pe.status, pe.retryAfter)) {
        keyRotations++;
        errors.push(`${pe.message} (switching to backup key)`);
        i--;
        continue;
      }
      recordFailure(p.id, pe.status, pe.retryAfter, model, pe.message);
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
// Send only the tools a message plausibly needs. The full list is ~2.5K tokens, which
// alone eats a third of Groq's 8K tokens/minute — and extra tools tempt models into
// calling irrelevant ones (e.g. analyze_task_goal on a plain JSON question).
// ---------------------------------------------------------------------------

const TOOL_TOPICS: Array<[RegExp, string[]]> = [
  [/\b(open|play|watch|listen|search|google|youtube|spotify|show me|pull up|go to|website|link|url)\b/i, ['search_and_open', 'open_url_on_device', 'web_search']],
  [/\b(app|apps|launch|start|open|installed|close|quit)\b/i, ['open_application', 'list_installed_apps', 'close_application']],
  [/\b(tab|tabs|browser|chrome|edge)\b/i, ['list_browser_tabs', 'browser_tab_action', 'open_url_on_device']],
  [/\b(file|files|folder|document|documents|downloads|desktop|read|write|save|pdf|txt|photo|scan|where is|where's|find my)\b/i, ['search_file_index', 'open_file_on_device', 'list_system_files', 'search_system_files', 'read_system_file', 'write_system_file']],
  [/\b(screen|screenshot|window|click|type|press|scroll|mouse|keyboard)\b/i, ['capture_screen_snapshot', 'inspect_active_screen_and_window', 'control_screen_input']],
  [/\b(message|messages|whatsapp|instagram|dm|sms|text|telegram|reply|inbox|chat)\b/i, ['read_incoming_messages', 'send_chat_message']],
  [/\b(note|notes|brain|remember|memory|obsidian|wikilink)\b/i, ['search_second_brain', 'read_brain_note', 'upsert_brain_note', 'link_brain_notes']],
  [/\b(device|devices|phone|pc|laptop|computer|battery|online|offline|wake)\b/i, ['list_connected_devices', 'get_device_telemetry', 'wake_device']],
  [/\b(notify|notification|alert|remind|speak|say|announce)\b/i, ['send_device_notification', 'speak_on_device']],
  [/\b(clipboard|copy|paste|handoff|send to)\b/i, ['push_clipboard_handoff']],
  [/\b(timer|countdown|alarm)\b/i, ['set_device_timer']],
  [/\b(task|tasks|todo|to-do)\b/i, ['manage_shared_task']],
  [/\b(gmail|email|mail|calendar|meeting|event|drive|docs|sheets|contacts)\b/i, ['google_workspace_action']],
  [/\b(notion|connector|webhook)\b/i, ['invoke_app_connector']],
  [/\b(volume|mute|louder|quieter)\b/i, ['adjust_volume']],
  [/\b(kill|process|optimi[sz]e|cpu|memory usage|slow)\b/i, ['kill_process', 'optimize_system', 'get_device_telemetry']],
  [/\b(protocol|house party|clean slate)\b/i, ['execute_protocol']],
  [/\b(plan|break down|analy[sz]e (this|my) task|prioriti[sz]e)\b/i, ['analyze_task_goal']],
  [/\b(photo|camera|snapshot|picture)\b/i, ['request_device_snapshot']],
  [/\b(claude code|codex|gemini cli|aider|coding agents?|my (project|repo|app|code)|in parallel|sub-?agents?)\b/i, ['run_coding_agents', 'coding_agent_status', 'list_coding_agents']],
  [/\b(teach|show me how|how do i|how to|click|navigate|do it for me|for me|operate|fill|form|setting|settings|in the app|on my screen|use the mouse|step by step)\b/i, ['operate_computer', 'stop_computer_task', 'open_application']],
  [/\b(call|ring|dial|phone me|wake me|alarm|remind me|video|facetime|connect (my )?(pc|phone|laptop))\b/i, ['call_me', 'phone_call_me', 'call_device', 'place_phone_call', 'manage_scheduled_calls', 'list_connected_devices']],
  [/\b(mcp|connectors?|agentphone|callforme|n8n|workflows?|skills?|sms|text me|automation)\b/i, ['mcp_servers', 'mcp_call']],
  [/\b(skills?|playbooks?|orbit|better way|best way|workflow)\b/i, ['skill_search', 'skill_install', 'skill_list', 'skill_remove']],
  [/\b(inbox|emails?|gmail|drafts?|routine|twice a day|learn (about )?me|get to know me|who i am|my style)\b/i, ['inbox_routine', 'learn_me_from_email', 'google_api_request']],
  [/\b(video|videos|youtube|youtu\.be|watch|reel|clip|lecture|course)\b/i, ['watch_video', 'learn_about']],
  [/\b(awareness|aware|what i'?m (doing|working on)|this (window|app|page|error)|on my screen)\b/i, ['awareness', 'request_device_snapshot']],
  [/\b(this (page|tab|site|article|email|post|form)|current (page|tab)|the page|on the page|summari[sz]e (this|it)|reply (here|to this)|fill (this|it|in)|click|scroll|history|visited|bookmarks?|i (read|saw|opened) (yesterday|earlier|last))\b/i, ['browser_page', 'browser_history', 'list_browser_tabs']],
  [/\b(lights?|lamp|fan|ac|aircon|air conditioner|heater|thermostat|temperature|plug|switch|tv|television|blinds?|curtains?|garage|door lock|lock|unlock|scene|goodnight|good night|bedroom|living room|kitchen|home assistant|smart home|vacuum)\b/i, ['home_control', 'home_devices']],
  [/\b(research|find out|look up|compare|best|price|prices|review|reviews|docs|documentation|website|web ?site|browse|browser|on the web|online|book|booking|form|sign up|order)\b/i, ['browse_web', 'read_web_page', 'web_search']],
  [/\b(learn|study|keep up|follow|knowledge|what did you learn|briefing|topics?)\b/i, ['learn_about', 'manage_learning', 'search_second_brain']],
  [/\b(fix|repair|broken|slow|frozen|hang|hanging|crash|crashing|not responding|not working|space|disk|storage|internet|wifi|wi-fi|dns|health|diagnos\w*|check ?up|update ray|restore|undo|previous version)\b/i, ['diagnose_device', 'repair_device', 'restore_file', 'operate_computer']],
  [/\b(open ray|show ray|show yourself|pop ?up|bring up ray)\b/i, ['show_ray']],
  [/\b(gmail|email|emails|mail|inbox|calendar|meeting|event|drive|doc|docs|document|sheet|sheets|spreadsheet|slides?|presentation|tasks?|contacts?|youtube|playlist|google)\b/i, ['google_api_request', 'connected_accounts']],
  [/\b(instagram|insta|ig|facebook|fb|reel|reels|post|posts|story|comments?|followers|meta|whatsapp)\b/i, ['meta_api_request', 'connected_accounts', 'browse_web']],
];

export function selectRelevantTools(message: string, tools: RouterChatInput['tools']): RouterChatInput['tools'] {
  const wanted = new Set<string>();
  for (const [re, names] of TOOL_TOPICS) if (re.test(message)) names.forEach((n) => wanted.add(n));
  const words = message.toLowerCase().split(/[^a-z0-9]+/);
  if (words.some((w) => w.length > 3 && mcpKnownWords().has(w))) ['mcp_servers', 'mcp_call'].forEach((n) => wanted.add(n));
  // Any real task can need Ray's decision mid-way.
  if (wanted.size || looksLikeMission(message) || /\b(ask me|check with me|confirm with me|verify with me|let me decide|my call)\b/i.test(message)) wanted.add('ask_user');
  return tools.filter((t) => wanted.has(t.function.name)).slice(0, 18);
}

// ---------------------------------------------------------------------------
// Free-model mission strength: plan ledger, strongest-first escalation, compaction, final check
// ---------------------------------------------------------------------------

/** Free models that hold long tool missions best (matched on model id). */
const STRONG_FREE = /gpt-oss-120b|qwen-?3-?235b|qwen3-coder|deepseek-(v3|r1|chat|reasoner)|kimi-k2|glm-4\.[5-9]|gemini-[\d.]+-(pro|flash)(?!-lite)|llama-3\.3-70b|llama-4-maverick|mistral-(large|medium)|nemotron-.*(super|ultra)|gpt-4\.1(?!-nano)/i;

export function strongFirst<T extends { model: string }>(list: T[]): T[] {
  return [...list.filter((c) => STRONG_FREE.test(c.model)), ...list.filter((c) => !STRONG_FREE.test(c.model))];
}

/** Multi-step goals get a written plan up front. */
export function looksLikeMission(message: string): boolean {
  const m = message.toLowerCase();
  if (m.length < 40) return false;
  return /\b(and then|then|after that|and also|also|every|all|each|finish|complete|whole|entire|until|step by step|plan|organi[sz]e|set up|sort out|clean up|book|research)\b/.test(m) || (m.match(/\band\b/g) || []).length >= 2;
}

async function planMission(goal: string, toolNames: string[]): Promise<string> {
  const out = await quickComplete(
    `Goal from Ray: "${goal.slice(0, 1500)}"\nTools available: ${toolNames.slice(0, 40).join(', ')}\n\nWrite the plan: 2-7 numbered steps, each one line naming the tool to use, then a line "Done when: <how to tell the goal is fully met>". Include a fallback in brackets for risky steps. No other text.`,
    'You are the planner for a personal assistant agent. Short, concrete, executable plans.',
    'reasoning',
    { maxTokens: 400, timeoutMs: 15000 }
  );
  return out.replace(/```[a-z]*\n?|```/g, '').trim().slice(0, 1600);
}

function ledgerText(plan: string, toolLogs: Array<Record<string, unknown>>): string {
  const steps = toolLogs
    .slice(-14)
    .map((t, i) => `${i + 1}. ${t.name} → ${t.status === 'error' || /^(Could not|Failed|Error|No online|No RAY bridge)/i.test(String(t.result || '')) ? 'FAILED: ' : ''}${String(t.result || t.status || '').replace(/\s+/g, ' ').slice(0, 140)}`)
    .join('\n');
  return `[Mission ledger — keep to the plan, do the next unfinished step, never redo finished ones]\nPlan:\n${plan}\n\nProgress so far:\n${steps || '(nothing yet)'}`;
}

/** Shrinks older tool results so small free models keep the goal in context. */
function compactMessages(messages: ChatMessage[], keepLast = 4) {
  const toolIdx = messages.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0);
  for (const i of toolIdx.slice(0, Math.max(0, toolIdx.length - keepLast))) {
    const c = String(messages[i].content || '');
    if (c.length > 700) messages[i] = { ...messages[i], content: `${c.slice(0, 600)} …[trimmed]` };
  }
}

async function verifyMission(goal: string, toolLogs: Array<Record<string, unknown>>, answer: string): Promise<string | null> {
  try {
    const out = await quickComplete(
      `Ray asked: "${goal.slice(0, 1200)}"\nSteps done:\n${toolLogs.map((t) => `- ${t.name}: ${String(t.result || t.status).replace(/\s+/g, ' ').slice(0, 200)}`).join('\n')}\nDraft answer: "${answer.slice(0, 800)}"\n\nIs every part of the request actually done according to the step results (not just claimed)? Reply ONLY JSON {"complete":true|false,"missing":"what is still missing, or empty"}. Count parts needing Ray's approval as complete.`,
      'You verify an assistant agent’s work strictly against evidence.',
      'quick',
      { maxTokens: 150, timeoutMs: 10000 }
    );
    const j = JSON.parse(out.match(/\{[\s\S]*\}/)?.[0] || '{}') as { complete?: boolean; missing?: string };
    return j.complete === false && j.missing ? String(j.missing).slice(0, 400) : null;
  } catch {
    return null;
  }
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
  let all = [...candidates, ...fallbackTools.filter((c) => !candidates.some((x) => x.p.id === c.p.id && x.model === c.model))];
  const pinnedProvider = pinned ? providerById(pinned) : undefined;
  if (pinnedProvider && input.pinnedModel && isModelAvailable(pinnedProvider, input.pinnedModel)) {
    all = [{ p: pinnedProvider, model: input.pinnedModel, tier: 'large' as ModelTier }, ...all.filter((c) => !(c.p.id === pinned && c.model === input.pinnedModel))];
  }
  if (all.length === 0) {
    const b = dailyBudget();
    if (b.exceeded) {
      input.onEvent({ type: 'error', data: `Daily AI budget reached (${b.usedTokens.toLocaleString()} / ${b.capTokens.toLocaleString()} tokens). It resets at midnight UTC, or raise RAY_DAILY_TOKEN_CAP.` });
      input.onEvent({ type: 'done', data: { toolCalls: [], sources: [] } });
      return { handled: true };
    }
    return { handled: false };
  }

  const tools = needsTools ? selectRelevantTools(input.message, sanitizeTools(input.tools)) : [];
  const messages: ChatMessage[] = [
    { role: 'system', content: input.systemInstruction },
    ...input.history.slice(-10).map((h) => ({ role: h.role, content: h.text.slice(0, 1500) }) as ChatMessage),
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
  // Long goals get a written plan that is re-shown every round, so free models never lose the thread.
  let plan = '';
  if (tools.length && looksLikeMission(input.message)) {
    plan = await planMission(input.message, tools.map((t) => t.function.name)).catch(() => '');
    if (plan) {
      emitEngine({ phase: 'plan', reason: plan.split('\n')[0].slice(0, 120) });
      messages.splice(1, 0, { role: 'system', content: ledgerText(plan, toolLogs) });
    }
  }
  let verified = false;
  let escalated = false;
  // MISSION CLAUSE: up to 12 rounds; when steps fail, RAY reflects and tries alternatives
  // (twice) instead of stopping at the first error.
  const MAX_ROUNDS = 12;
  let reflections = 0;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (isRoomInterrupted(input.roomId)) {
      input.onEvent({ type: 'text', data: 'Standing down, Ray.' });
      input.onEvent({ type: 'done', data: { toolCalls: toolLogs, sources: [] } });
      return { handled: true };
    }
    if (plan) messages[1] = { role: 'system', content: ledgerText(plan, toolLogs) };
    if (round >= 2) compactMessages(messages);
    // Long or struggling missions move to the strongest free models first.
    if (!escalated && !pinned && (round >= 3 || reflections > 0)) {
      escalated = true;
      const before = all[0]?.model;
      all = strongFirst(all);
      if (all[0]?.model !== before) emitEngine({ phase: 'escalate', reason: `long mission → ${all[0]?.model}` });
    }
    const out = await completeWithFailover(all, messages, tools, (info) => {
      if (info.provider !== lastProvider) {
        lastProvider = info.provider;
        emitEngine({ provider: info.provider, model: info.model, reason: info.reason ? `failover: ${info.reason}` : undefined });
      }
    }, { kind });

    if (out.toolCalls.length === 0) {
      // Never let the model claim success the tools didn't report (#21).
      const failed = toolLogs.filter(
        (t) =>
          t.status === 'error' ||
          /^(BLOCKED|REQUIRES_CONFIRMATION|Could not|No online|No device|No RAY bridge|Error|Failed|Diagnosis failed|Browser task failed|.*not configured)/i.test(String(t.result || ''))
      );
      const retryable = failed.filter((t) => !/^(BLOCKED|REQUIRES_CONFIRMATION)/i.test(String(t.result || '')) && !t.reflected);
      if (retryable.length && reflections < 2 && round < MAX_ROUNDS - 2 && tools.length) {
        reflections++;
        retryable.forEach((t) => (t.reflected = true));
        emitEngine({ phase: 'reflect', reason: `${retryable.length} step(s) failed — trying alternatives` });
        messages.push({ role: 'assistant', content: out.content || '' });
        messages.push({
          role: 'user',
          content: `[RAY self-check] These steps failed:\n${retryable.map((t) => `- ${t.name}: ${String(t.result || t.status).slice(0, 220)}`).join('\n')}\nThink about every other way to still finish Ray's goal (another device, wake the device first, a different tool, browse_web, operate_computer, a different app or query). If one exists, call the tools now. If it is truly impossible, give the final answer saying exactly what is blocked and why.`,
        });
        continue;
      }
      // Final check against the evidence before saying "done" (once, only for real multi-step work).
      if (!verified && toolLogs.length >= 2 && round < MAX_ROUNDS - 2 && tools.length && (plan || toolLogs.length >= 3)) {
        verified = true;
        const missing = await verifyMission(input.message, toolLogs, out.content || '');
        if (missing) {
          emitEngine({ phase: 'verify', reason: `not finished: ${missing.slice(0, 100)}` });
          messages.push({ role: 'assistant', content: out.content || '' });
          messages.push({ role: 'user', content: `[RAY verify] Not finished yet: ${missing}\nDo the remaining part now with the tools. If it truly cannot be done, say exactly what is left and why.` });
          continue;
        }
      }
      // A failed step RAY recovered from (a later step succeeded) is noted, not reported as unfinished.
      const recovered = failed.filter((t) => t.reflected && toolLogs.slice(toolLogs.indexOf(t) + 1).some((x) => !failed.includes(x) && x.status === 'completed'));
      const unresolved = failed.filter((t) => !recovered.includes(t));
      let text = out.content || (toolLogs.length ? (unresolved.length ? 'Some actions did not complete.' : 'Done.') : '');
      if (unresolved.length) {
        text += `\n\n⚠️ Not completed: ${unresolved.map((t) => `${t.name} — ${String(t.result || t.status).slice(0, 160)}`).join(' · ')}`;
      }
      if (recovered.length) text += `\n\n↻ Recovered: ${recovered.map((t) => t.name).join(', ')} failed, so RAY finished another way.`;
      const answeredBy = `${out.provider.label} · ${out.model}`;
      emitEngine({ answeredBy });
      input.onEvent({ type: 'text', data: text });
      input.onEvent({ type: 'done', data: { toolCalls: toolLogs, sources: [], answeredBy } });
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
export async function quickComplete(
  prompt: string,
  system = 'You are RAY, a concise assistant.',
  kind: TaskKind = 'quick',
  opts: { maxTokens?: number; timeoutMs?: number } = {}
): Promise<string> {
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
    { maxTokens: opts.maxTokens || 800, timeoutMs: opts.timeoutMs || 25000 }
  );
  return out.content;
}

/** Live view of the assignment clause: which engines currently handle each kind of task. */
export async function getEngineAssignments(): Promise<Record<string, string[]>> {
  await loadUsage();
  const labels: Record<TaskKind, string> = {
    quick: 'Quick replies & simple commands',
    chat: 'Everyday chat & writing',
    tools: 'Device actions (open apps/tabs, files, messages)',
    code: 'Code',
    reasoning: 'Hard reasoning & long analysis',
    vision: 'Images & screen reading',
  };
  const out: Record<string, string[]> = {};
  for (const kind of Object.keys(labels) as TaskKind[]) {
    const cands = await buildCandidates(kind, kind === 'tools');
    out[labels[kind]] = cands.slice(0, 4).map((c) => `${c.p.label} · ${c.model}`);
  }
  return out;
}

/** One vision call (screenshot + instructions) across the free vision engines, with failover. */
export async function visionComplete(system: string, userText: string, imageDataUrl: string, maxTokens = 700): Promise<{ text: string; engine: string }> {
  await loadUsage();
  const candidates = await buildCandidates('vision', false);
  if (!candidates.length) throw new Error('No vision-capable engine is configured (Groq, OpenRouter, Gemini, Mistral or Z.ai with a vision model).');
  const out = await completeWithFailover(
    candidates,
    [
      { role: 'system', content: system },
      { role: 'user', content: [{ type: 'text', text: userText }, { type: 'image_url', image_url: { url: imageDataUrl } }] },
    ],
    undefined,
    undefined,
    { maxTokens, timeoutMs: 45000, kind: 'vision' }
  );
  return { text: out.content, engine: `${out.provider.label} · ${out.model}` };
}
