import { useCallback, useEffect, useState } from 'react';
import { BrainCircuit, Loader2, Moon, Play, ShieldCheck } from 'lucide-react';
import { authFetch } from '../utils/roomAuth';

interface Settings {
  level: 'off' | 'observe' | 'assist';
  intervalMin: number;
  quietStart: number;
  quietEnd: number;
  lastRunAt?: number;
  lastSummary?: string;
}

const LEVELS: Array<{ id: Settings['level']; label: string; hint: string }> = [
  { id: 'off', label: 'Off', hint: 'RAY only acts when you ask.' },
  { id: 'observe', label: 'Observe', hint: 'Thinks on its own and suggests — you decide.' },
  { id: 'assist', label: 'Assist', hint: 'Also does safe things itself: alerts, reminders, tasks, notes, waking devices.' },
];

/** Autopilot = RAY's self-thinking loop. Never messages, calls, deletes or clicks on its own. */
export function AutopilotCard({ roomId }: { roomId: string }) {
  const [s, setS] = useState<Settings | null>(null);
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await authFetch(`/api/autopilot?room=${encodeURIComponent(roomId)}`, roomId);
      setS((await r.json()) as Settings);
    } catch {
      // offline
    }
  }, [roomId]);
  useEffect(() => {
    void load();
  }, [load]);

  const save = async (patch: Partial<Settings>) => {
    setS((prev) => (prev ? { ...prev, ...patch } : prev));
    const r = await authFetch('/api/autopilot', roomId, { method: 'POST', body: JSON.stringify({ roomId, ...patch }) });
    setS((await r.json()) as Settings);
  };

  const runNow = async () => {
    setRunning(true);
    try {
      const r = await authFetch('/api/autopilot/run', roomId, { method: 'POST', body: JSON.stringify({ roomId }) });
      const j = (await r.json()) as { summary?: string };
      setS((prev) => (prev ? { ...prev, lastSummary: j.summary, lastRunAt: Date.now() } : prev));
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 sm:p-5">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex items-center gap-2">
          <BrainCircuit className="w-4 h-4 text-violet-500" />
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Autopilot</h2>
          <span className="text-xs text-slate-500">RAY thinks and helps on its own</span>
        </div>
        <div className="sm:ml-auto flex items-center gap-1 p-0.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-xs">
          {LEVELS.map((l) => (
            <button
              key={l.id}
              type="button"
              onClick={() => void save({ level: l.id })}
              className={`px-3 py-1.5 rounded-md font-medium ${s?.level === l.id ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm' : 'text-slate-600 dark:text-slate-400'}`}
            >
              {l.label}
            </button>
          ))}
        </div>
      </div>
      <p className="text-xs text-slate-600 dark:text-slate-400 mt-2">{LEVELS.find((l) => l.id === s?.level)?.hint}</p>

      <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
        <label className="flex items-center justify-between gap-2 rounded-xl border border-slate-200 dark:border-slate-800 px-3 py-2">
          <span className="text-slate-600 dark:text-slate-300">Check in every</span>
          <select
            value={s?.intervalMin ?? 30}
            onChange={(e) => void save({ intervalMin: Number(e.target.value) })}
            className="bg-transparent font-semibold text-slate-900 dark:text-slate-100"
          >
            {[15, 30, 60, 120].map((m) => (
              <option key={m} value={m}>
                {m} min
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center justify-between gap-2 rounded-xl border border-slate-200 dark:border-slate-800 px-3 py-2">
          <span className="inline-flex items-center gap-1 text-slate-600 dark:text-slate-300">
            <Moon className="w-3.5 h-3.5" /> Quiet hours
          </span>
          <span className="flex items-center gap-1 font-semibold text-slate-900 dark:text-slate-100">
            <select value={s?.quietStart ?? 23} onChange={(e) => void save({ quietStart: Number(e.target.value) })} className="bg-transparent">
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>{`${h}:00`}</option>
              ))}
            </select>
            –
            <select value={s?.quietEnd ?? 7} onChange={(e) => void save({ quietEnd: Number(e.target.value) })} className="bg-transparent">
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>{`${h}:00`}</option>
              ))}
            </select>
          </span>
        </label>
        <button
          type="button"
          onClick={() => void runNow()}
          disabled={running}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-violet-600 hover:bg-violet-700 disabled:opacity-60 text-white font-semibold px-3 py-2"
        >
          {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />} Think now
        </button>
      </div>

      {s?.lastSummary && (
        <div className="mt-3 rounded-xl bg-slate-50 dark:bg-slate-800/60 px-3 py-2.5">
          <p className="text-[11px] uppercase tracking-wide text-slate-500">
            Last check-in{s.lastRunAt ? ` · ${new Date(s.lastRunAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
          </p>
          <p className="text-xs text-slate-800 dark:text-slate-200 whitespace-pre-line mt-1">{s.lastSummary}</p>
        </div>
      )}
      <p className="mt-3 text-[11px] text-slate-500 flex items-start gap-1.5">
        <ShieldCheck className="w-3.5 h-3.5 shrink-0 mt-px" />
        Never on its own: messaging people, phone calls, deleting or writing files, using the mouse, running coding agents. Everything it does is logged in
        Second Brain → System → Autopilot Journal. RAY also learns from your chats (Memory → About Ray) and self-checks devices &amp; engines (System → System Health).
      </p>
    </section>
  );
}
