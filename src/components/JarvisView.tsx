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
  Plug,
  Plus,
  RefreshCw,
  ShieldCheck,
  Link2,
  Download,
  Sparkles,
  Stethoscope,
  Wrench,
  X,
} from 'lucide-react';
import type { DeviceInfo } from '../types/relay';
import { authFetch, getStoredRoomToken } from '../utils/roomAuth';
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

interface ConnectorRow {
  id: string;
  name: string;
  host: string;
  hasKey: boolean;
  tools: Array<{ name: string; description: string }>;
  lastError: string | null;
}
interface PhoneLine {
  configured: boolean;
  missing: string[];
  number: string | null;
  calls: Array<{ id: string; purpose: string; status: string; transcript: Array<{ who: string; text: string }>; startedAt: number }>;
}
const PRESETS: Array<{ label: string; name: string; url: string; hint: string }> = [
  { label: 'AgentPhone', name: 'agentphone', url: 'https://mcp.agentphone.ai/mcp', hint: 'Numbers, SMS, WhatsApp, AI calls — API key from agentphone.ai → Settings' },
  { label: 'CallForMe', name: 'callforme', url: 'https://callforme.tel/mcp', hint: 'RAY calls businesses for you' },
  { label: 'n8n', name: 'n8n', url: '', hint: 'Your n8n: Settings → Instance-level MCP → copy URL + token' },
  { label: 'Course / challenge', name: 'challenge', url: '', hint: 'Paste the MCP link from the course page (RAY also tries /mcp on that site)' },
  { label: 'Custom', name: '', url: '', hint: 'Any Streamable-HTTP MCP server (https)' },
];

interface Accounts {
  google: { configured: boolean; connected: boolean; email: string | null };
  meta: { instagram: boolean; facebookPage: boolean; whatsapp: boolean };
}

