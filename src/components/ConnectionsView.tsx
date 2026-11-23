import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Bell,
  BellRing,
  Check,
  Chrome,
  Cloud,
  Copy,
  Cpu,
  Download,
  ExternalLink,
  Instagram,
  Laptop,
  MessageCircle,
  Mic,
  RefreshCw,
  Smartphone,
  Sparkles,
  Zap,
} from 'lucide-react';
import type { DeviceInfo, EngineSettings, IncomingMessage } from '../types/relay';
import { authFetch, getStoredRoomToken } from '../utils/roomAuth';
import type { PushWakeStatus } from '../hooks/usePushWake';

interface EngineStatus {
  id: string;
  label: string;
  configured: boolean;
  available: boolean;
  requestsToday: number;
  dailyLimit: number;
  quotaUsedPct: number;
  coolingDownSec: number;
  supportsTools: boolean;
  signupUrl: string;
  notes: string;
}

interface HubHealth {
  storage?: 'gcs' | 'local';
  stableTokens?: boolean;
  pushReady?: boolean;
  hasGeminiKey?: boolean;
}

const ENV_KEY: Record<string, string> = {
  groq: 'GROQ_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  gemini: 'GEMINI_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  github: 'GITHUB_MODELS_TOKEN',
  openrouter: 'OPENROUTER_API_KEY',
  nvidia: 'NVIDIA_API_KEY',
  cloudflare: 'CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN',
  sambanova: 'SAMBANOVA_API_KEY',
  huggingface: 'HUGGINGFACE_API_KEY',
  cohere: 'COHERE_API_KEY',
  custom: 'CUSTOM_LLM_BASE_URL',
  llm7: 'LLM7_API_KEY (optional)',
};

function Dot({ ok, warn }: { ok: boolean; warn?: boolean }) {
  return (
    <span
      className={`inline-block w-2.5 h-2.5 rounded-full shrink-0 ${
        ok ? 'bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.18)]' : warn ? 'bg-amber-500' : 'bg-slate-300 dark:bg-slate-600'
      }`}
    />
  );
}

function CopyLine({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-start gap-2 rounded-lg bg-slate-950 text-slate-100 px-3 py-2 font-mono text-[11px] leading-relaxed">
      <code className="flex-1 break-all whitespace-pre-wrap">{text}</code>
      <button
        type="button"
        aria-label="Copy command"
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          });
        }}
        className="shrink-0 p-1 rounded hover:bg-white/10"
      >
        {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
      </button>
    </div>
  );
}

