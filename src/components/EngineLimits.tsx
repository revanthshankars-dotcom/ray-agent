import { useCallback, useEffect, useState } from 'react';
import { Gauge, Save } from 'lucide-react';
import { authFetch } from '../utils/roomAuth';

interface EngineCap {
  enabled?: boolean;
  maxRequests?: number;
  maxTokens?: number;
}
interface Limits {
  dailyTokenCap: number;
  reservePct: number;
  noPaid: boolean;
  engines: Record<string, EngineCap>;
}
interface UsageRow {
  id: string;
  label: string;
  requestsToday: number;
  tokensToday: number;
  limitReason: string | null;
}

const n = (x: number) => Math.round(x).toLocaleString();
const field =
  'w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-xs font-mono text-slate-900 dark:text-slate-100';

function Bar({ used, cap }: { used: number; cap: number }) {
  if (!cap) return null;
  const pct = Math.min(100, (used / cap) * 100);
  return (
    <div className="mt-1 h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden" role="meter" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div className={`h-full rounded-full ${pct >= 100 ? 'bg-red-500' : pct > 80 ? 'bg-amber-500' : 'bg-blue-500'}`} style={{ width: `${Math.max(2, pct)}%` }} />
    </div>
  );
}

function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={`shrink-0 relative w-9 h-5 rounded-full transition-colors ${on ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-700'}`}
    >
      <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-4' : ''}`} />
    </button>
  );
}

/** Ray's own controls over how much RAY uses each engine. */
export function EngineLimits({ roomId }: { roomId: string }) {
  const [limits, setLimits] = useState<Limits | null>(null);
  const [usage, setUsage] = useState<UsageRow[]>([]);
  const [used, setUsed] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await authFetch(`/api/engines/limits?room=${encodeURIComponent(roomId)}`, roomId);
      const j = (await r.json()) as { limits: Limits; usage: UsageRow[]; budget: { usedTokens: number } };
      setUsage(j.usage || []);
      setUsed(j.budget?.usedTokens || 0);
      setLimits((cur) => (dirty && cur ? cur : j.limits));
    } catch {
      // offline
    }
  }, [roomId, dirty]);
  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(id);
  }, [load]);

  if (!limits) return null;
  const set = (patch: Partial<Limits>) => {
    setLimits({ ...limits, ...patch });
    setDirty(true);
    setMsg('');
  };
  const setEngine = (id: string, patch: EngineCap) => set({ engines: { ...limits.engines, [id]: { ...limits.engines[id], ...patch } } });
  const save = async () => {
    const r = await authFetch('/api/engines/limits', roomId, { method: 'POST', body: JSON.stringify({ roomId, ...limits }) });
    if (r.ok) {
      const j = (await r.json()) as { limits: Limits };
      setLimits(j.limits);
      setDirty(false);
      setMsg('Saved — RAY follows these limits from the next message.');
      void load();
    } else setMsg('Could not save the limits.');
  };

  return (
    <div className="mt-4 rounded-xl border border-slate-200 dark:border-slate-800 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Gauge className="w-4 h-4 text-blue-600 dark:text-blue-400" />
        <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Usage limits</h4>
        <span className="text-[11px] text-slate-500">Your own caps — RAY moves to the next engine when one is reached. Reset at midnight UTC.</span>
      </div>

      <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-3">
        <label className="flex items-start gap-2 text-xs text-slate-700 dark:text-slate-200">
          <Switch on={limits.noPaid} onChange={(v) => set({ noPaid: v })} label="Never spend paid credit" />
          <span>
            <b>Never spend paid credit</b>
            <span className="block text-[11px] text-slate-500">Only free models; skips paid OpenRouter/SiliconFlow models and prepaid-only engines (DeepSeek, DashScope, Novita).</span>
          </span>
        </label>
        <label className="text-xs text-slate-700 dark:text-slate-200">
          <b>Total per day (all engines)</b>
          <span className="flex items-center gap-2 mt-1">
            <input
              type="number"
              min={0}
              step={10000}
              inputMode="numeric"
              aria-label="Total tokens per day, all engines"
              className={field}
              value={limits.dailyTokenCap || ''}
              placeholder="No cap"
              onChange={(e) => set({ dailyTokenCap: Number(e.target.value) || 0 })}
            />
            <span className="text-[11px] text-slate-500 shrink-0">tokens</span>
          </span>
          <span className="block text-[11px] text-slate-500 mt-1">
            Used today: {n(used)}
            {limits.dailyTokenCap ? ` of ${n(limits.dailyTokenCap)}` : ''}
          </span>
          <Bar used={used} cap={limits.dailyTokenCap} />
        </label>
        <label className="text-xs text-slate-700 dark:text-slate-200">
          <b>Keep a reserve</b>
          <select
            aria-label="Reserve to keep on each engine"
            className={`${field} mt-1 font-sans`}
            value={limits.reservePct}
            onChange={(e) => set({ reservePct: Number(e.target.value) })}
          >
            <option value={0}>Use everything</option>
            <option value={10}>Keep 10% of each engine</option>
            <option value={20}>Keep 20% of each engine</option>
            <option value={30}>Keep 30% of each engine</option>
          </select>
          <span className="block text-[11px] text-slate-500 mt-1">Stops using an engine when its provider reports less than this left.</span>
        </label>
      </div>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-xs min-w-[520px]">
          <thead>
            <tr className="text-left text-[11px] text-slate-500">
              <th className="py-1.5 font-medium">Engine</th>
              <th className="py-1.5 font-medium">Used today</th>
              <th className="py-1.5 font-medium w-32">Max requests/day</th>
              <th className="py-1.5 font-medium w-36">Max tokens/day</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {usage.map((u) => {
              const c = limits.engines[u.id] || {};
              const on = c.enabled !== false;
              return (
                <tr key={u.id} className={on ? '' : 'opacity-60'}>
                  <td className="py-2 pr-2">
                    <span className="flex items-center gap-2">
                      <Switch on={on} onChange={(v) => setEngine(u.id, { enabled: v })} label={`Use ${u.label}`} />
                      <span className="font-medium text-slate-800 dark:text-slate-100">{u.label}</span>
                    </span>
                    {u.limitReason && <span className="block mt-0.5 text-[10px] text-amber-600 dark:text-amber-400">{u.limitReason}</span>}
                  </td>
                  <td className="py-2 pr-2 font-mono text-slate-600 dark:text-slate-300">
                    {n(u.requestsToday)} req · {n(u.tokensToday)} tok
                    <Bar used={c.maxTokens ? u.tokensToday : u.requestsToday} cap={c.maxTokens || c.maxRequests || 0} />
                  </td>
                  <td className="py-2 pr-2">
                    <input type="number" min={0} inputMode="numeric" aria-label={`Max requests per day for ${u.label}`} className={field} placeholder="No cap" value={c.maxRequests || ''} onChange={(e) => setEngine(u.id, { maxRequests: Number(e.target.value) || 0 })} />
                  </td>
                  <td className="py-2">
                    <input type="number" min={0} step={10000} inputMode="numeric" aria-label={`Max tokens per day for ${u.label}`} className={field} placeholder="No cap" value={c.maxTokens || ''} onChange={(e) => setEngine(u.id, { maxTokens: Number(e.target.value) || 0 })} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={!dirty}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
        >
          <Save className="w-3.5 h-3.5" /> Save limits
        </button>
        {msg && <span className="text-[11px] text-slate-600 dark:text-slate-300">{msg}</span>}
        {dirty && !msg && <span className="text-[11px] text-amber-600">Unsaved changes</span>}
      </div>
    </div>
  );
}
