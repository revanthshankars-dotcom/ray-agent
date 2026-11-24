/**
 * ENGINE BALANCE — what each AI provider says is left, not RAY's own guess.
 *
 * Sources, best first:
 *   1. Provider rate-limit headers on every reply (Groq, Mistral, Cerebras, GitHub, OpenRouter…):
 *      x-ratelimit-limit-* / x-ratelimit-remaining-* / x-ratelimit-reset-*.
 *   2. Provider limit errors, parsed into numbers: Groq "tokens per day (TPD): Limit 200000, Used 198962",
 *      OpenRouter "free-models-per-day", Gemini "Quota exceeded … limit: 250", Zhipu "余额不足"
 *      (insufficient balance), OpenCode "Free usage limit reached".
 *   3. Balance APIs: OpenRouter /key, SiliconFlow /user/info, DeepSeek /user/balance.
 *   4. Only where a provider publishes nothing: RAY's own count against the published free limit,
 *      clearly marked as an estimate.
 * Models a provider has said are used up are skipped by the router until their reset.
 */
import { loadJson, scheduleSave } from '../persistence.ts';

export type Window = 'minute' | 'day' | 'month' | 'balance' | 'window';
export interface Meter {
  key: string;
  scope: string; // model name, or '' for the whole account
  unit: 'requests' | 'tokens' | 'credit';
  window: Window;
  limit?: number;
  remaining: number;
  resetsAt?: number;
  currency?: string;
  source: 'provider' | 'estimate';
  rolling?: boolean; // refills gradually (Groq), no single reset time
  since?: number; // estimates: RAY started counting at this time
  at: number;
}
export interface Block {
  scope: string; // model, or '*' = every model of the provider (credit/account limit)
  reason: string;
  until?: number; // undefined = until credit is added (re-checked every 6 h)
  at: number;
  skip?: boolean; // not a limit: a model that can't chat
}
interface ProviderState {
  meters: Record<string, Meter>;
  blocks: Block[];
  tokensByModel: Record<string, number>;
  requestsByModel: Record<string, number>;
  probedAt?: number;
  probeNote?: string;
  countSince?: number;
  lastOkAt?: number;
  lastOkModel?: string;
}
interface Saved {
  day: string;
  providers: Record<string, ProviderState>;
}

const today = () => new Date().toISOString().slice(0, 10);
const nextUtcMidnight = () => {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
};

let state: Saved = { day: today(), providers: {} };
let loaded = false;
async function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  const s = (await loadJson<Record<string, unknown>>('engine-balance').catch(() => null)) as unknown as Saved | null;
  if (s?.providers) state = s;
  roll();
}
void ensureLoaded();

function roll() {
  const now = Date.now();
  if (state.day !== today()) {
    // New UTC day: daily counters restart; daily meters past their reset are dropped.
    state.day = today();
    for (const p of Object.values(state.providers)) {
      p.tokensByModel = {};
      p.requestsByModel = {};
      p.countSince = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
    }
  }
  for (const p of Object.values(state.providers)) {
    for (const [k, m] of Object.entries(p.meters)) {
      if ((m.resetsAt && m.resetsAt < now) || (m.window === 'minute' && now - m.at > 120_000)) delete p.meters[k];
    }
    p.blocks = p.blocks.filter((b) => (b.until ? b.until > now : now - b.at < 6 * 3600_000));
  }
}
function prov(id: string): ProviderState {
  roll();
  return (state.providers[id] ||= { meters: {}, blocks: [], tokensByModel: {}, requestsByModel: {}, countSince: Date.now() });
}
const save = () => scheduleSave('engine-balance', () => state as unknown as Record<string, unknown>, 60_000);

// Groq / Cerebras / GitHub limit each model separately; the rest limit the account.
const PER_MODEL = new Set(['groq', 'cerebras', 'github', 'gemini']);
// Accounts with free AND paid models: a credit error only concerns the paid model.
const MIXED_FREE_PAID = new Set(['siliconflow', 'openrouter', 'novita', 'llm7', 'cloudflare']);
const scopeOf = (id: string, model: string) => (PER_MODEL.has(id) ? model : '');

