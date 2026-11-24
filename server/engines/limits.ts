/**
 * USAGE LIMITS Ray controls from the app (Connections → Usage limits), applied by the router:
 *   - turn an engine off
 *   - his own daily cap per engine (requests and/or tokens)
 *   - one daily token cap across all engines (RAY_DAILY_TOKEN_CAP on the server is the fallback)
 *   - keep a reserve: stop using an engine when its provider says less than X% is left
 *   - never spend paid credit (paid OpenRouter / SiliconFlow "Pro" models, prepaid-only engines)
 * Settings are server-wide (they cover every room) and survive restarts.
 */
import { loadJson, scheduleSave } from '../persistence.ts';

export interface EngineCap {
  enabled?: boolean;
  maxRequests?: number; // per UTC day, 0/undefined = no cap of Ray's own
  maxTokens?: number;
}
export interface EngineLimits {
  dailyTokenCap: number; // all engines together, 0 = none
  reservePct: number; // 0..50
  noPaid: boolean;
  engines: Record<string, EngineCap>;
  updatedAt?: number;
}

const DEFAULTS: EngineLimits = { dailyTokenCap: 0, reservePct: 0, noPaid: true, engines: {} };
let limits: EngineLimits = { ...DEFAULTS };
let loaded = false;

export async function loadLimits(): Promise<EngineLimits> {
  if (!loaded) {
    loaded = true;
    const s = (await loadJson<Record<string, unknown>>('engine-limits').catch(() => null)) as Partial<EngineLimits> | null;
    if (s) limits = { ...DEFAULTS, ...s, engines: { ...(s.engines || {}) } };
  }
  return limits;
}
void loadLimits();

export function getLimits(): EngineLimits {
  return limits;
}

const num = (v: unknown, max: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : 0;
};

export async function updateLimits(input: Partial<EngineLimits>): Promise<EngineLimits> {
  await loadLimits();
  if (input.dailyTokenCap !== undefined) limits.dailyTokenCap = num(input.dailyTokenCap, 1e10);
  if (input.reservePct !== undefined) limits.reservePct = Math.min(50, num(input.reservePct, 50));
  if (typeof input.noPaid === 'boolean') limits.noPaid = input.noPaid;
  if (input.engines && typeof input.engines === 'object') {
    for (const [id, c] of Object.entries(input.engines)) {
      if (!/^[a-z0-9_-]{2,30}$/.test(id) || !c || typeof c !== 'object') continue;
      const cur = limits.engines[id] || {};
      const next: EngineCap = { ...cur };
      if (typeof c.enabled === 'boolean') next.enabled = c.enabled;
      if (c.maxRequests !== undefined) next.maxRequests = num(c.maxRequests, 1e7);
      if (c.maxTokens !== undefined) next.maxTokens = num(c.maxTokens, 1e10);
      limits.engines[id] = next;
    }
  }
  limits.updatedAt = Date.now();
  // Limits matter: save promptly (KV still coalesces writes).
  scheduleSave('engine-limits', () => limits as unknown as Record<string, unknown>, 500);
  return limits;
}

/** Engines that only run on prepaid credit (no free tier) — skipped while "never spend paid credit" is on. */
export const PREPAID_ONLY = new Set(['deepseek', 'dashscope', 'novita']);

/** A model that costs money on an account that also has free models. */
export function isPaidModel(id: string, model: string): boolean {
  if (id === 'openrouter') return !/:free$/.test(model) && model !== 'openrouter/free';
  if (id === 'siliconflow') return /^Pro\//.test(model);
  return false;
}

/** Why Ray's own limits stop this engine right now (null = allowed). */
export function engineLimitReason(id: string, used: { requests: number; tokens: number }): string | null {
  const c = limits.engines[id];
  if (c?.enabled === false) return 'Turned off by Ray';
  if (limits.noPaid && PREPAID_ONLY.has(id)) return 'Uses prepaid credit — off while "Never spend paid credit" is on';
  if (c?.maxRequests && used.requests >= c.maxRequests) return `Ray's daily limit reached (${c.maxRequests.toLocaleString()} requests)`;
  if (c?.maxTokens && used.tokens >= c.maxTokens) return `Ray's daily limit reached (${c.maxTokens.toLocaleString()} tokens)`;
  return null;
}

export function modelLimitReason(id: string, model: string, providerFractionLeft: number | null): string | null {
  if (limits.noPaid && isPaidModel(id, model)) return 'Paid model — skipped while "Never spend paid credit" is on';
  if (limits.reservePct > 0 && providerFractionLeft !== null && providerFractionLeft * 100 < limits.reservePct) {
    return `Keeping a ${limits.reservePct}% reserve (provider reports ${Math.max(0, Math.round(providerFractionLeft * 100))}% left)`;
  }
  return null;
}
