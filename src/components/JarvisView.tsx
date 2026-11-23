import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  BookOpenCheck,
  Bot,
  CheckCircle2,
  Code2,
  Cpu,
  Globe,
  GraduationCap,
  HardDrive,
  Loader2,
  MonitorUp,
  MousePointer2,
  Phone,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Stethoscope,
  Wrench,
  X,
} from 'lucide-react';
import type { DeviceInfo } from '../types/relay';
import { authFetch } from '../utils/roomAuth';
import { AutopilotCard } from './AutopilotCard';

interface BridgeRow {
  id: string;
  name: string;
  online: boolean;
  os: string;
  version: string;
  latest: string;
  capabilities: string[];
}
interface JarvisStatus {
  learning: {
    enabled: boolean;
    dailyAt: string;
    lastRunAt: number | null;
    lastSummary: string;
    notesLearned: number;
    openQuestions: string[];
    pendingExperiences: number;
    topics: string[];
  };
  knowledge: Array<{ id: string; title: string; updatedAt: number; preview: string }>;
  lessons: string[];
  memory: string[];
  repairs: string[];
  health: string[];
  bridges: BridgeRow[];
}
interface Diagnosis {
  disks?: Array<{ path: string; freeGb: number; totalGb: number; freePct: number }>;
  memory?: { usedPct: number; freeMb: number; totalMb: number };
  internet?: { ok: boolean; latencyMs?: number };
  tempMb?: number;
  issues?: string[];
  notResponding?: string[];
  battery?: { percentage: number; status: string };
}