export function JarvisView({
  roomId,
  devices,
  onAskRay,
  onOpenConnect,
}: {
  roomId: string;
  devices: DeviceInfo[];
  onAskRay: (prompt: string) => void;
  onOpenConnect?: () => void;
}) {
  const [accounts, setAccounts] = useState<Accounts | null>(null);
  const [st, setSt] = useState<JarvisStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [newTopic, setNewTopic] = useState('');
  const [learning, setLearning] = useState(false);
  const [diag, setDiag] = useState<Record<string, { loading: boolean; data?: Diagnosis; error?: string }>>({});
  const [popupMsg, setPopupMsg] = useState('');
  const [connectors, setConnectors] = useState<ConnectorRow[]>([]);
  const [phone, setPhone] = useState<PhoneLine | null>(null);
  const [preset, setPreset] = useState(0);
  const [cName, setCName] = useState(PRESETS[0].name);
  const [cUrl, setCUrl] = useState(PRESETS[0].url);
  const [cKey, setCKey] = useState('');
  const [cBusy, setCBusy] = useState(false);
  const [cMsg, setCMsg] = useState('');
  const [openConn, setOpenConn] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await authFetch(`/api/jarvis?room=${encodeURIComponent(roomId)}`, roomId);
      if (r.ok) setSt((await r.json()) as JarvisStatus);
      const a = await authFetch(`/api/accounts?room=${encodeURIComponent(roomId)}`, roomId);
      if (a.ok) setAccounts((await a.json()) as Accounts);
      const m = await authFetch(`/api/mcp?room=${encodeURIComponent(roomId)}`, roomId);
      if (m.ok) setConnectors(((await m.json()) as { connectors: ConnectorRow[] }).connectors);
      const p = await authFetch(`/api/phone?room=${encodeURIComponent(roomId)}`, roomId);
      if (p.ok) setPhone((await p.json()) as PhoneLine);
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
  const pcAny = bridges.find((b) => !/android/i.test(b.os));
  const outdated = bridges.filter((b) => b.online && !b.capabilities.includes('repair'));
  // Why an ability is unavailable, in words Ray can act on.
  const why = (cap: string): string => {
    if (caps.has(cap)) return '';
    const needsPc = cap !== 'repair' && cap !== 'popup' && cap !== 'calls';
    if (!bridges.some((b) => b.online)) return needsPc ? (pcAny ? 'PC is offline' : 'Connect your PC') : 'Connect a device';
    if (needsPc && !pcAny) return 'Connect your PC';
    if (needsPc && pcAny && !pcAny.online) return 'PC is offline';
    return 'Reinstall bridge (v3.1)';
  };
  const token = getStoredRoomToken(roomId);

  const pickPreset = (i: number) => {
    setPreset(i);
    setCName(PRESETS[i].name);
    setCUrl(PRESETS[i].url);
    setCMsg('');
  };
  const addConnector = async () => {
    setCBusy(true);
    setCMsg('');
    try {
      const r = await authFetch('/api/mcp/add', roomId, { method: 'POST', body: JSON.stringify({ roomId, name: cName, url: cUrl, token: cKey }) });
      const j = (await r.json()) as { ok: boolean; error?: string; connector?: ConnectorRow };
      if (!j.ok) setCMsg(j.error || 'Could not connect.');
      else {
        setCMsg(`Connected ${j.connector?.name} · ${j.connector?.tools.length} tools`);
        setCKey('');
        await load();
      }
    } catch {
      setCMsg('Network error.');
    } finally {
      setCBusy(false);
    }
  };
  const removeConnector = async (id: string) => {
    await authFetch('/api/mcp/remove', roomId, { method: 'POST', body: JSON.stringify({ roomId, id }) });
    await load();
  };
  const refreshConnector = async (id: string) => {
    await authFetch('/api/mcp/refresh', roomId, { method: 'POST', body: JSON.stringify({ roomId, id }) });
    await load();
  };
  const installer = (os: string) => `/api/bridge-installer?room=${encodeURIComponent(roomId)}&token=${encodeURIComponent(token)}&os=${os}`;

  const abilities: Array<{ icon: typeof Globe; label: string; on: boolean; detail: string; prompt: string; cap: string }> = [
    { icon: Globe, label: 'Browser hands', on: caps.has('browser-agent'), cap: 'browser-agent', detail: 'Reads, clicks and types in a real Chrome', prompt: 'Research the best budget phones this month and compare the top 3' },
    { icon: MousePointer2, label: 'Mouse & keyboard', on: caps.has('computer-use'), cap: 'computer-use', detail: 'Uses any app on the PC (and phone via ADB)', prompt: 'Show me how to turn on night light in Windows' },
    { icon: Code2, label: 'Coding agents', on: caps.has('coding-agents'), cap: 'coding-agents', detail: 'Claude Code, Codex, Gemini CLI, Aider in parallel', prompt: 'Which coding agents are installed on my PC?' },
    { icon: Wrench, label: 'Self-repair', on: caps.has('repair'), cap: 'repair', detail: 'Diagnoses and fixes devices, apps and files', prompt: 'Check my PC and fix anything that is wrong' },
    { icon: Phone, label: 'Calls', on: caps.has('calls'), cap: 'calls', detail: 'Rings devices, PC↔phone calls, schedules', prompt: 'Call my phone in 10 minutes' },
    { icon: MonitorUp, label: 'Pop-up anywhere', on: caps.has('popup'), cap: 'popup', detail: 'Ctrl+Alt+R on PC · notification on phone', prompt: 'Open RAY on my phone' },
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

      {(outdated.length > 0 || !pcAny?.online) && (
        <section className="rounded-2xl border border-amber-300/60 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/5 p-4 sm:p-5">
          <div className="flex flex-col md:flex-row md:items-center gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">
                {!pcAny ? 'Connect your PC to unlock the browser, mouse, coding agents and self-repair' : !pcAny.online ? `${pcAny.name} is offline` : 'One-time update needed'}
              </p>
              <p className="text-xs text-amber-800/80 dark:text-amber-200/70 mt-1">
                {outdated.length > 0
                  ? `${outdated.map((b) => b.name).join(', ')} run${outdated.length === 1 ? 's' : ''} an older RAY bridge that can't update itself. Run the installer once on that device — from v3.1 on, RAY keeps itself up to date.`
                  : !pcAny
                    ? 'Download the installer on your PC and double-click it. It installs RAY in the background and starts on every boot.'
                    : 'Turn the PC on (RAY starts with it). If it stays offline, run the installer again.'}
                {bridges.some((b) => /android/i.test(b.os) && !b.capabilities.includes('repair')) && ' Phone: in Termux run the command from Connect → Phone again.'}
              </p>
            </div>
            <div className="flex flex-wrap gap-2 md:ml-auto shrink-0">
              <a className={btnPrimary} href={installer('win')}>
                <Download className="w-3.5 h-3.5" /> Windows installer
              </a>
              <a className={btnGhost} href={installer('mac')}>macOS</a>
              <a className={btnGhost} href={installer('linux')}>Linux</a>
              {onOpenConnect && (
                <button type="button" className={btnGhost} onClick={onOpenConnect}>
                  Phone setup
                </button>
              )}
            </div>
          </div>
        </section>
      )}

      {/* Accounts */}
      <section className={`${card} p-4 sm:p-5`}>
        <SectionTitle icon={Link2} title="Accounts" hint="RAY uses these from any device, by voice or text" tone="text-sky-500" />
        <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3.5">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">Google</span>
              <span className="text-xs text-slate-500 truncate">Gmail · Calendar · Drive · Docs · Sheets · Slides · Tasks · Contacts · YouTube</span>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {accounts?.google.connected ? (
                <>
                  <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400 inline-flex items-center gap-1">
                    <CheckCircle2 className="w-3.5 h-3.5" /> Connected{accounts.google.email ? ` · ${accounts.google.email}` : ''}
                  </span>
                  <button type="button" className={btnGhost} onClick={() => onAskRay('Summarise my unread emails and today’s calendar')}>
                    Try it
                  </button>
                </>
              ) : accounts?.google.configured ? (
                <a className={btnPrimary} href={`/api/accounts/google/start?room=${encodeURIComponent(roomId)}&token=${encodeURIComponent(token)}`} target="_blank" rel="noreferrer">
                  Connect Google
                </a>
              ) : (
                <p className="text-xs text-slate-500">
                  Server setup needed once: add <code className="font-mono">GOOGLE_OAUTH_CLIENT_ID</code> and <code className="font-mono">GOOGLE_OAUTH_CLIENT_SECRET</code> in Render (README → Accounts).
                </p>
              )}
            </div>
          </div>
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3.5">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">Meta</span>
              <span className="text-xs text-slate-500 truncate">Instagram · Facebook Page · WhatsApp</span>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {(
                [
                  ['Instagram API', accounts?.meta.instagram],
                  ['Facebook Page', accounts?.meta.facebookPage],
                  ['WhatsApp Cloud', accounts?.meta.whatsapp],
                ] as const
              ).map(([label, on]) => (
                <span
                  key={label}
                  className={`text-[11px] px-2 py-0.5 rounded-full ${on ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-slate-100 dark:bg-slate-800 text-slate-500'}`}
                >
                  {label}: {on ? 'on' : 'off'}
                </span>
              ))}
            </div>
            <p className="mt-2 text-xs text-slate-500">
              Personal Instagram/WhatsApp have no API: RAY uses them through the browser on your PC and the apps on your phone. Business/creator accounts get full API access with a token in Render.
            </p>
          </div>
        </div>
      </section>

      {/* Connectors + phone line */}
      <section className={`${card} p-4 sm:p-5`}>
        <SectionTitle icon={Plug} title="Connectors" hint="Plug MCP servers into RAY — their tools work from one command" tone="text-violet-500" />
        <div className="mt-3 grid grid-cols-1 lg:grid-cols-[1.3fr_1fr] gap-3">
          <div className="space-y-2 min-w-0">
            {connectors.length === 0 && <p className="text-xs text-slate-500">Nothing connected yet. Add AgentPhone for SMS and calls, your n8n workflows, or a course server.</p>}
            {connectors.map((c) => (
              <div key={c.id} className="rounded-xl border border-slate-200 dark:border-slate-800 p-3">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${c.lastError ? 'bg-amber-500' : 'bg-emerald-500'}`} />
                  <span className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">{c.name}</span>
                  <span className="text-[11px] text-slate-500 truncate">{c.host}</span>
                  <span className="ml-auto text-[11px] text-slate-500 shrink-0">{c.tools.length} tools</span>
                </div>
                {c.lastError && <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">{c.lastError}</p>}
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <button type="button" className={btnGhost} onClick={() => setOpenConn(openConn === c.id ? null : c.id)}>
                    {openConn === c.id ? 'Hide tools' : 'Tools'}
                  </button>
                  <button type="button" className={btnGhost} onClick={() => void refreshConnector(c.id)}>
                    <RefreshCw className="w-3.5 h-3.5" /> Refresh
                  </button>
                  <button type="button" className={btnGhost} onClick={() => onAskRay(`What can you do with my ${c.name} connector? Give me 3 examples.`)}>
                    Ask RAY
                  </button>
                  <button type="button" className={`${btnGhost} text-rose-600 dark:text-rose-400`} onClick={() => void removeConnector(c.id)}>
                    <X className="w-3.5 h-3.5" /> Remove
                  </button>
                </div>
                {openConn === c.id && (
                  <ul className="mt-2 max-h-48 overflow-auto space-y-1 text-xs">
                    {c.tools.map((t) => (
                      <li key={t.name} className="min-w-0">
                        <code className="font-mono text-violet-600 dark:text-violet-400">{t.name}</code>
                        <span className="text-slate-500"> — {t.description || 'no description'}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3 space-y-2 min-w-0">
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((p, i) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => pickPreset(i)}
                  className={`text-[11px] px-2 py-1 rounded-full border ${preset === i ? 'border-violet-500 bg-violet-500/10 text-violet-700 dark:text-violet-300' : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'}`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-slate-500">{PRESETS[preset].hint}</p>
            <input className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent px-2.5 py-1.5 text-xs" placeholder="Name" value={cName} onChange={(e) => setCName(e.target.value)} />
            <input className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent px-2.5 py-1.5 text-xs font-mono" placeholder="https://…/mcp" value={cUrl} onChange={(e) => setCUrl(e.target.value)} />
            <input
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent px-2.5 py-1.5 text-xs font-mono"
              placeholder="API key / token (optional, stored encrypted)"
              type="password"
              autoComplete="off"
              value={cKey}
              onChange={(e) => setCKey(e.target.value)}
            />
            <div className="flex items-center gap-2">
              <button type="button" className={btnPrimary} disabled={cBusy || !cUrl.trim()} onClick={() => void addConnector()}>
                {cBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} Connect
              </button>
              {cMsg && <span className="text-xs text-slate-600 dark:text-slate-300 min-w-0 break-words">{cMsg}</span>}
            </div>
          </div>
        </div>

        <div className="mt-3 rounded-xl border border-slate-200 dark:border-slate-800 p-3">
          <div className="flex items-center gap-2 flex-wrap">
            <Phone className="w-4 h-4 text-emerald-500" />
            <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">Phone line</span>
            <span className="text-xs text-slate-500">RAY rings your real number and talks with you</span>
            {phone?.configured ? (
              <span className="ml-auto text-xs font-medium text-emerald-600 dark:text-emerald-400 inline-flex items-center gap-1">
                <CheckCircle2 className="w-3.5 h-3.5" /> Ready · {phone.number}
              </span>
            ) : null}
          </div>
          {phone?.configured ? (
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" className={btnGhost} onClick={() => onAskRay('Call my phone now and ask how my day is going')}>
                Test call
              </button>
              {phone.calls[0] && (
                <span className="text-xs text-slate-500 min-w-0 truncate">
                  Last: {phone.calls[0].status} · {ago(phone.calls[0].startedAt)}
                  {phone.calls[0].transcript.filter((t) => t.who === 'Ray').slice(-1).map((t) => ` · “${t.text}”`)}
                </span>
              )}
            </div>
          ) : (
            <p className="mt-2 text-xs text-slate-500">
              Add in Render: <code className="font-mono">{(phone?.missing || ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER', 'RAY_USER_PHONE']).join(', ')}</code> (README → Phone line). Until then RAY rings the RAY app with call_me.
            </p>
          )}
        </div>
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
                title={a.on ? 'Ready' : why(a.cap)}
                className={`ml-auto shrink-0 text-[10px] font-semibold uppercase tracking-wide sm:px-2 sm:py-0.5 rounded-full ${a.on ? 'sm:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'sm:bg-slate-100 sm:dark:bg-slate-800 text-slate-500'}`}
              >
                <span className={`sm:hidden inline-block w-2 h-2 rounded-full ${a.on ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'}`} />
                <span className="hidden sm:inline">{a.on ? 'Ready' : why(a.cap)}</span>
              </span>
            </div>
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400 line-clamp-2">{a.detail}</p>
            {!a.on && <p className="sm:hidden mt-1 text-[11px] font-medium text-amber-600 dark:text-amber-400">{why(a.cap)}</p>}
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