function setMeter(id: string, m: Omit<Meter, 'key' | 'at'>) {
  const p = prov(id);
  const key = `${m.scope}|${m.unit}|${m.window}`;
  p.meters[key] = { ...m, key, at: Date.now() };
}
function block(id: string, scope: string, reason: string, until?: number, skip?: boolean) {
  const p = prov(id);
  p.blocks = p.blocks.filter((b) => b.scope !== scope);
  p.blocks.push({ scope, reason, until, at: Date.now(), ...(skip ? { skip: true } : {}) });
}

/** "2m59.56s", "7.66s", "1h2m", "30", epoch seconds or epoch ms → absolute ms. */
function parseReset(v: string | null | undefined): number | undefined {
  if (!v) return undefined;
  const s = v.trim();
  if (/^\d{13}$/.test(s)) return Number(s);
  if (/^\d{10}$/.test(s)) return Number(s) * 1000;
  if (/^\d+(\.\d+)?$/.test(s)) return Date.now() + Number(s) * 1000;
  const m = s.match(/^(?:(\d+)h)?(?:(\d+)m(?!s))?(?:([\d.]+)s)?(?:(\d+)ms)?$/);
  if (m && (m[1] || m[2] || m[3] || m[4])) return Date.now() + ((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 1000 + (+m[4] || 0);
  const d = Date.parse(s);
  return Number.isFinite(d) ? d : undefined;
}

// Groq documents: "requests" headers = per DAY, "tokens" headers = per MINUTE.
const DEFAULT_WINDOW: Record<string, { requests: Window; tokens: Window }> = {
  groq: { requests: 'day', tokens: 'minute' },
};

/** Read x-ratelimit-* headers from any provider reply (success or error). */
export function noteHeaders(id: string, model: string, headers: Headers) {
  const groups = new Map<string, { limit?: number; remaining?: number; reset?: number }>();
  headers.forEach((value, name) => {
    const m = name.toLowerCase().match(/^x-ratelimit-(limit|remaining|reset)(?:-(.+))?$/);
    if (!m) return;
    const suffix = m[2] || 'requests';
    const g = groups.get(suffix) || {};
    if (m[1] === 'reset') g.reset = parseReset(value);
    else if (Number.isFinite(Number(value))) g[m[1] as 'limit' | 'remaining'] = Number(value);
    groups.set(suffix, g);
  });
  if (!groups.size) return;
  for (const [suffix, g] of groups) {
    if (g.remaining === undefined) continue;
    const unit = /tok/.test(suffix) ? 'tokens' : 'requests';
    let window: Window = /day/.test(suffix) ? 'day' : /month/.test(suffix) ? 'month' : /min/.test(suffix) ? 'minute' : DEFAULT_WINDOW[id]?.[unit] || 'window';
    // OpenRouter's plain x-ratelimit-* with a reset hours away is its free-models-per-day cap.
    if (window === 'window' && g.reset && g.reset - Date.now() > 3600_000) window = 'day';
    // A "per day" header whose reset is minutes away is a rolling window (Groq refills request by request).
    const rolling = window === 'day' && Boolean(g.reset && g.reset - Date.now() < 3 * 3600_000);
    setMeter(id, { scope: scopeOf(id, model), unit, window, limit: g.limit, remaining: g.remaining, resetsAt: rolling ? undefined : g.reset, rolling, source: 'provider' });
  }
  save();
}

/** Count what RAY itself used (only shown where the provider reports nothing). */
export function noteSuccess(id: string, model: string, tokens: number) {
  const p = prov(id);
  p.tokensByModel[model] = (p.tokensByModel[model] || 0) + Math.max(0, tokens || 0);
  p.requestsByModel[model] = (p.requestsByModel[model] || 0) + 1;
  p.lastOkAt = Date.now();
  p.lastOkModel = model;
  // A success means any block on this model has lifted.
  p.blocks = p.blocks.filter((b) => b.scope !== model && !(b.scope === '*' && b.until === undefined));
  save();
}

/**
 * Turn a provider's limit error into exact numbers and a block. Returns seconds until the provider
 * says it resets (so the router can skip it that long), when known.
 */
export function noteError(id: string, model: string, status: number, message: string, headers?: Headers): number | undefined {
  if (headers) noteHeaders(id, model, headers);
  const msg = String(message || '');
  const low = msg.toLowerCase();
  const scope = scopeOf(id, model);
  const tryIn = msg.match(/(?:try again|retry) in (?:(\d+)h)?(?:(\d+)m)?([\d.]+)s/i);
  const tryAt = tryIn ? Date.now() + ((+tryIn[1] || 0) * 3600 + (+tryIn[2] || 0) * 60 + (+tryIn[3] || 0)) * 1000 : undefined;
  let until: number | undefined;

  // Groq: "on tokens per day (TPD): Limit 200000, Used 198962, Requested 5044"
  const g = msg.match(/(tokens|requests) per (day|minute) \((?:TPD|RPD|TPM|RPM)\): Limit (\d+), Used (\d+)(?:, Requested (\d+))?/i);
  if (g) {
    const unit = g[1].toLowerCase() === 'tokens' ? 'tokens' : 'requests';
    const window: Window = g[2].toLowerCase() === 'day' ? 'day' : 'minute';
    const limit = Number(g[3]);
    const remaining = Math.max(0, limit - Number(g[4]));
    setMeter(id, { scope: model, unit, window, limit, remaining, resetsAt: window === 'day' ? tryAt || nextUtcMidnight() : tryAt, source: 'provider' });
    if (window === 'day') {
      until = tryAt || nextUtcMidnight();
      block(id, model, `${unit === 'tokens' ? 'Daily tokens' : 'Daily requests'} used up (${remaining.toLocaleString()} of ${limit.toLocaleString()} left, a request needs ~${Number(g[5] || 0).toLocaleString()})`, until);
    }
  } else if (/free-models-per-day/.test(low)) {
    // OpenRouter: daily cap on free-model requests (50 without credits, 1000 after buying 10).
    const reset = headers ? parseReset(headers.get('x-ratelimit-reset')) : undefined;
    const lim = headers ? Number(headers.get('x-ratelimit-limit')) : NaN;
    until = reset || nextUtcMidnight();
    setMeter(id, { scope: '', unit: 'requests', window: 'day', limit: Number.isFinite(lim) && lim > 0 ? lim : undefined, remaining: 0, resetsAt: until, source: 'provider' });
    block(id, '*', 'Free-model requests for today used up (OpenRouter daily cap; buying 10 credits raises it to 1,000/day)', until);
  } else if (/余额不足|无可用资源包|充值|insufficient (balance|credit|funds|quota)|top ?up|recharge|out of credits?|credit balance is too low|payment required/.test(low) || status === 402) {
    const zh = /余额不足|无可用资源包|充值/.test(msg);
    if (MIXED_FREE_PAID.has(id)) {
      // Free and paid models share the account: only this (paid) model needs credit.
      block(id, model, `Needs paid credit${zh ? ' ("余额不足" = insufficient balance)' : ''} — RAY uses the free models instead`, Date.now() + 6 * 3600_000, true);
    } else {
      setMeter(id, { scope: '', unit: 'credit', window: 'balance', remaining: 0, source: 'provider' });
      block(id, '*', zh ? 'No balance left ("余额不足" = insufficient balance — the free credit is used up; top up to continue)' : 'No credit left on this account (top up to continue)');
    }
  } else if (/quota exceeded.*(per ?day|perday|daily)|generate_content_free_tier_requests|requests? per day/i.test(msg)) {
    // Gemini: "Quota exceeded for metric: …free_tier_requests, limit: 250, model: gemini-2.5-flash … Please retry in 41s"
    const lim = msg.match(/limit: (\d+)/i);
    until = /per ?day|perday|daily/i.test(msg) ? nextUtcMidnight() : tryAt;
    setMeter(id, { scope, unit: 'requests', window: until === tryAt ? 'minute' : 'day', limit: lim ? Number(lim[1]) : undefined, remaining: 0, resetsAt: until, source: 'provider' });
    if (until && until - Date.now() > 10 * 60_000) block(id, scope || '*', `Free requests used up${lim ? ` (limit ${lim[1]})` : ''}`, until);
  } else if (/free usage limit|usage limit reached|daily (limit|quota)|exceeded your (current )?quota|monthly (limit|quota)|limit for today/.test(low)) {
    until = tryAt || nextUtcMidnight();
    const monthly = /month/.test(low);
    setMeter(id, { scope: '', unit: 'requests', window: monthly ? 'month' : 'day', remaining: 0, resetsAt: monthly ? undefined : until, source: 'provider' });
    block(id, '*', `Free usage used up (${msg.replace(/^[^:]*\([^)]*\):\s*/, '').slice(0, 90)})`, monthly ? undefined : until);
  } else if (/does not support chat|not a chat model|model.*not.*(exist|found)/.test(low)) {
    block(id, model, 'This model cannot chat (skipped)', Date.now() + 24 * 3600_000, true);
  }
  save();
  return until ? Math.max(60, Math.round((until - Date.now()) / 1000)) : undefined;
}

/** True when the provider has said this model (or the whole account) can't answer right now. */
export function blockedReason(id: string, model?: string): string | null {
  const p = state.providers[id];
  if (!p) return null;
  const now = Date.now();
  const b = p.blocks.find((x) => (x.scope === '*' || (model && x.scope === model)) && (x.until ? x.until > now : now - x.at < 6 * 3600_000));
  return b ? b.reason : null;
}

/** Worth re-testing now: nothing blocked, or only "no credit" marks (they have no known reset). */
export function canRecheck(id: string): boolean {
  const p = state.providers[id];
  return !p || !p.blocks.some((b) => b.scope === '*' && b.until && b.until > Date.now());
}

// --- balance APIs ------------------------------------------------------------------------------------
export interface ProbeTarget {
  id: string;
  baseUrl: string;
  apiKey: string;
  requestsToday?: number; // RAY's older per-provider counter (survives restarts)
}

async function getJson(url: string, key: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    return (await r.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Ask providers that have a balance/key API. Cached 10 minutes unless forced. */
export async function probeBalances(targets: ProbeTarget[], force = false) {
  await ensureLoaded();
  await Promise.all(
    targets.map(async (t) => {
      const p = prov(t.id);
      if (!force && p.probedAt && Date.now() - p.probedAt < 10 * 60_000) return;
      p.probedAt = Date.now();
      if (t.id === 'openrouter') {
        const j = (await getJson('https://openrouter.ai/api/v1/key', t.apiKey))?.data as Record<string, unknown> | undefined;
        if (!j) return;
        const freeTier = Boolean(j.is_free_tier);
        const cap = freeTier ? 50 : 1000;
        const usedFree = Math.max(t.requestsToday || 0, Object.entries(p.requestsByModel).filter(([m]) => /:free$/.test(m)).reduce((a, [, n]) => a + n, 0));
        const exhausted = blockedReason('openrouter', 'x');
        // OpenRouter doesn't return the free-request count, so this one is RAY's count against its published cap,
        // corrected to 0 the moment OpenRouter says the cap is reached.
        const known = Object.values(p.meters).some((m) => m.source === 'provider' && m.unit === 'requests' && m.window === 'day');
        if (!exhausted && !known) setMeter(t.id, { scope: '', unit: 'requests', window: 'day', limit: cap, remaining: Math.max(0, cap - usedFree), resetsAt: nextUtcMidnight(), source: 'estimate', since: p.countSince });
        if (j.limit_remaining !== null && j.limit_remaining !== undefined) {
          setMeter(t.id, { scope: 'credits', unit: 'credit', window: 'balance', limit: Number(j.limit) || undefined, remaining: Number(j.limit_remaining), currency: 'USD', source: 'provider' });
        }
        p.probeNote = freeTier ? 'No credits bought: 50 free-model requests/day (10 credits → 1,000/day).' : '1,000 free-model requests/day (credits bought).';
      } else if (t.id === 'siliconflow') {
        const j = (await getJson(`${t.baseUrl}/user/info`, t.apiKey))?.data as Record<string, unknown> | undefined;
        if (!j) return;
        const bal = Number(j.totalBalance ?? j.balance);
        if (Number.isFinite(bal)) setMeter(t.id, { scope: '', unit: 'credit', window: 'balance', remaining: bal, currency: /\.cn/.test(t.baseUrl) ? 'CNY' : 'USD', source: 'provider' });
        p.probeNote = 'Free 7–9B models do not use the balance.';
      } else if (t.id === 'deepseek') {
        const j = await getJson(`${t.baseUrl.replace(/\/v1$/, '')}/user/balance`, t.apiKey);
        const info = (j?.balance_infos as Array<{ currency?: string; total_balance?: string }> | undefined)?.[0];
        if (info) setMeter(t.id, { scope: '', unit: 'credit', window: 'balance', remaining: Number(info.total_balance || 0), currency: info.currency || 'USD', source: 'provider' });
        if (j && j.is_available === false) block(t.id, '*', 'No balance left (DeepSeek top-up needed)');
      }
    })
  );
  save();
}

// --- published free limits (only for "estimate" rows when a provider sends no numbers) ---------------
const GROQ_TPD: Array<[RegExp, number]> = [
  [/gpt-oss-120b/, 200_000],
  [/gpt-oss-20b/, 200_000],
  [/llama-3\.3-70b/, 100_000],
  [/kimi-k2/, 300_000],
  [/qwen3-32b/, 500_000],
  [/llama-3\.1-8b|llama-4/, 500_000],
];

export interface BalanceView {
  id: string;
  status: 'ok' | 'low' | 'partial' | 'empty' | 'unknown';
  headline: string;
  meters: Meter[];
  blocks: Block[];
  usedToday: { requests: number; tokens: number };
  note?: string;
  probedAt?: number;
}

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
const unitLabel = (m: Meter) => (m.unit === 'credit' ? `${m.currency || ''} balance`.trim() : `${m.unit}${m.window === 'day' ? ' today' : m.window === 'month' ? ' this month' : m.window === 'minute' ? ' this minute' : ''}`);

export async function balanceView(id: string): Promise<BalanceView> {
  await ensureLoaded();
  const p = prov(id);
  const usedToday = {
    requests: Object.values(p.requestsByModel).reduce((a, b) => a + b, 0),
    tokens: Object.values(p.tokensByModel).reduce((a, b) => a + b, 0),
  };
  const meters = Object.values(p.meters);
  // Groq daily tokens per model: when Groq hasn't reported a number today, estimate from RAY's own use.
  if (id === 'groq') {
    for (const [model, used] of Object.entries(p.tokensByModel)) {
      if (meters.some((m) => m.scope === model && m.unit === 'tokens' && m.window === 'day')) continue;
      const lim = GROQ_TPD.find(([re]) => re.test(model))?.[1];
      if (lim) meters.push({ key: `${model}|tokens|day|est`, scope: model, unit: 'tokens', window: 'day', limit: lim, remaining: Math.max(0, lim - used), rolling: true, source: 'estimate', since: p.countSince, at: Date.now() });
    }
  }
  const blocks = p.blocks.filter((b) => (!b.until || b.until > Date.now()) && !b.skip);
  const long = meters.filter((m) => m.window !== 'minute');
  const frac = (m: Meter) => (m.limit ? m.remaining / m.limit : m.remaining > 0 ? 1 : 0);
  const firm = long.filter((m) => m.source === 'provider');
  const worst = [...(firm.length ? firm : long)].sort((a, b) => frac(a) - frac(b))[0];
  let status: BalanceView['status'] = 'unknown';
  if (blocks.some((b) => b.scope === '*')) status = 'empty';
  else if (blocks.length) status = 'partial';
  else if (worst) status = frac(worst) <= 0 ? 'empty' : frac(worst) < 0.15 ? 'low' : worst.source === 'estimate' && !firm.length ? 'unknown' : 'ok';
  else if (meters.length) status = 'ok';

  const recentOk = p.lastOkAt && Date.now() - p.lastOkAt < 30 * 60_000;
  if (status === 'unknown' && recentOk) status = 'ok';
  let headline = recentOk
    ? `Answering normally (last reply ${new Date(p.lastOkAt!).toISOString().slice(11, 16)} UTC). This provider publishes no remaining-balance numbers.`
    : 'No numbers from this provider yet — they appear after its next reply (or press Check now).';
  const wholeBlock = blocks.find((b) => b.scope === '*');
  if (wholeBlock) headline = wholeBlock.reason;
  else if (worst) headline = `${worst.source === 'estimate' ? '≈ ' : ''}${worst.unit === 'credit' ? `${worst.currency || ''} ${worst.remaining.toFixed(2)}`.trim() : fmt(worst.remaining)}${worst.limit ? ` of ${fmt(worst.limit)}` : ''} ${unitLabel(worst)} left${worst.scope && worst.scope !== 'credits' ? ` · ${worst.scope}` : ''}`;
  else if (meters.length) headline = 'Within limits right now (provider reports per-minute limits only).';
  if (!wholeBlock && blocks.length) headline = `${blocks.length} model${blocks.length > 1 ? 's' : ''} used up — ${headline}`;
  return { id, status, headline, meters: meters.sort((a, b) => a.scope.localeCompare(b.scope) || a.window.localeCompare(b.window)), blocks, usedToday, note: p.probeNote, probedAt: p.probedAt };
}

export const __balanceInternals = { parseReset, reset: () => (state = { day: today(), providers: {} }) };