function ago(ts?: number | null): string {
  if (!ts) return 'never';
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

const card = 'rounded-2xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm shadow-slate-900/[0.03]';
const btn =
  'inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
const btnGhost = `${btn} border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800`;
const btnPrimary = `${btn} bg-blue-600 text-white hover:bg-blue-500`;

function SectionTitle({ icon: Icon, title, hint, tone = 'text-blue-500' }: { icon: typeof Sparkles; title: string; hint?: string; tone?: string }) {
  return (
    <div className="flex items-center gap-2 min-w-0">
      <Icon className={`w-4 h-4 shrink-0 ${tone}`} />
      <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
      {hint && <span className="text-xs text-slate-500 dark:text-slate-400 truncate">{hint}</span>}
    </div>
  );
}

export function JarvisView({
  roomId,
  devices,
  onAskRay,
}: {
  roomId: string;
  devices: DeviceInfo[];
  onAskRay: (prompt: string) => void;
}) {
  const [st, setSt] = useState<JarvisStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [newTopic, setNewTopic] = useState('');
  const [learning, setLearning] = useState(false);
  const [diag, setDiag] = useState<Record<string, { loading: boolean; data?: Diagnosis; error?: string }>>({});
  const [popupMsg, setPopupMsg] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await authFetch(`/api/jarvis?room=${encodeURIComponent(roomId)}`, roomId);
      if (r.ok) setSt((await r.json()) as JarvisStatus);
    } catch {
      /* offline */
    } finally {
      setLoading(false);
    }
  }, [roomId]);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 30000);
    return () => window.clearInterval(t);
  }, [load]);

  const saveTopics = async (topics: string[]) => {
    setSt((p) => (p ? { ...p, learning: { ...p.learning, topics } } : p));
    await authFetch('/api/jarvis/learning', roomId, { method: 'POST', body: JSON.stringify({ roomId, topics }) });
  };

  const learnNow = async () => {
    setLearning(true);
    try {
      await authFetch('/api/jarvis/learning', roomId, { method: 'POST', body: JSON.stringify({ roomId, action: 'run' }) });
      window.setTimeout(() => void load(), 20000);
    } finally {
      window.setTimeout(() => setLearning(false), 4000);
    }
  };

  const diagnose = async (id: string) => {
    setDiag((d) => ({ ...d, [id]: { loading: true } }));
    try {
      const r = await authFetch('/api/jarvis/diagnose', roomId, { method: 'POST', body: JSON.stringify({ roomId, deviceId: id }) });
      const j = (await r.json()) as { ok: boolean; data?: Diagnosis; error?: string };
      setDiag((d) => ({ ...d, [id]: { loading: false, data: j.data, error: j.ok ? undefined : j.error } }));
    } catch (err) {
      setDiag((d) => ({ ...d, [id]: { loading: false, error: err instanceof Error ? err.message : 'failed' } }));
    }
  };

  const popup = async (device: string) => {
    setPopupMsg('');
    const r = await authFetch('/api/jarvis/popup', roomId, { method: 'POST', body: JSON.stringify({ roomId, device }) });
    const j = (await r.json()) as { summary?: string };
    setPopupMsg(j.summary || 'Sent');
  };

  const online = devices.filter((d) => d.online);
  const bridges = st?.bridges || [];
  const pcBridge = bridges.find((b) => b.online && !/android/i.test(b.os));
  const phoneBridge = bridges.find((b) => b.online && /android/i.test(b.os));
  const caps = useMemo(() => new Set(bridges.filter((b) => b.online).flatMap((b) => b.capabilities)), [bridges]);

  const abilities: Array<{ icon: typeof Globe; label: string; on: boolean; detail: string; prompt: string }> = [
    { icon: Globe, label: 'Browser hands', on: caps.has('browser-agent'), detail: 'Reads, clicks and types in a real Chrome', prompt: 'Research the best budget phones this month and compare the top 3' },
    { icon: MousePointer2, label: 'Mouse & keyboard', on: caps.has('computer-use'), detail: 'Uses any app on the PC (and phone via ADB)', prompt: 'Show me how to turn on night light in Windows' },
    { icon: Code2, label: 'Coding agents', on: caps.has('coding-agents'), detail: 'Claude Code, Codex, Gemini CLI, Aider in parallel', prompt: 'Which coding agents are installed on my PC?' },
    { icon: Wrench, label: 'Self-repair', on: caps.has('repair'), detail: 'Diagnoses and fixes devices, apps and files', prompt: 'Check my PC and fix anything that is wrong' },
    { icon: Phone, label: 'Calls', on: caps.has('calls'), detail: 'Rings devices, PC↔phone calls, schedules', prompt: 'Call my phone in 10 minutes' },
    { icon: MonitorUp, label: 'Pop-up anywhere', on: caps.has('popup'), detail: 'Ctrl+Alt+R on PC · notification on phone', prompt: 'Open RAY on my phone' },
  ];

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 space-y-5">
      {/* Hero */}
      <section className={`${card} relative overflow-hidden p-5 sm:p-6`}>
        <div className="pointer-events-none absolute -right-24 -top-24 w-72 h-72 rounded-full bg-gradient-to-br from-blue-500/20 via-violet-500/10 to-transparent blur-2xl" />
        <div className="relative flex flex-col lg:flex-row lg:items-center gap-5">
          <div className="flex items-center gap-4 min-w-0">
            <div className="relative w-16 h-16 shrink-0">
              <span className="absolute inset-0 rounded-full bg-blue-500/20 animate-ping [animation-duration:3s]" />
              <span className="absolute inset-1 rounded-full bg-gradient-to-br from-blue-500 to-violet-600 shadow-lg shadow-blue-600/30" />
              <Bot className="absolute inset-0 m-auto w-7 h-7 text-white" />
            </div>
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-blue-600 dark:text-blue-400">JARVIS core</p>
              <h1 className="text-xl sm:text-2xl font-semibold text-slate-900 dark:text-white">RAY is learning, watching and ready</h1>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
                {online.length} device{online.length === 1 ? '' : 's'} online · {st?.learning.notesLearned ?? 0} things learned · {st?.lessons.length ?? 0} lessons ·{' '}
                {(st?.health || []).filter((h) => h.includes('⚠️')).length ? 'attention needed' : 'all systems healthy'}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 lg:ml-auto">
            <button type="button" className={btnPrimary} onClick={() => onAskRay('Check all my devices and fix anything that is wrong')}>
              <Stethoscope className="w-3.5 h-3.5" /> Check & fix everything
            </button>
            <button type="button" className={btnGhost} onClick={() => void learnNow()} disabled={learning}>
              {learning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <GraduationCap className="w-3.5 h-3.5" />} Learn now
            </button>
            <button type="button" className={btnGhost} onClick={() => void popup(phoneBridge ? 'phone' : 'pc')}>
              <MonitorUp className="w-3.5 h-3.5" /> Pop up on {phoneBridge ? 'phone' : 'PC'}
            </button>
            <button type="button" aria-label="Refresh" className={btnGhost} onClick={() => void load()}>
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>
        {popupMsg && <p className="relative mt-3 text-xs text-slate-500">{popupMsg}</p>}
      </section>

      {/* Abilities */}
      <section className="grid grid-cols-2 lg:grid-cols-3 gap-2.5 sm:gap-3">
        {abilities.map((a) => (
          <button
            key={a.label}
            type="button"
            onClick={() => onAskRay(a.prompt)}
            className={`${card} group text-left p-3 sm:p-4 hover:border-blue-400/60 dark:hover:border-blue-500/50 transition-colors`}
          >
            <div className="flex items-center gap-2.5">
              <span className={`w-8 h-8 rounded-lg grid place-items-center ${a.on ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400' : 'bg-slate-100 dark:bg-slate-800 text-slate-400'}`}>
                <a.icon className="w-4 h-4" />
              </span>
              <span className="text-[13px] sm:text-sm font-semibold text-slate-900 dark:text-slate-100 leading-tight">{a.label}</span>
              <span
                title={a.on ? 'Ready' : 'Needs the PC bridge online'}
                className={`ml-auto shrink-0 text-[10px] font-semibold uppercase tracking-wide sm:px-2 sm:py-0.5 rounded-full ${a.on ? 'sm:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'sm:bg-slate-100 sm:dark:bg-slate-800 text-slate-500'}`}
              >
                <span className={`sm:hidden inline-block w-2 h-2 rounded-full ${a.on ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'}`} />
                <span className="hidden sm:inline">{a.on ? 'Ready' : 'Offline'}</span>
              </span>
            </div>
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400 line-clamp-2">{a.detail}</p>
            <p className="hidden sm:block mt-2 text-xs text-blue-600 dark:text-blue-400 opacity-0 group-hover:opacity-100 transition-opacity truncate">Try: “{a.prompt}”</p>
          </button>
        ))}
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">
        {/* Self-learning */}
        <section className={`${card} p-4 sm:p-5 lg:col-span-3 space-y-4`}>
          <div className="flex items-center gap-2">
            <SectionTitle icon={GraduationCap} title="Self-learning" hint={`daily at ${st?.learning.dailyAt || '05:30'} · last ${ago(st?.learning.lastRunAt)}`} tone="text-violet-500" />
          </div>
          {st?.learning.lastSummary && (
            <p className="text-xs rounded-lg bg-violet-500/5 border border-violet-500/15 text-slate-600 dark:text-slate-300 px-3 py-2">{st.learning.lastSummary}</p>
          )}
          <div>
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-2">Topics RAY researches every morning</p>
            <div className="flex flex-wrap gap-1.5">
              {(st?.learning.topics || []).map((t) => (
                <span key={t} className="inline-flex items-center gap-1 rounded-full border border-slate-200 dark:border-slate-700 pl-2.5 pr-1 py-0.5 text-xs text-slate-700 dark:text-slate-200">
                  {t}
                  <button
                    type="button"
                    aria-label={`Remove ${t}`}
                    onClick={() => void saveTopics((st?.learning.topics || []).filter((x) => x !== t))}
                    className="p-0.5 rounded-full text-slate-400 hover:text-rose-500 hover:bg-rose-500/10"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
              <form
                className="inline-flex items-center gap-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!newTopic.trim()) return;
                  void saveTopics([...(st?.learning.topics || []), newTopic.trim()]);
                  setNewTopic('');
                }}
              >
                <input
                  value={newTopic}
                  onChange={(e) => setNewTopic(e.target.value)}
                  placeholder="Add a topic…"
                  className="w-40 rounded-full border border-dashed border-slate-300 dark:border-slate-700 bg-transparent px-2.5 py-0.5 text-xs outline-none focus:border-blue-500"
                />
                <button type="submit" aria-label="Add topic" className="p-1 rounded-full text-blue-600 hover:bg-blue-500/10">
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </form>
            </div>
          </div>
          <div>
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-2">Latest knowledge</p>
            {st?.knowledge.length ? (
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {st.knowledge.slice(0, 6).map((k) => (
                  <li key={k.id} className="py-2">
                    <button type="button" onClick={() => onAskRay(`What did you learn about "${k.title}"?`)} className="w-full text-left">
                      <div className="flex items-center gap-2">
                        <BookOpenCheck className="w-3.5 h-3.5 text-violet-500 shrink-0" />
                        <span className="text-sm font-medium text-slate-800 dark:text-slate-100 truncate">{k.title}</span>
                        <span className="ml-auto text-[11px] text-slate-400 shrink-0">{ago(k.updatedAt)}</span>
                      </div>
                      <p className="text-xs text-slate-500 dark:text-slate-400 line-clamp-2 mt-0.5 pl-5">{k.preview}</p>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-slate-500">Nothing yet — press “Learn now” or say “learn about …”.</p>
            )}
          </div>
          {!!st?.learning.openQuestions.length && (
            <p className="text-xs text-slate-500">
              Will research tonight: {st.learning.openQuestions.slice(0, 3).map((q) => `“${q}”`).join(', ')}
            </p>
          )}
        </section>

        {/* Lessons & memory */}
        <section className={`${card} p-4 sm:p-5 lg:col-span-2 space-y-4`}>
          <SectionTitle icon={Sparkles} title="Lessons & memory" hint="RAY follows these" tone="text-amber-500" />
          <div>
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1.5">Lessons from its mistakes</p>
            {st?.lessons.length ? (
              <ul className="space-y-1.5">
                {st.lessons.slice(0, 6).map((l) => (
                  <li key={l} className="flex gap-2 text-xs text-slate-700 dark:text-slate-200">
                    <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 text-amber-500 shrink-0" />
                    {l}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-slate-500">
                None yet{st?.learning.pendingExperiences ? ` · ${st.learning.pendingExperiences} experience(s) to review tonight` : ''}. Correct RAY (“no, I meant…”) and it learns.
              </p>
            )}
          </div>
          <div>
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1.5">What RAY knows about you</p>
            {st?.memory.length ? (
              <ul className="space-y-1 text-xs text-slate-600 dark:text-slate-300 list-disc pl-4">
                {st.memory.slice(0, 6).map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-slate-500">Say “remember …” and RAY keeps it in Memory → About Ray.</p>
            )}
          </div>
        </section>
      </div>

      {/* Self-healing */}
      <section className={`${card} p-4 sm:p-5 space-y-4`}>
        <div className="flex items-center gap-2">
          <SectionTitle icon={ShieldCheck} title="Self-healing" hint="devices, apps, files and RAY itself" tone="text-emerald-500" />
        </div>
        {bridges.length === 0 && <p className="text-xs text-slate-500">Connect your PC or phone (Connect tab) so RAY can check and repair it.</p>}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {bridges.map((b) => {
            const d = diag[b.id];
            const upToDate = b.version === b.latest;
            return (
              <div key={b.id} className="rounded-xl border border-slate-200 dark:border-slate-800 p-3.5">
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${b.online ? 'bg-emerald-500' : 'bg-slate-400'}`} />
                  <span className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">{b.name}</span>
                  <span className={`ml-auto text-[10px] px-2 py-0.5 rounded-full ${upToDate ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-amber-500/10 text-amber-600 dark:text-amber-400'}`}>
                    v{b.version}
                    {upToDate ? '' : ` → ${b.latest} (auto-updating)`}
                  </span>
                </div>
                {d?.data && (
                  <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                    <div className="rounded-lg bg-slate-50 dark:bg-slate-800/60 py-2">
                      <HardDrive className="w-3.5 h-3.5 mx-auto text-slate-400" />
                      <p className="text-sm font-semibold mt-0.5">{d.data.disks?.[0]?.freePct ?? '–'}%</p>
                      <p className="text-[10px] text-slate-500">disk free</p>
                    </div>
                    <div className="rounded-lg bg-slate-50 dark:bg-slate-800/60 py-2">
                      <Cpu className="w-3.5 h-3.5 mx-auto text-slate-400" />
                      <p className="text-sm font-semibold mt-0.5">{d.data.memory?.usedPct ?? '–'}%</p>
                      <p className="text-[10px] text-slate-500">memory used</p>
                    </div>
                    <div className="rounded-lg bg-slate-50 dark:bg-slate-800/60 py-2">
                      <Activity className="w-3.5 h-3.5 mx-auto text-slate-400" />
                      <p className={`text-sm font-semibold mt-0.5 ${d.data.internet?.ok ? 'text-emerald-600' : 'text-rose-500'}`}>{d.data.internet?.ok ? `${d.data.internet.latencyMs} ms` : 'down'}</p>
                      <p className="text-[10px] text-slate-500">internet</p>
                    </div>
                  </div>
                )}
                {d?.data && (
                  <p className={`mt-2 text-xs ${d.data.issues?.length ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                    {d.data.issues?.length ? d.data.issues.join(' · ') : 'No problems found.'}
                  </p>
                )}
                {d?.error && <p className="mt-2 text-xs text-rose-500">{d.error}</p>}
                <div className="mt-3 flex gap-2">
                  <button type="button" className={btnGhost} disabled={!b.online || d?.loading} onClick={() => void diagnose(b.id)}>
                    {d?.loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Stethoscope className="w-3.5 h-3.5" />} Diagnose
                  </button>
                  <button type="button" className={btnGhost} disabled={!b.online} onClick={() => onAskRay(`Fix any problems on ${b.name}`)}>
                    <Wrench className="w-3.5 h-3.5" /> Fix
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        {(st?.repairs.length || st?.health.length) ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1">
            <div>
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1.5">Watchdog</p>
              <ul className="space-y-1 text-xs text-slate-600 dark:text-slate-300">
                {(st?.health || []).slice(0, 5).map((h) => (
                  <li key={h}>{h}</li>
                ))}
              </ul>
            </div>
            <div>
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1.5">Repair journal</p>
              <ul className="space-y-1 text-xs text-slate-600 dark:text-slate-300">
                {(st?.repairs || []).slice(0, 5).map((r) => (
                  <li key={r} className="truncate" title={r}>
                    {r}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}
        {!pcBridge && bridges.length > 0 && <p className="text-xs text-slate-500">Browser hands, the mouse and coding agents need the PC bridge online.</p>}
      </section>

      <AutopilotCard roomId={roomId} />
    </div>
  );
}
