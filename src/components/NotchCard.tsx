import { useCallback, useEffect, useState } from 'react';
import { authFetch } from '../utils/roomAuth';

type Style = 'eyes' | 'ring' | 'bars';
interface NotchPrefs {
  style?: Style;
  color?: string;
  wakeEnabled?: boolean;
  wakePhrases?: string[];
  stt?: string;
  voice?: string;
  speakAnswers?: boolean;
}
interface Status {
  status?: 'installing' | 'installed' | 'running' | 'stopped' | 'not-installed';
  step?: string;
  error?: string;
  device?: string;
}

const COLORS: Record<string, string> = { cyan: '#22d3ee', white: '#f8fafc', blue: '#3b82f6', green: '#22c55e', yellow: '#facc15', orange: '#fb923c', pink: '#f472b6', purple: '#a855f7' };
const field = 'rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-[12px]';
const btn = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-slate-300 dark:border-slate-700 hover:border-blue-400 disabled:opacity-50';

/** Mini preview of the notch in the chosen look. */
function Preview({ style, color }: { style: Style; color: string }) {
  const c = COLORS[color] || COLORS.cyan;
  return (
    <div className="mx-auto w-[150px] h-[28px] bg-black rounded-b-2xl flex items-center px-3 gap-2 shadow-lg" aria-label="Notch preview">
      {style === 'eyes' && (
        <span className="flex gap-1.5">
          <span className="w-[6px] h-[11px] rounded" style={{ background: c, boxShadow: `0 0 7px ${c}` }} />
          <span className="w-[6px] h-[11px] rounded" style={{ background: c, boxShadow: `0 0 7px ${c}` }} />
        </span>
      )}
      {style === 'ring' && <span className="w-[13px] h-[13px] rounded-full border-2" style={{ borderColor: c, boxShadow: `0 0 8px ${c}` }} />}
      {style === 'bars' && (
        <span className="flex gap-[3px] items-center">
          {[5, 9, 6, 8].map((h, i) => (
            <span key={i} className="w-[3px] rounded-sm" style={{ height: h, background: c }} />
          ))}
        </span>
      )}
      <span className="text-[10px] text-slate-400 ml-auto tabular-nums">9:41</span>
    </div>
  );
}

