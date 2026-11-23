/**
 * Registry of FREE LLM providers RAY can use. Every provider below has a permanent
 * free tier (no card). All speak the OpenAI chat-completions dialect, so one client
 * drives them all. Add a key in the environment and the router picks it up — no code changes.
 *
 * Limits are the published free-tier numbers; RAY tracks real usage per day and treats
 * HTTP 429 / Retry-After as the source of truth.
 */
import { loadJson, scheduleSave } from '../persistence.ts';

export type TaskKind = 'quick' | 'chat' | 'code' | 'reasoning' | 'vision' | 'tools';
export type ModelTier = 'large' | 'fast' | 'code' | 'vision' | 'reasoning';

export interface ProviderDef {
  id: string;
  label: string;
  baseUrl: () => string | null;
  apiKey: () => string | null;
  /** Requests/day and requests/minute on the free tier (best known values). */
  rpd: number;
  rpm: number;
  supportsTools: boolean;
  /** Model preference per tier: regexes matched against the provider's live /models list, then static fallbacks. */
  tiers: Partial<Record<ModelTier, { prefer: RegExp[]; fallback: string }>>;
  /** Optional filter for the live model list (e.g. OpenRouter ":free" only). */
  modelFilter?: (id: string) => boolean;
  /** Max output tokens to request (per model regex, first match wins). Keeps us under TPM/credit limits. */
  outputCaps?: Array<[RegExp, number]>;
  extraHeaders?: () => Record<string, string>;
  signupUrl: string;
  notes: string;
}

let discoveredCloudflareAccount = '';