function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 sm:p-5 ${className}`}>
      {children}
    </section>
  );
}

export function ConnectionsView({
  roomId,
  devices,
  messages,
  engineSettings,
  onChangeEngineSettings,
  pushStatus,
  onEnablePush,
  voicePipeline,
  wakeEnabled,
}: {
  roomId: string;
  devices: DeviceInfo[];
  messages: IncomingMessage[];
  engineSettings: EngineSettings;
  onChangeEngineSettings: (updater: (prev: EngineSettings) => EngineSettings) => void;
  pushStatus: PushWakeStatus;
  onEnablePush: () => void;
  voicePipeline: 'live' | 'classic';
  wakeEnabled: boolean;
}) {
  const [engines, setEngines] = useState<EngineStatus[]>([]);
  const [health, setHealth] = useState<HubHealth>({});
  const [loading, setLoading] = useState(false);
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const token = getStoredRoomToken(roomId);
  const bridgeUrl = `${origin}/api/bridge-script?room=${encodeURIComponent(roomId)}&token=${encodeURIComponent(token)}`;
  const bridgeFile = `relay-bridge-${roomId.toLowerCase()}.mjs`;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [h, e] = await Promise.all([
        fetch('/api/health').then((r) => r.json()),
        authFetch(`/api/engines/status?room=${encodeURIComponent(roomId)}`, roomId).then((r) => r.json()),
      ]);
      setHealth(h as HubHealth);
      setEngines(((e as { engines?: EngineStatus[] }).engines || []) as EngineStatus[]);
    } catch {
      // offline
    } finally {
      setLoading(false);
    }
  }, [roomId]);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 30000);
    return () => window.clearInterval(id);
  }, [refresh]);

  const online = devices.filter((d) => d.online);
  const pcBridge = online.find((d) => d.type === 'bridge' && !/android/i.test(d.os));
  const phoneBridge = online.find((d) => d.type === 'bridge' && /android/i.test(d.os));
  const phoneApp = online.find((d) => d.type === 'mobile');
  const tabsExt = online.find((d) => d.capabilities?.includes('browser-tabs'));
  const ollamaHost = online.find((d) => d.telemetry?.ollamaRunning);
  const configured = engines.filter((e) => e.configured);
  const unconfigured = engines.filter((e) => !e.configured);

  const checklist = useMemo(
    () => [
      { label: 'Cloud hub', ok: true, detail: health.storage === 'gcs' ? 'Google Cloud Storage' : 'Local disk storage', icon: Cloud },
      { label: 'PC bridge', ok: Boolean(pcBridge), detail: pcBridge ? pcBridge.name : 'Not running', icon: Laptop },
      { label: 'Phone', ok: Boolean(phoneBridge || phoneApp), detail: phoneBridge ? 'Android bridge' : phoneApp ? 'RAY app open' : 'Offline', icon: Smartphone },
      { label: 'Browser tabs', ok: Boolean(tabsExt), detail: tabsExt ? `${tabsExt.telemetry?.openTabCount ?? 0} tabs` : 'Extension not paired', icon: Chrome },
      { label: 'Local Ollama', ok: Boolean(ollamaHost), detail: ollamaHost ? `${ollamaHost.telemetry?.ollamaModels?.length || 0} models` : 'Not detected', icon: Cpu },
      { label: 'Wake this device', ok: pushStatus === 'enabled', detail: pushStatus, icon: BellRing },
    ],
    [health.storage, pcBridge, phoneBridge, phoneApp, tabsExt, ollamaHost, pushStatus]
  );
  const readyCount = checklist.filter((c) => c.ok).length;

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[1200px] mx-auto p-4 sm:p-6 space-y-4 pb-24">
        {/* Hero */}
        <div className="rounded-2xl p-5 sm:p-6 bg-gradient-to-br from-slate-900 via-blue-950 to-slate-900 text-white relative overflow-hidden">
          <div className="absolute -right-16 -top-16 w-64 h-64 rounded-full bg-cyan-400/10 blur-2xl" />
          <div className="relative flex flex-col md:flex-row md:items-end justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-cyan-300/80">Connections</p>
              <h1 className="font-display text-2xl font-bold mt-1">RAY is {readyCount >= 4 ? 'fully connected' : 'partly connected'}</h1>
              <p className="text-sm text-slate-300 mt-1 max-w-xl">
                {readyCount}/{checklist.length} links active · voice: {voicePipeline === 'live' ? 'Gemini Live' : 'free pipeline'}
                {wakeEnabled ? ' · "Hey Ray" listening' : ''} · {configured.length} AI engines ready
              </p>
            </div>
            <button
              type="button"
              onClick={() => void refresh()}
              className="self-start md:self-auto inline-flex items-center gap-2 h-9 px-3 rounded-lg bg-white/10 hover:bg-white/15 text-sm"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
            </button>
          </div>
          <div className="relative grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 mt-5">
            {checklist.map((c) => {
              const Icon = c.icon;
              return (
                <div key={c.label} className="rounded-xl bg-white/5 border border-white/10 px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <Icon className="w-4 h-4 text-cyan-300" />
                    <Dot ok={c.ok} />
                  </div>
                  <p className="text-xs font-semibold mt-1.5">{c.label}</p>
                  <p className="text-[11px] text-slate-400 truncate">{c.detail}</p>
                </div>
              );
            })}
          </div>
          {!health.stableTokens && (
            <p className="relative mt-4 text-xs text-amber-300">
              Set RELAY_MASTER_SECRET on the server so pairing survives cloud restarts (otherwise bridges must re-pair after a redeploy).
            </p>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* PC bridge */}
          <Card>
            <div className="flex items-center gap-2">
              <Laptop className="w-4 h-4 text-blue-500" />
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">PC bridge (Windows · macOS · Linux)</h2>
              <span className="ml-auto"><Dot ok={Boolean(pcBridge)} /></span>
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-400 mt-2">
              Opens real tabs and apps, reads files, sees the screen and runs local Ollama. Run it once — it installs itself to start on boot and reconnects forever.
            </p>
            <div className="mt-3 space-y-2">
              <a
                href={bridgeUrl}
                download={bridgeFile}
                className="inline-flex items-center gap-2 h-9 px-3 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold"
              >
                <Download className="w-4 h-4" /> Download bridge
              </a>
              <CopyLine text={`cd Downloads && npm install ws && node ${bridgeFile}`} />
              <p className="text-[11px] text-slate-500">Needs Node.js 18+. Ollama (if installed) is started automatically.</p>
            </div>
          </Card>

          {/* Android */}
          <Card>
            <div className="flex items-center gap-2">
              <Smartphone className="w-4 h-4 text-emerald-500" />
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Android phone</h2>
              <span className="ml-auto"><Dot ok={Boolean(phoneBridge)} warn={Boolean(phoneApp && !phoneBridge)} /></span>
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-400 mt-2">
              Install <b>Termux</b>, <b>Termux:API</b> and <b>Termux:Boot</b> from F-Droid, then paste this in Termux. RAY can then open apps &amp; links on the phone and relay WhatsApp / Instagram notifications.
            </p>
            <div className="mt-3 space-y-2">
              <CopyLine text={`pkg install -y nodejs termux-api && mkdir -p ~/ray && cd ~/ray && curl -fsSL "${bridgeUrl}" -o ${bridgeFile} && npm install ws && node ${bridgeFile}`} />
              <p className="text-[11px] text-slate-500">
                Then allow Termux “Display over other apps” and grant Termux:API notification access. Open Termux:Boot once so it starts on boot.
              </p>
            </div>
          </Card>

          {/* Extension */}
          <Card>
            <div className="flex items-center gap-2">
              <Chrome className="w-4 h-4 text-amber-500" />
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">RAY Tabs browser extension</h2>
              <span className="ml-auto"><Dot ok={Boolean(tabsExt)} /></span>
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-400 mt-2">
              Lets RAY list, switch to, read, reload and close your tabs (“switch to my Gmail tab”, “close all YouTube tabs”). Pairs itself automatically the next time you open RAY.
            </p>
            <ol className="mt-3 text-xs text-slate-600 dark:text-slate-400 list-decimal pl-4 space-y-1">
              <li>
                <a className="text-blue-600 dark:text-blue-400 font-semibold" href="/api/extension/ray-tabs.zip">Download the extension</a> and unzip it.
              </li>
              <li>Open <code className="font-mono">chrome://extensions</code>, turn on Developer mode, click “Load unpacked”, pick the folder.</li>
              <li>Reload this RAY page — done.</li>
            </ol>
          </Card>

          {/* Push wake */}
          <Card>
            <div className="flex items-center gap-2">
              <Bell className="w-4 h-4 text-violet-500" />
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Wake this device remotely</h2>
              <span className="ml-auto"><Dot ok={pushStatus === 'enabled'} warn={pushStatus === 'denied'} /></span>
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-400 mt-2">
              When this device is closed or asleep, a command from another device sends a push here; tapping it opens RAY and runs the queued command. PCs with the bridge can also be woken with Wake-on-LAN.
            </p>
            <button
              type="button"
              disabled={pushStatus === 'enabled' || pushStatus === 'unsupported' || pushStatus === 'working'}
              onClick={onEnablePush}
              className="mt-3 inline-flex items-center gap-2 h-9 px-3 rounded-lg bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white text-xs font-semibold"
            >
              <BellRing className="w-4 h-4" />
              {pushStatus === 'enabled'
                ? 'Enabled on this device'
                : pushStatus === 'denied'
                ? 'Blocked in browser settings'
                : pushStatus === 'unsupported'
                ? 'Install RAY as an app first'
                : 'Enable wake-up notifications'}
            </button>
            <p className="text-[11px] text-slate-500 mt-2">
              Tip: also allow pop-ups for this site so RAY can open tabs here instantly.
            </p>
          </Card>
        </div>

        {/* Engines */}
        <Card>
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-cyan-500" />
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Free AI engines</h2>
              <span className="text-xs text-slate-500">auto-switching on limits & errors</span>
            </div>
            <div className="sm:ml-auto flex items-center gap-1 p-0.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-xs">
              {[
                { id: 'auto', label: 'Auto' },
                { id: 'swarm', label: 'Swarm' },
                { id: 'groq', label: 'Groq' },
                { id: 'cerebras', label: 'Cerebras' },
                { id: 'gemini', label: 'Gemini' },
              ].map((m) => {
                const active = engineSettings.provider === 'auto' && (engineSettings.routerMode || 'auto') === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => onChangeEngineSettings((prev) => ({ ...prev, provider: 'auto', routerMode: m.id }))}
                    className={`px-2.5 py-1.5 rounded-md font-medium ${
                      active ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm' : 'text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    {m.label}
                  </button>
                );
              })}
            </div>
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-400 mt-2">
            <b>Auto</b> picks the best engine per task (fast models for quick replies, coders for code, big models for reasoning, vision for images, Gemini for live web). <b>Swarm</b> splits big questions across several small models in parallel — RAY switches to it by itself when the big models near their daily limit.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 mt-4">
            {configured.map((e) => (
              <div key={e.id} className="rounded-xl border border-slate-200 dark:border-slate-800 p-3">
                <div className="flex items-center gap-2">
                  <Dot ok={e.available} warn={!e.available} />
                  <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">{e.label}</span>
                  {e.supportsTools && <Zap className="w-3.5 h-3.5 text-amber-500" aria-label="Can control devices" />}
                </div>
                <div className="mt-2 h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                  <div
                    className={`h-full rounded-full ${e.quotaUsedPct > 85 ? 'bg-red-500' : e.quotaUsedPct > 60 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                    style={{ width: `${Math.max(2, Math.min(100, e.quotaUsedPct))}%` }}
                  />
                </div>
                <p className="text-[11px] text-slate-500 mt-1.5">
                  {e.requestsToday}/{e.dailyLimit} today
                  {e.coolingDownSec > 0 ? ` · cooling down ${e.coolingDownSec}s` : ''}
                </p>
              </div>
            ))}
            {configured.length === 0 && (
              <p className="text-xs text-slate-500 col-span-full">No engine keys yet — add any one below (Groq or Cerebras recommended).</p>
            )}
          </div>

          {unconfigured.length > 0 && (
            <details className="mt-4 group">
              <summary className="cursor-pointer text-xs font-semibold text-blue-600 dark:text-blue-400">
                Add more free engines ({unconfigured.length} available, no credit card)
              </summary>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-3">
                {unconfigured.map((e) => (
                  <a
                    key={e.id}
                    href={e.signupUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-start gap-3 rounded-xl border border-dashed border-slate-300 dark:border-slate-700 p-3 hover:border-blue-400"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">{e.label}</p>
                      <p className="text-[11px] text-slate-500">{e.notes}</p>
                      <p className="text-[11px] font-mono text-slate-400 mt-1">{ENV_KEY[e.id] || 'API key'}</p>
                    </div>
                    <ExternalLink className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-1" />
                  </a>
                ))}
              </div>
            </details>
          )}
        </Card>

        {/* Messages */}
        <Card>
          <div className="flex items-center gap-2">
            <MessageCircle className="w-4 h-4 text-emerald-500" />
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Incoming messages</h2>
            <span className="text-xs text-slate-500">WhatsApp · Instagram · SMS · Telegram</span>
          </div>
          {messages.length === 0 ? (
            <p className="text-xs text-slate-500 mt-3">
              Nothing yet. Messages appear here (and on every device) once the Android bridge relays notifications, or the WhatsApp Cloud / Instagram APIs are connected. Ask “Hey Ray, any new messages?”
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-slate-100 dark:divide-slate-800">
              {messages.slice(0, 20).map((m) => (
                <li key={m.id} className="py-2.5 flex items-start gap-3">
                  <span
                    className={`mt-0.5 w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${
                      m.app === 'instagram' ? 'bg-pink-500/15 text-pink-500' : 'bg-emerald-500/15 text-emerald-500'
                    }`}
                  >
                    {m.app === 'instagram' ? <Instagram className="w-3.5 h-3.5" /> : <MessageCircle className="w-3.5 h-3.5" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-slate-900 dark:text-slate-100">
                      <b>{m.from}</b> <span className="text-[11px] text-slate-500 capitalize">· {m.app} · {new Date(m.receivedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      {!m.read && <span className="ml-2 inline-block w-1.5 h-1.5 rounded-full bg-blue-500 align-middle" />}
                    </p>
                    <p className="text-xs text-slate-600 dark:text-slate-400 break-words">{m.text}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="flex items-start gap-3">
          <Mic className="w-4 h-4 text-blue-500 mt-0.5" />
          <p className="text-xs text-slate-600 dark:text-slate-400">
            Try: “Hey Ray, play lo-fi on YouTube on my PC” · “open Spotify on my phone” · “which tabs do I have open?” · “read my latest WhatsApp messages” · “message Mom on WhatsApp that I’ll be late” · “what’s in my Downloads folder?”
          </p>
        </Card>
      </div>
    </div>
  );
}
