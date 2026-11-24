import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Zap } from 'lucide-react';
import { authFetch } from '../utils/roomAuth';

interface Meter {
  key: string;
  scope: string;
  unit: 'requests' | 'tokens' | 'credit';
  window: 'minute' | 'day' | 'month' | 'balance' | 'window';
  limit?: number;
  remaining: number;
  resetsAt?: number;
  currency?: string;
  source: 'provider' | 'estimate';
  at: number;
}
interface Block {
  scope: string;
  reason: string;
  until?: number;
}
interface ProviderBalance {
  id: string;
  label: string;
  status: 'ok' | 'low' | 'partial' | 'empty' | 'unknown';
  headline: string;
  meters: Meter[];
  blocks: Block[];
  usedToday: { requests: number; tokens: number };
  note?: string;
}
export interface EngineMeta {
  id: string;
  label: string;
  supportsTools: boolean;
  lastError?: { at: number; status: number; message: string } | null;
}

const STATUS: Record<ProviderBalance['status'], { text: string; pill: string; dot: string }> = {
  ok: { text: 'Plenty left', pill: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300', dot: 'bg-emerald-500' },
  low: { text: 'Running low', pill: 'bg-amber-500/15 text-amber-700 dark:text-amber-300', dot: 'bg-amber-500' },
  partial: { text: 'Some models used up', pill: 'bg-amber-500/15 text-amber-700 dark:text-amber-300', dot: 'bg-amber-500' },
  empty: { text: 'Used up', pill: 'bg-red-500/12 text-red-700 dark:text-red-300', dot: 'bg-red-500' },
  unknown: { text: 'No numbers yet', pill: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400', dot: 'bg-slate-400' },
};

const n = (x: number) => Math.round(x).toLocaleString();
function inTime(at?: number) {
  if (!at) return '';
  const s = Math.max(0, Math.round((at - Date.now()) / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
const what = (m: Meter) =>
  m.unit === 'credit'
    ? 'Account balance'
    : `${m.unit === 'tokens' ? 'Tokens' : 'Requests'} ${m.window === 'day' ? 'today' : m.window === 'month' ? 'this month' : m.window === 'minute' ? 'this minute' : 'in this window'}`;

function MeterRow({ m, provider }: { m: Meter; provider: string }) {
  const pct = m.limit ? Math.max(0, Math.min(100, (m.remaining / m.limit) * 100)) : m.remaining > 0 ? 100 : 0;
  const bar = pct <= 0 ? 'bg-red-500' : pct < 15 ? 'bg-red-500' : pct < 40 ? 'bg-amber-500' : 'bg-emerald-500';
  const amount =
    m.unit === 'credit'
      ? `${m.currency ? `${m.currency} ` : ''}${m.remaining.toFixed(2)} left`
      : `${n(m.remaining)}${m.limit ? ` / ${n(m.limit)}` : ''} left`;
  return (
    <div className="mt-2">
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="text-slate-600 dark:text-slate-300 truncate">
          {m.scope && m.scope !== 'credits' ? <span className="font-mono">{m.scope}</span> : null}
          {m.scope && m.scope !== 'credits' ? ' · ' : ''}
          {what(m)}
        </span>
        <span className="font-mono text-slate-800 dark:text-slate-100 shrink-0">{amount}</span>
      </div>
      {(m.limit || m.unit !== 'credit') && (
        <div className="mt-1 h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden" role="meter" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={`${what(m)} left`}>
          <div className={`h-full rounded-full ${bar}`} style={{ width: `${Math.max(pct > 0 ? 2 : 0, pct)}%` }} />
        </div>
      )}
      <p className="mt-0.5 text-[10px] text-slate-500">
        {m.source === 'provider' ? `from ${provider}` : `RAY estimate — ${provider} doesn't report this`}
        {m.resetsAt ? ` · resets in ${inTime(m.resetsAt)}` : ''}
      </p>
    </div>
  );
}

/** Real per-engine balances: what each provider reports, not RAY's own guess. */
export function EngineBalance({ roomId, engines }: { roomId: string; engines: EngineMeta[] }) {
  const [list, setList] = useState<ProviderBalance[]>([]);
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState(0);
  const [error, setError] = useState('');

  const load = useCallback(
    async (refresh = false) => {
      if (refresh) setChecking(true);
      try {
        const r = await authFetch(`/api/engines/balance?room=${encodeURIComponent(roomId)}${refresh ? '&refresh=1' : ''}`, roomId);
        const j = (await r.json()) as { providers?: ProviderBalance[]; checkedAt?: number; error?: string };
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        setList(j.providers || []);
        setCheckedAt(j.checkedAt || Date.now());
        setError('');
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not load balances');
      } finally {
        setChecking(false);
      }
    },
    [roomId]
  );
  useEffect(() => {
    void load(true);
    const id = window.setInterval(() => void load(false), 60_000);
    return () => window.clearInterval(id);
  }, [load]);

  const meta = (id: string) => engines.find((e) => e.id === id);
  const order: Record<ProviderBalance['status'], number> = { ok: 0, low: 1, partial: 2, unknown: 3, empty: 4 };
  const sorted = [...list].sort((a, b) => order[a.status] - order[b.status]);
  const usable = list.filter((p) => p.status === 'ok' || p.status === 'low' || p.status === 'partial').length;

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Balance left on each engine</h4>
          <p className="text-[11px] text-slate-500">
            Numbers reported by the providers themselves (rate-limit headers, limit errors, balance APIs).
            {list.length > 0 &&
              ` ${usable} with balance left · ${list.filter((p) => p.status === 'unknown').length} not reported yet · ${list.filter((p) => p.status === 'empty').length} used up.`}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load(true)}
          disabled={checking}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-slate-300 dark:border-slate-700 hover:border-blue-400 disabled:opacity-60"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${checking ? 'animate-spin' : ''}`} /> {checking ? 'Checking…' : 'Check now'}
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 mt-3">
        {sorted.map((p) => {
          const s = STATUS[p.status];
          const m = meta(p.id);
          const long = p.meters.filter((x) => x.window !== 'minute');
          const minute = p.meters.filter((x) => x.window === 'minute');
          return (
            <div key={p.id} className={`rounded-xl border p-3 ${p.status === 'empty' ? 'border-red-300/60 dark:border-red-900/60' : 'border-slate-200 dark:border-slate-800'}`}>
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full shrink-0 ${s.dot}`} aria-hidden />
                <span className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">{p.label}</span>
                {m?.supportsTools && <Zap className="w-3.5 h-3.5 text-amber-500 shrink-0" aria-label="Can control devices" />}
                <span className={`ml-auto text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0 ${s.pill}`}>{s.text}</span>
              </div>
              <p className="mt-1.5 text-[11px] text-slate-700 dark:text-slate-200">{p.headline}</p>
              {long.slice(0, 4).map((x) => (
                <MeterRow key={x.key} m={x} provider={p.label.replace(/\s*\(.*\)$/, '')} />
              ))}
              {minute.length > 0 && (
                <p className="mt-2 text-[10px] text-slate-500">
                  Right now:{' '}
                  {minute
                    .slice(0, 2)
                    .map((x) => `${n(x.remaining)}${x.limit ? `/${n(x.limit)}` : ''} ${x.unit} per minute${x.scope ? ` (${x.scope})` : ''}`)
                    .join(' · ')}
                </p>
              )}
              {p.blocks.filter((b) => b.scope !== '*').map((b) => (
                <p key={b.scope} className="mt-1.5 text-[10px] text-red-600 dark:text-red-400 break-words">
                  <span className="font-mono">{b.scope}</span>: {b.reason}
                  {b.until ? ` — back in ${inTime(b.until)}` : ''}
                </p>
              ))}
              {p.blocks.some((b) => b.scope === '*' && b.until) && (
                <p className="mt-1 text-[10px] text-slate-500">Back in {inTime(p.blocks.find((b) => b.scope === '*')!.until)} — RAY skips it until then.</p>
              )}
              <p className="mt-2 text-[10px] text-slate-500">
                RAY used {n(p.usedToday.requests)} requests · {n(p.usedToday.tokens)} tokens here today
                {p.note ? ` · ${p.note}` : ''}
              </p>
              {p.status === 'unknown' && m?.lastError && (
                <p className="mt-1 text-[10px] text-amber-600 dark:text-amber-400 break-words">Last error: {m.lastError.message.slice(0, 110)}</p>
              )}
            </div>
          );
        })}
        {!list.length && !error && <p className="text-xs text-slate-500 col-span-full">Loading balances…</p>}
      </div>
      {checkedAt > 0 && <p className="mt-2 text-[10px] text-slate-400">Updated {new Date(checkedAt).toLocaleTimeString()}. Daily limits reset at midnight UTC unless the provider says otherwise.</p>}
    </div>
  );
}