/** Find the Cloudflare account id from the API token when CLOUDFLARE_ACCOUNT_ID isn't set. */
async function discoverCloudflareAccount(): Promise<void> {
  const token = env('CLOUDFLARE_API_TOKEN');
  if (!token || env('CLOUDFLARE_ACCOUNT_ID') || discoveredCloudflareAccount) return;
  try {
    const r = await fetch('https://api.cloudflare.com/client/v4/accounts?per_page=5', {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    const j = (await r.json()) as { result?: Array<{ id?: string }> };
    discoveredCloudflareAccount = j.result?.[0]?.id || '';
    if (!discoveredCloudflareAccount) console.warn('[RAY engines] Cloudflare token works but lists no account; set CLOUDFLARE_ACCOUNT_ID.');
  } catch (err) {
    console.warn('[RAY engines] Could not discover Cloudflare account id:', (err as Error).message);
  }
}

function env(name: string): string | null {
  const v = (process.env[name] || '').trim();
  if (!v || /^(unset|none|my_[a-z0-9_]+|changeme)$/i.test(v)) return null;
  return v;
}

export const PROVIDERS: ProviderDef[] = [
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: () => 'https://api.groq.com/openai/v1',
    apiKey: () => env('GROQ_API_KEY'),
    rpd: 14400,
    rpm: 30,
    supportsTools: true,
    // Live test 23 Nov 2026: gpt-oss-120b / 20b correct on maths, JSON and code (~3.6 s).
    // allam-2-7b gave wrong JSON; safeguard/whisper/orpheus/prompt-guard are not chat models.
    tiers: {
      fast: { prefer: [/openai\/gpt-oss-20b$/], fallback: 'openai/gpt-oss-20b' },
      large: { prefer: [/openai\/gpt-oss-120b$/], fallback: 'openai/gpt-oss-120b' },
      reasoning: { prefer: [/openai\/gpt-oss-120b$/], fallback: 'openai/gpt-oss-120b' },
      code: { prefer: [/openai\/gpt-oss-120b$/], fallback: 'openai/gpt-oss-120b' },
      vision: { prefer: [/llama-4-scout/, /llama-4-maverick/], fallback: 'meta-llama/llama-4-scout-17b-16e-instruct' },
    },
    modelFilter: (id) => !/(allam|safeguard|whisper|orpheus|prompt-guard|guard|tts|distil)/i.test(id),
    // Groq free tier: 8K tokens/min on gpt-oss; qwen3.x output budget ~1K/min.
    outputCaps: [[/qwen/i, 700], [/gpt-oss/i, 900], [/.*/, 800]],
    signupUrl: 'https://console.groq.com/keys',
    notes: 'Fastest inference; gpt-oss-120b is RAY’s default brain.',
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    baseUrl: () => 'https://api.cerebras.ai/v1',
    apiKey: () => env('CEREBRAS_API_KEY'),
    rpd: 14400,
    rpm: 30,
    supportsTools: true,
    tiers: {
      fast: { prefer: [/llama3\.1-8b/, /llama-3\.1-8b/], fallback: 'llama3.1-8b' },
      large: { prefer: [/gpt-oss-120b/, /qwen-3-235b/, /llama-3\.3-70b/], fallback: 'llama-3.3-70b' },
      reasoning: { prefer: [/gpt-oss-120b/, /qwen-3-235b.*thinking/, /qwen-3-32b/], fallback: 'gpt-oss-120b' },
      code: { prefer: [/qwen-3-coder/, /qwen-3-235b/, /gpt-oss-120b/], fallback: 'gpt-oss-120b' },
    },
    signupUrl: 'https://cloud.cerebras.ai/',
    notes: 'Ultra-fast, 14.4K requests/day, big open models.',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    baseUrl: () => 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKey: () => env('GEMINI_API_KEY'),
    rpd: 250,
    rpm: 10,
    supportsTools: true,
    tiers: {
      fast: { prefer: [/gemini-[\d.]+-flash-lite(?!.*preview)/, /gemini-[\d.]+-flash-lite/], fallback: 'gemini-2.5-flash-lite' },
      large: { prefer: [/gemini-[\d.]+-flash(?!-lite)(?!.*(image|tts|live|audio))/], fallback: 'gemini-2.5-flash' },
      reasoning: { prefer: [/gemini-[\d.]+-pro(?!.*(image|tts))/], fallback: 'gemini-2.5-pro' },
      code: { prefer: [/gemini-[\d.]+-pro(?!.*(image|tts))/, /gemini-[\d.]+-flash(?!-lite)/], fallback: 'gemini-2.5-flash' },
      vision: { prefer: [/gemini-[\d.]+-flash(?!-lite)(?!.*(image|tts|live|audio))/], fallback: 'gemini-2.5-flash' },
    },
    modelFilter: (id) => /gemini/.test(id) && !/(embedding|aqa|imagen|veo|tts|native-audio|live)/.test(id),
    signupUrl: 'https://aistudio.google.com/app/apikey',
    notes: 'Strongest free multimodal models; lower daily quota.',
  },
  {
    id: 'mistral',
    label: 'Mistral AI',
    baseUrl: () => 'https://api.mistral.ai/v1',
    apiKey: () => env('MISTRAL_API_KEY'),
    rpd: 50000,
    rpm: 60,
    supportsTools: true,
    tiers: {
      fast: { prefer: [/ministral-8b-latest/, /mistral-small-latest/], fallback: 'mistral-small-latest' },
      large: { prefer: [/mistral-large-latest/, /mistral-medium-latest/], fallback: 'mistral-large-latest' },
      reasoning: { prefer: [/magistral-medium-latest/, /mistral-large-latest/], fallback: 'mistral-large-latest' },
      code: { prefer: [/codestral-latest/, /devstral/], fallback: 'codestral-latest' },
      vision: { prefer: [/pixtral-large-latest/, /mistral-medium-latest/, /mistral-small-latest/], fallback: 'pixtral-large-latest' },
    },
    signupUrl: 'https://console.mistral.ai/api-keys',
    notes: '1B tokens/month free (Experiment plan), 1 req/sec.',
  },
  {
    id: 'github',
    label: 'GitHub Models',
    baseUrl: () => 'https://models.github.ai/inference',
    apiKey: () => env('GITHUB_MODELS_TOKEN') || env('GITHUB_TOKEN'),
    rpd: 150,
    rpm: 15,
    supportsTools: true,
    tiers: {
      fast: { prefer: [/gpt-4\.1-mini/, /gpt-4o-mini/], fallback: 'openai/gpt-4.1-mini' },
      large: { prefer: [/openai\/gpt-4\.1$/, /openai\/gpt-4o$/], fallback: 'openai/gpt-4.1' },
      reasoning: { prefer: [/o4-mini/, /deepseek-r1/, /gpt-4\.1$/], fallback: 'openai/gpt-4.1' },
      code: { prefer: [/gpt-4\.1$/, /codestral/], fallback: 'openai/gpt-4.1' },
      vision: { prefer: [/gpt-4\.1$/, /gpt-4o$/], fallback: 'openai/gpt-4.1' },
    },
    signupUrl: 'https://github.com/marketplace/models',
    notes: 'GPT-4.1 / o-series for free with a GitHub token (Models permission).',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter (free models)',
    baseUrl: () => 'https://openrouter.ai/api/v1',
    apiKey: () => env('OPENROUTER_API_KEY'),
    rpd: 1000,
    rpm: 20,
    supportsTools: true,
    // Pinned from the live test (23 Nov 2026). "openrouter/free" is NOT used: it is an
    // auto-router that stalled and can pick paid/image models.
    tiers: {
      fast: { prefer: [/recursive\/flint-v1\.0:free/, /nemotron-3\.5-super-vl:free/, /nemotron-3\.5-lightning:free/], fallback: 'nvidia/nemotron-3.5-lightning:free' },
      large: { prefer: [/nemotron-3\.5-lightning:free/, /gemma-4-26b-a4b-it:free/, /gemma-4-31b-it:free/], fallback: 'nvidia/nemotron-3.5-lightning:free' },
      reasoning: { prefer: [/nemotron-3-ultra-550b.*:free/, /gemma-4-31b-it:free/, /nemotron-3-nano-omni.*reasoning:free/], fallback: 'google/gemma-4-31b-it:free' },
      code: { prefer: [/nemotron-3\.5-lightning:free/, /gemma-4-31b-it:free/], fallback: 'nvidia/nemotron-3.5-lightning:free' },
      vision: { prefer: [/nemotron-3\.5-super-vl:free/, /gemma-4-26b-a4b-it:free/], fallback: 'nvidia/nemotron-3.5-super-vl:free' },
    },
    modelFilter: (id) => id.endsWith(':free') && !/(lfm-3-1\.7b|ernie)/i.test(id),
    // The account can afford ~3.5K output tokens; free models are capped too so nothing asks for 65K.
    outputCaps: [[/ultra/i, 1500], [/.*/, 1024]],
    extraHeaders: () => ({ 'HTTP-Referer': process.env.APP_URL || 'https://ray.local', 'X-Title': 'RAY Assistant' }),
    signupUrl: 'https://openrouter.ai/keys',
    notes: '26 free models verified; pinned to the reliable ones.',
  },
  {
    id: 'opencode',
    label: 'OpenCode Zen',
    // OpenCode Zen is an OpenAI-compatible gateway (keys start with "oc_sk_").
    baseUrl: () => (env('OPENCODE_BASE_URL') || 'https://opencode.ai/zen/v1').replace(/\/+$/, ''),
    apiKey: () => env('OPENCODE_API_KEY'),
    rpd: 1000,
    rpm: 20,
    supportsTools: true,
    tiers: {
      fast: { prefer: [/big-pickle/, /-free$/, /mini|flash/i], fallback: process.env.OPENCODE_MODEL || 'big-pickle' },
      large: { prefer: [/big-pickle/, /-free$/], fallback: process.env.OPENCODE_MODEL || 'big-pickle' },
      reasoning: { prefer: [/big-pickle/, /-free$/], fallback: process.env.OPENCODE_MODEL || 'big-pickle' },
      code: { prefer: [/big-pickle/, /coder.*-free$|-free$/], fallback: process.env.OPENCODE_MODEL || 'big-pickle' },
    },
    outputCaps: [[/.*/, 1500]],
    signupUrl: 'https://opencode.ai/zen',
    notes: 'Free "big-pickle" coding/chat model via OpenCode Zen.',
  },
  {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    baseUrl: () => 'https://integrate.api.nvidia.com/v1',
    apiKey: () => env('NVIDIA_API_KEY'),
    rpd: 5000,
    rpm: 40,
    supportsTools: true,
    tiers: {
      fast: { prefer: [/meta\/llama-3\.1-8b-instruct/], fallback: 'meta/llama-3.1-8b-instruct' },
      large: { prefer: [/meta\/llama-3\.3-70b-instruct/, /qwen3-235b/], fallback: 'meta/llama-3.3-70b-instruct' },
      reasoning: { prefer: [/deepseek-r1/, /qwen3-235b/, /nemotron.*ultra/], fallback: 'meta/llama-3.3-70b-instruct' },
      code: { prefer: [/qwen.*coder/, /codestral/], fallback: 'meta/llama-3.3-70b-instruct' },
      vision: { prefer: [/llama-3\.2-90b-vision/, /llama-4-maverick/], fallback: 'meta/llama-3.2-90b-vision-instruct' },
    },
    signupUrl: 'https://build.nvidia.com/explore/discover',
    notes: '40 req/min across many open models.',
  },
  {
    id: 'cloudflare',
    label: 'Cloudflare Workers AI',
    baseUrl: () => {
      const acct = env('CLOUDFLARE_ACCOUNT_ID') || discoveredCloudflareAccount;
      return acct ? `https://api.cloudflare.com/client/v4/accounts/${acct}/ai/v1` : null;
    },
    // A Cloudflare user token ("cfut_…") is enough: the account id is discovered automatically.
    apiKey: () => env('CLOUDFLARE_API_TOKEN'),
    rpd: 1000,
    rpm: 50,
    supportsTools: false,
    tiers: {
      fast: { prefer: [], fallback: '@cf/meta/llama-3.1-8b-instruct-fast' },
      large: { prefer: [], fallback: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' },
      reasoning: { prefer: [], fallback: '@cf/qwen/qwq-32b' },
      code: { prefer: [], fallback: '@cf/qwen/qwen2.5-coder-32b-instruct' },
    },
    signupUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    notes: '10K neurons/day, 49+ models.',
  },
  {
    id: 'sambanova',
    label: 'SambaNova Cloud',
    baseUrl: () => 'https://api.sambanova.ai/v1',
    apiKey: () => env('SAMBANOVA_API_KEY'),
    rpd: 2000,
    rpm: 20,
    supportsTools: true,
    tiers: {
      fast: { prefer: [/Meta-Llama-3\.1-8B/], fallback: 'Meta-Llama-3.1-8B-Instruct' },
      large: { prefer: [/Meta-Llama-3\.3-70B/, /DeepSeek-V3/], fallback: 'Meta-Llama-3.3-70B-Instruct' },
      reasoning: { prefer: [/DeepSeek-R1/, /Qwen3-32B/], fallback: 'DeepSeek-R1-Distill-Llama-70B' },
    },
    signupUrl: 'https://cloud.sambanova.ai/apis',
    notes: 'Fast DeepSeek / Llama on free tier.',
  },
  {
    id: 'huggingface',
    label: 'Hugging Face Inference',
    baseUrl: () => 'https://router.huggingface.co/v1',
    apiKey: () => env('HUGGINGFACE_API_KEY') || env('HF_TOKEN'),
    rpd: 300,
    rpm: 10,
    supportsTools: false,
    tiers: {
      fast: { prefer: [], fallback: 'meta-llama/Llama-3.1-8B-Instruct' },
      large: { prefer: [], fallback: 'meta-llama/Llama-3.3-70B-Instruct' },
      code: { prefer: [], fallback: 'Qwen/Qwen2.5-Coder-32B-Instruct' },
    },
    signupUrl: 'https://huggingface.co/settings/tokens',
    notes: 'Monthly free credits across thousands of open models.',
  },
  {
    id: 'cohere',
    label: 'Cohere',
    baseUrl: () => 'https://api.cohere.ai/compatibility/v1',
    apiKey: () => env('COHERE_API_KEY'),
    rpd: 33,
    rpm: 20,
    supportsTools: true,
    tiers: {
      fast: { prefer: [], fallback: 'command-r7b-12-2024' },
      large: { prefer: [], fallback: 'command-a-03-2025' },
    },
    signupUrl: 'https://dashboard.cohere.com/api-keys',
    notes: 'Trial key: 1K requests/month.',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    // Pay-as-you-go but very cheap; new accounts have been reported to get a one-time token grant.
    baseUrl: () => (env('DEEPSEEK_BASE_URL') || 'https://api.deepseek.com').replace(/\/+$/, ''),
    apiKey: () => env('DEEPSEEK_API_KEY'),
    rpd: Number(process.env.DEEPSEEK_RPD || 5000),
    rpm: 60,
    supportsTools: true,
    tiers: {
      fast: { prefer: [/flash/i, /deepseek-chat/], fallback: 'deepseek-chat' },
      large: { prefer: [/deepseek-chat/, /flash/i], fallback: 'deepseek-chat' },
      reasoning: { prefer: [/reasoner/, /pro/i], fallback: 'deepseek-reasoner' },
      code: { prefer: [/deepseek-chat/, /coder/i], fallback: 'deepseek-chat' },
    },
    outputCaps: [[/reasoner|pro/i, 2000], [/.*/, 1200]],
    signupUrl: 'https://platform.deepseek.com/api_keys',
    notes: 'Strong reasoning/coding at very low cost (not a permanent free tier).',
  },
  {
    id: 'zhipu',
    label: 'Zhipu GLM (Flash models free)',
    baseUrl: () => (env('ZHIPU_BASE_URL') || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, ''),
    apiKey: () => env('ZHIPU_API_KEY'),
    rpd: 5000,
    rpm: 30,
    supportsTools: true,
    tiers: {
      fast: { prefer: [/glm-[\d.]+-flash$/i, /flash/i], fallback: 'glm-4-flash' },
      large: { prefer: [/glm-[\d.]+-flash$/i, /flash/i], fallback: 'glm-4-flash' },
      code: { prefer: [/glm-[\d.]+-flash$/i], fallback: 'glm-4-flash' },
      vision: { prefer: [/glm-[\d.]+v-flash/i], fallback: 'glm-4v-flash' },
    },
    modelFilter: (id) => /flash/i.test(id),
    outputCaps: [[/.*/, 1024]],
    signupUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    notes: 'GLM Flash models are free of charge.',
  },
  {
    id: 'siliconflow',
    label: 'SiliconFlow',
    baseUrl: () => (env('SILICONFLOW_BASE_URL') || 'https://api.siliconflow.com/v1').replace(/\/+$/, ''),
    apiKey: () => env('SILICONFLOW_API_KEY'),
    rpd: 2000,
    rpm: 30,
    supportsTools: true,
    tiers: {
      fast: { prefer: [/Qwen\/Qwen[\d.]+-7B-Instruct$/, /7B|8B|9B/], fallback: 'Qwen/Qwen2.5-7B-Instruct' },
      large: { prefer: [/Qwen\/Qwen[\d.]+-7B-Instruct$/, /glm-4-9b/i], fallback: 'Qwen/Qwen2.5-7B-Instruct' },
      code: { prefer: [/Coder-7B/i, /7B/], fallback: 'Qwen/Qwen2.5-Coder-7B-Instruct' },
    },
    outputCaps: [[/.*/, 1024]],
    signupUrl: 'https://cloud.siliconflow.com/account/ak',
    notes: 'Several small open models (Qwen/GLM 7–9B) are free.',
  },
  {
    id: 'dashscope',
    label: 'Alibaba Qwen (DashScope)',
    baseUrl: () => (env('DASHSCOPE_BASE_URL') || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, ''),
    apiKey: () => env('DASHSCOPE_API_KEY'),
    rpd: 2000,
    rpm: 30,
    supportsTools: true,
    tiers: {
      fast: { prefer: [/qwen-flash$/, /qwen-turbo$/], fallback: 'qwen-turbo' },
      large: { prefer: [/qwen-plus$/], fallback: 'qwen-plus' },
      reasoning: { prefer: [/qwen-max$/, /qwen-plus$/], fallback: 'qwen-plus' },
      code: { prefer: [/qwen.*coder-plus$/, /qwen-plus$/], fallback: 'qwen-plus' },
      vision: { prefer: [/qwen-vl-plus$/, /qwen-vl-max$/], fallback: 'qwen-vl-plus' },
    },
    outputCaps: [[/.*/, 1200]],
    signupUrl: 'https://modelstudio.console.alibabacloud.com/',
    notes: 'Free token quota for new accounts (time-limited), then pay-as-you-go.',
  },
  {
    id: 'novita',
    label: 'Novita AI',
    baseUrl: () => (env('NOVITA_BASE_URL') || 'https://api.novita.ai/v3/openai').replace(/\/+$/, ''),
    apiKey: () => env('NOVITA_API_KEY'),
    rpd: 2000,
    rpm: 30,
    supportsTools: true,
    tiers: {
      fast: { prefer: [/llama-3\.1-8b/i], fallback: 'meta-llama/llama-3.1-8b-instruct' },
      large: { prefer: [/deepseek.*v3/i, /llama-3\.3-70b/i], fallback: 'meta-llama/llama-3.3-70b-instruct' },
      reasoning: { prefer: [/deepseek.*r1/i], fallback: 'deepseek/deepseek-r1' },
    },
    outputCaps: [[/.*/, 1024]],
    signupUrl: 'https://novita.ai/settings/key-management',
    notes: 'Sign-up credit; many open models.',
  },
  {
    id: 'custom',
    label: process.env.CUSTOM_LLM_LABEL || 'Custom OpenAI-compatible',
    // Any OpenAI-compatible endpoint: LM Studio, vLLM, LocalAI, Together, DeepInfra, a friend's server…
    baseUrl: () => env('CUSTOM_LLM_BASE_URL')?.replace(/\/+$/, '') || null,
    apiKey: () => (env('CUSTOM_LLM_BASE_URL') ? env('CUSTOM_LLM_API_KEY') || 'none' : null),
    rpd: Number(process.env.CUSTOM_LLM_RPD || 100000),
    rpm: Number(process.env.CUSTOM_LLM_RPM || 120),
    supportsTools: !/^(0|false|no)$/i.test(process.env.CUSTOM_LLM_TOOLS || 'true'),
    tiers: {
      fast: { prefer: [], fallback: process.env.CUSTOM_LLM_MODEL || 'default' },
      large: { prefer: [], fallback: process.env.CUSTOM_LLM_MODEL || 'default' },
      reasoning: { prefer: [], fallback: process.env.CUSTOM_LLM_MODEL || 'default' },
      code: { prefer: [], fallback: process.env.CUSTOM_LLM_MODEL || 'default' },
      vision: { prefer: [], fallback: process.env.CUSTOM_LLM_MODEL || 'default' },
    },
    signupUrl: 'https://lmstudio.ai',
    notes: 'Bring your own OpenAI-compatible endpoint (LM Studio, vLLM, LocalAI…).',
  },
  {
    id: 'llm7',
    label: 'LLM7.io (no signup)',
    baseUrl: () => 'https://api.llm7.io/v1',
    // Works without a key; a free token from token.llm7.io raises limits.
    apiKey: () => env('LLM7_API_KEY') || 'unused',
    rpd: 5000,
    rpm: 30,
    supportsTools: true,
    tiers: {
      fast: { prefer: [/gpt-4\.1-nano/, /mistral-small/, /flash-lite/], fallback: 'gpt-4.1-nano' },
      large: { prefer: [/deepseek-v3/, /gpt-4\.1-mini/, /qwen/], fallback: 'gpt-4.1-mini' },
      reasoning: { prefer: [/deepseek-r1/, /o4-mini/], fallback: 'deepseek-r1' },
      code: { prefer: [/qwen.*coder/, /codestral/], fallback: 'qwen2.5-coder-32b-instruct' },
    },
    signupUrl: 'https://token.llm7.io',
    notes: 'Always-available last resort — works with no key at all.',
  },
];

// ---------------------------------------------------------------------------
// Live model discovery (cached) so new model names are picked up automatically
// ---------------------------------------------------------------------------

const modelCache = new Map<string, { at: number; models: string[] }>();

export async function listProviderModels(p: ProviderDef): Promise<string[]> {
  const cached = modelCache.get(p.id);
  if (cached && Date.now() - cached.at < 6 * 3600_000) return cached.models;
  const base = p.baseUrl();
  const key = p.apiKey();
  if (!base || !key) return [];
  try {
    const r = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${key}`, ...(p.extraHeaders?.() || {}) },
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) throw new Error(String(r.status));
    const j = (await r.json()) as { data?: Array<{ id?: string; name?: string }> } | Array<{ id?: string; name?: string }>;
    const arr = Array.isArray(j) ? j : j.data || [];
    const models = arr
      .map((m) => String(m.id || m.name || '').replace(/^models\//, ''))
      .filter(Boolean)
      .filter((id) => (p.modelFilter ? p.modelFilter(id) : true));
    modelCache.set(p.id, { at: Date.now(), models });
    return models;
  } catch {
    modelCache.set(p.id, { at: Date.now() - 5.5 * 3600_000, models: [] }); // retry in ~30 min
    return [];
  }
}

export async function resolveModel(p: ProviderDef, tier: ModelTier): Promise<string | null> {
  const spec = p.tiers[tier] || p.tiers.large || p.tiers.fast;
  if (!spec) return null;
  const live = await listProviderModels(p);
  for (const re of spec.prefer) {
    const hit = live.filter((m) => re.test(m)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
    if (hit) return hit;
  }
  return spec.fallback;
}

export function isProviderConfigured(p: ProviderDef): boolean {
  return Boolean(p.baseUrl() && p.apiKey());
}

// ---------------------------------------------------------------------------
// Usage tracking + cooldowns (persisted so limits survive restarts)
// ---------------------------------------------------------------------------

interface UsageDay {
  day: string;
  requests: Record<string, number>;
  tokens: Record<string, number>;
  failures: Record<string, number>;
}

let usage: UsageDay = { day: today(), requests: {}, tokens: {}, failures: {} };
const cooldownUntil = new Map<string, number>();
const minuteWindow = new Map<string, number[]>();
let usageLoaded = false;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function loadUsage(): Promise<void> {
  if (usageLoaded) return;
  usageLoaded = true;
  await discoverCloudflareAccount();
  const stored = await loadJson<UsageDay & Record<string, unknown>>('engine-usage');
  if (stored && stored.day === today()) usage = { ...usage, ...stored };
}

function rollDay(): void {
  if (usage.day !== today()) usage = { day: today(), requests: {}, tokens: {}, failures: {} };
}

export function recordUsage(providerId: string, tokens: number): void {
  rollDay();
  usage.requests[providerId] = (usage.requests[providerId] || 0) + 1;
  usage.tokens[providerId] = (usage.tokens[providerId] || 0) + Math.max(0, tokens || 0);
  const win = (minuteWindow.get(providerId) || []).filter((t) => Date.now() - t < 60_000);
  win.push(Date.now());
  minuteWindow.set(providerId, win);
  scheduleSave('engine-usage', () => ({ ...usage }), 4000);
}

/**
 * Cooldowns are per MODEL for rate/credit/size errors (Groq limits each model separately,
 * OpenRouter free models still work when paid ones lack credit) and per PROVIDER for bad keys.
 */
export function recordFailure(providerId: string, status: number, retryAfterSec?: number, model?: string): void {
  rollDay();
  usage.failures[providerId] = (usage.failures[providerId] || 0) + 1;
  const modelKey = model ? `${providerId}|${model}` : providerId;
  if (status === 401 || status === 403) {
    cooldownUntil.set(providerId, Date.now() + 3600_000); // bad key – stop hammering
    return;
  }
  let cool = 0;
  if (status === 429) cool = Math.max(10, Math.min(3600, retryAfterSec || 60));
  else if (status === 402) cool = 6 * 3600; // needs credit – skip for hours
  else if (status === 413) cool = Math.max(30, retryAfterSec || 60); // request too large for TPM
  else if (status === 404) cool = 24 * 3600; // model gone
  else if (status >= 500 || status === 0 || status === 408) cool = 30;
  if (cool) cooldownUntil.set(modelKey, Date.now() + cool * 1000);
}

export function isModelAvailable(p: ProviderDef, model: string): boolean {
  return isAvailable(p) && (cooldownUntil.get(`${p.id}|${model}`) || 0) <= Date.now();
}

/** Output-token cap for a model (never the 65K some providers default to). */
export function maxTokensFor(p: ProviderDef, model: string, kind: string): number {
  const cap = p.outputCaps?.find(([re]) => re.test(model))?.[1] ?? 1024;
  const want = kind === 'quick' ? 400 : kind === 'reasoning' || kind === 'code' ? 1500 : 800;
  return Math.min(cap, want);
}

/** 0..1 share of today's free quota already used. */
export function quotaUsed(p: ProviderDef): number {
  rollDay();
  return (usage.requests[p.id] || 0) / Math.max(1, p.rpd);
}

/** Server-enforced daily budget across all engines (RAY_DAILY_TOKEN_CAP, 0 = unlimited). */
export function dailyBudget(): { usedTokens: number; capTokens: number; exceeded: boolean } {
  rollDay();
  const usedTokens = Object.values(usage.tokens).reduce((a, b) => a + b, 0);
  const capTokens = Number(process.env.RAY_DAILY_TOKEN_CAP || 0) || 0;
  return { usedTokens, capTokens, exceeded: capTokens > 0 && usedTokens >= capTokens };
}

export function isAvailable(p: ProviderDef): boolean {
  if (!isProviderConfigured(p)) return false;
  if (p.id !== 'custom' && dailyBudget().exceeded) return false;
  if ((cooldownUntil.get(p.id) || 0) > Date.now()) return false;
  if (quotaUsed(p) >= 0.98) return false;
  const win = (minuteWindow.get(p.id) || []).filter((t) => Date.now() - t < 60_000);
  return win.length < p.rpm;
}

export function getEngineStatus() {
  rollDay();
  return PROVIDERS.map((p) => ({
    id: p.id,
    label: p.label,
    configured: isProviderConfigured(p),
    available: isAvailable(p),
    requestsToday: usage.requests[p.id] || 0,
    tokensToday: usage.tokens[p.id] || 0,
    failuresToday: usage.failures[p.id] || 0,
    dailyLimit: p.rpd,
    quotaUsedPct: Math.round(quotaUsed(p) * 100),
    coolingDownSec: Math.max(0, Math.round(((cooldownUntil.get(p.id) || 0) - Date.now()) / 1000)),
    supportsTools: p.supportsTools,
    signupUrl: p.signupUrl,
    notes: p.notes,
  }));
}