/** RAY Notch (desktop app) — install on the PC through its bridge, and pick how it looks and listens. */
export function NotchCard({ roomId }: { roomId: string }) {
  const [prefs, setPrefs] = useState<NotchPrefs>({});
  const [status, setStatus] = useState<Status>({});
  const [msg, setMsg] = useState('');
  const [wake, setWake] = useState('');

  const call = useCallback(
    async (op: 'install' | 'start' | 'stop' | 'status') => {
      try {
        const r = await authFetch(`/api/notch/${op}`, roomId, { method: 'POST', body: JSON.stringify({ roomId }) });
        const j = (await r.json()) as Status & { error?: string };
        if (!r.ok) {
          setMsg(j.error || 'Could not reach your PC bridge.');
          setStatus({});
          return;
        }
        setStatus(j);
        setMsg(op === 'install' ? 'Installing on your PC — this takes a few minutes the first time.' : '');
      } catch {
        setMsg('Could not reach RAY.');
      }
    },
    [roomId]
  );

  useEffect(() => {
    void (async () => {
      const r = await authFetch(`/api/ui-prefs?room=${encodeURIComponent(roomId)}`, roomId);
      if (r.ok) {
        const p = ((await r.json()) as { notch?: NotchPrefs }).notch || {};
        setPrefs(p);
        setWake((p.wakePhrases || ['hey ray']).join(', '));
      }
    })();
    void call('status');
  }, [roomId, call]);

  // Poll while installing.
  useEffect(() => {
    if (status.status !== 'installing') return;
    const id = window.setInterval(() => void call('status'), 5000);
    return () => window.clearInterval(id);
  }, [status.status, call]);

  const save = async (patch: NotchPrefs) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    await authFetch('/api/ui-prefs', roomId, { method: 'POST', body: JSON.stringify({ roomId, notch: patch }) });
  };
  const style = (prefs.style || 'eyes') as Style;
  const color = prefs.color || 'cyan';
  const st = status.status;
  const label =
    st === 'running' ? `Running on ${status.device || 'your PC'}` : st === 'installing' ? `Installing — ${status.step || 'working'}` : st === 'installed' || st === 'stopped' ? 'Installed, not running' : st === 'not-installed' ? 'Not installed yet' : 'PC bridge offline';

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex-1 min-w-[220px]">
          <div className="text-xs font-semibold text-slate-800 dark:text-slate-100">RAY Notch — RAY at the top of your PC screen</div>
          <p className="mt-1 text-[11px] text-slate-600 dark:text-slate-300">
            A small black notch above every app. Say your wake phrase or hold <b>Right Ctrl</b> to command, hold <b>Right Alt</b> to dictate into any app, approve actions with Yes / Not now, plus timers, focus, your list, music with lyrics and quick controls. Speech
            runs on your PC (works offline); answers come from RAY.
          </p>
          <p className="mt-1 text-[11px]">
            <span className={`font-medium ${st === 'running' ? 'text-emerald-600' : st === 'installing' ? 'text-blue-600' : 'text-slate-500'}`}>{label}</span>
            {status.error ? <span className="text-red-600"> · {status.error}</span> : null}
          </p>
        </div>
        <div className="pt-1">
          <Preview style={style} color={color} />
        </div>
      </div>

      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" className={btn} disabled={st === 'installing'} onClick={() => void call('install')}>
          {st === 'installed' || st === 'running' || st === 'stopped' ? 'Update' : 'Install on my PC'}
        </button>
        <button type="button" className={btn} disabled={!(st === 'installed' || st === 'stopped')} onClick={() => void call('start')}>
          Start
        </button>
        <button type="button" className={btn} disabled={st !== 'running'} onClick={() => void call('stop')}>
          Stop
        </button>
        {msg && <span className="text-[11px] text-slate-600 dark:text-slate-300 self-center">{msg}</span>}
      </div>

      <div className="mt-3 grid grid-cols-1 sm:grid-cols-[120px_1fr] gap-x-3 gap-y-2 items-center text-[12px]">
        <span className="text-slate-600 dark:text-slate-300">Look</span>
        <div className="flex flex-wrap gap-1.5">
          {(['eyes', 'ring', 'bars'] as Style[]).map((s) => (
            <button key={s} type="button" onClick={() => void save({ style: s })} className={`px-2.5 py-1 rounded-full text-[11px] border ${style === s ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900 border-transparent' : 'border-slate-300 dark:border-slate-700'}`}>
              {s === 'eyes' ? 'Eyes' : s === 'ring' ? 'Arc ring' : 'Sound bars'}
            </button>
          ))}
        </div>
        <span className="text-slate-600 dark:text-slate-300">Colour</span>
        <div className="flex flex-wrap gap-2">
          {Object.entries(COLORS).map(([n, c]) => (
            <button key={n} type="button" aria-label={n} title={n} onClick={() => void save({ color: n })} className={`w-5 h-5 rounded-full border-2 ${color === n ? 'border-slate-900 dark:border-white' : 'border-transparent'}`} style={{ background: c }} />
          ))}
        </div>
        <span className="text-slate-600 dark:text-slate-300">Wake phrase</span>
        <div className="flex flex-wrap items-center gap-2">
          <input className={`${field} flex-1 min-w-[160px]`} value={wake} onChange={(e) => setWake(e.target.value)} onBlur={() => void save({ wakePhrases: wake.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 5) })} aria-label="Wake phrases, comma separated" />
          <label className="flex items-center gap-1 text-[11px]">
            <input type="checkbox" checked={prefs.wakeEnabled !== false} onChange={(e) => void save({ wakeEnabled: e.target.checked })} /> On
          </label>
        </div>
        <span className="text-slate-600 dark:text-slate-300">RAY's voice</span>
        <select className={field} value={prefs.voice || 'voice-alan'} onChange={(e) => void save({ voice: e.target.value })} aria-label="RAY's voice">
          <option value="voice-alan">Alan — British, male</option>
          <option value="voice-jenny">Jenny — British, female</option>
          <option value="voice-amy">Amy — American, female</option>
        </select>
        <span className="text-slate-600 dark:text-slate-300">Speech-to-text</span>
        <select className={field} value={prefs.stt || 'stt-fast'} onChange={(e) => void save({ stt: e.target.value })} aria-label="Speech-to-text model">
          <option value="stt-fast">Fast (English, 108 MB)</option>
          <option value="stt-accurate">Accurate (English, 250 MB)</option>
          <option value="stt-multilingual">99 languages incl. Hindi & Tamil (208 MB)</option>
        </select>
        <span className="text-slate-600 dark:text-slate-300">Speak answers</span>
        <label className="flex items-center gap-1 text-[11px]">
          <input type="checkbox" checked={prefs.speakAnswers !== false} onChange={(e) => void save({ speakAnswers: e.target.checked })} /> RAY reads answers aloud
        </label>
      </div>
      <p className="mt-2 text-[10px] text-slate-500">
        Needs the PC bridge (3.11+) and Node.js. Windows 10/11, macOS (allow Microphone + Accessibility once) and Linux. First start downloads the offline voice models (~200 MB). Changes here reach the notch instantly.
      </p>
    </div>
  );
}
