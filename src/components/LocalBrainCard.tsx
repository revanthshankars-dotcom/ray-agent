import { useCallback, useEffect, useState } from 'react';
import { authFetch } from '../utils/roomAuth';

interface LocalModel {
  kind: string;
  name: string;
  label: string;
  mb: number;
  ready: boolean;
  running: boolean;
}
interface LocalStatus {
  status?: 'installing' | 'installed' | 'not-installed';
  step?: string;
  progress?: number;
  error?: string;
  models?: LocalModel[];
  device?: string;
}

const btn = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border border-slate-300 dark:border-slate-700 hover:border-blue-400 disabled:opacity-50';

/** RAY's own offline brain on the PC — llama.cpp + Qwen3 1.7B (text) + SmolVLM2 500M (photos). No Ollama. */
export function LocalBrainCard({ roomId }: { roomId: string }) {
  const [st, setSt] = useState<LocalStatus>({});
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const call = useCallback(
    async (op: 'install' | 'status' | 'test' | 'stop' | 'remove', extra: Record<string, unknown> = {}) => {
      try {
        const r = await authFetch(`/api/local-ai/${op}`, roomId, { method: 'POST', body: JSON.stringify({ roomId, ...extra }) });
        const j = (await r.json()) as LocalStatus & { answer?: string; model?: string; error?: string };
        if (!r.ok) {
          setMsg(j.error || 'Could not reach your PC bridge.');
          return;
        }
        if (op === 'test') setMsg(`${j.model}: “${j.answer}”`);
        else setSt(j);
      } catch {
        setMsg('Could not reach RAY.');
      }
    },
    [roomId]
  );
  useEffect(() => {
    void call('status');
  }, [call]);
  useEffect(() => {
    if (st.status !== 'installing') return;
    const id = window.setInterval(() => void call('status'), 3000);
    return () => window.clearInterval(id);
  }, [st.status, call]);

  const run = async (op: 'install' | 'test' | 'stop' | 'remove') => {
    setBusy(true);
    setMsg(op === 'test' ? 'Asking the local brain (first answer starts the model, ~10–30 s)…' : '');
    await call(op, op === 'test' ? { text: 'In one short sentence, say hello to Ray and say you run offline.' } : {});
    if (op !== 'test') await call('status');
    setBusy(false);
  };
  const installed = st.status === 'installed';
  const pct = Math.round((st.progress || 0) * 100);

  return (
    <div className="rounded-2xl border border-slate-200 dark:border-slate-800 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Local brain — works with no internet</h4>
        <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${installed ? 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300' : st.status === 'installing' ? 'bg-blue-500/12 text-blue-700 dark:text-blue-300' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400'}`}>
          {installed ? `Ready on ${st.device || 'your PC'}` : st.status === 'installing' ? 'Installing' : st.status ? 'Not installed' : 'PC offline'}
        </span>
      </div>
      <p className="mt-1 text-[12px] text-slate-600 dark:text-slate-300">
        Free models that run on your PC — no Ollama needed. RAY uses them when the cloud engines are unavailable or you pick <b>Local</b>. Photos and screenshots go to SmolVLM2, everything else to Qwen3.
      </p>
      <ul className="mt-2 space-y-1">
        {(st.models || [
          { kind: 'text', name: '', label: 'Qwen3 1.7B — answers & commands', mb: 1107, ready: false, running: false },
          { kind: 'vision', name: '', label: 'SmolVLM2 500M — photos & screenshots', mb: 546, ready: false, running: false },
        ]).map((m) => (
          <li key={m.kind} className="flex items-center justify-between gap-2 text-[12px]">
            <span className="text-slate-700 dark:text-slate-200">{m.label}</span>
            <span className="text-[11px] text-slate-500">
              {m.ready ? (m.running ? 'running' : 'on this PC') : `${m.mb} MB`}
            </span>
          </li>
        ))}
      </ul>
      {st.status === 'installing' && (
        <div className="mt-2">
          <div className="text-[11px] text-slate-600 dark:text-slate-300">
            {st.step} {pct ? `· ${pct}%` : ''}
          </div>
          <div className="mt-1 h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full bg-blue-500 rounded-full" style={{ width: `${Math.max(3, pct)}%` }} />
          </div>
        </div>
      )}
      {st.error && <p className="mt-2 text-[11px] text-red-600">{st.error}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className={btn} disabled={busy || st.status === 'installing' || !st.status} onClick={() => void run('install')}>
          {installed ? 'Repair / update' : 'Install (~1.7 GB, free)'}
        </button>
        <button type="button" className={btn} disabled={busy || !installed} onClick={() => void run('test')}>
          Test
        </button>
        <button type="button" className={btn} disabled={busy || !installed} onClick={() => void run('stop')}>
          Free memory
        </button>
        <button type="button" className={btn} disabled={busy || !installed} onClick={() => confirm('Remove the local brain from your PC? (You can install it again any time.)') && void run('remove')}>
          Remove
        </button>
      </div>
      {msg && <p className="mt-2 text-[12px] text-slate-700 dark:text-slate-200">{msg}</p>}
    </div>
  );
}
