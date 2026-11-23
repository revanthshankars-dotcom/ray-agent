import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  Blocks,
  Bot,
  Brain,
  Calendar,
  Camera,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Cpu,
  ExternalLink,
  FileCode2,
  Folder,
  FolderOpen,
  FolderUp,
  Globe,
  HardDrive,
  Lock,
  Mic,
  Monitor,
  OctagonX,
  Plus,
  RefreshCw,
  Search,
  Send,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  Timer,
  X,
} from 'lucide-react';
import type { ActiveTab } from './TopBar';
import type {
  AppConnector,
  AppConnectorCategory,
  AppConnectorType,
  BrainNote,
  ChatMessage,
  DeviceInfo,
  EngineSettings,
  LiveVoiceState,
  ProtocolName,
  SharedTask,
  SyncTimer,
} from '../types/relay';
import {
  captureScreenViaLocalBridge,
  getActiveWindowViaLocalBridge,
  getLocalBridgeRoots,
  listBridgeDirectory,
  probeLocalDirectBridge,
  readBridgeFile,
} from '../services/localBridgeClient';
import type { LocalBridgeRoot, LocalFileEntry } from '../services/localBridgeClient';
import { authFetch } from '../utils/roomAuth';
import { playHudSound } from '../utils/hudAudio';
import { RayCoreFace } from './RayCoreFace';
import type { LocalBridgeMonitorState } from '../hooks/useLocalBridgeMonitor';

interface DashboardViewProps {
  roomId: string;
  roomToken: string;
  bridgeMonitor: LocalBridgeMonitorState;
  userName: string;
  userPhotoUrl?: string | null;
  devices: DeviceInfo[];
  messages: ChatMessage[];
  tasks: SharedTask[];
  timers: SyncTimer[];
  notes: BrainNote[];
  connectors: AppConnector[];
  engineSettings: EngineSettings;
  onChangeEngineSettings: React.Dispatch<React.SetStateAction<EngineSettings>>;
  voiceState: LiveVoiceState;
  hasBridgeOnline: boolean;
  screenSharing: boolean;
  screenControlArmed: boolean;
  googleAuthorized: boolean;
  onSelectTab: (tab: ActiveTab) => void;
  onAskRay: (prompt: string) => void;
  onAskRayWithContext: (
    prompt: string,
    imageAttachment?: { name: string; dataUrl: string; mimeType: string }
  ) => void;
  onToggleVoice: () => void;
  onEmergencyStop: () => void;
  onOpenPairModal: () => void;
  onToggleTask: (id: string) => void;
  onCreateTask: (title: string) => void;
  onCreateTimer: (label: string, durationSeconds: number, targetDevice: string) => void;
  onSaveNote: (note: BrainNote) => Promise<void> | void;
  onSaveConnector: (connector: AppConnector) => Promise<void> | void;
  onConnectGoogleWorkspace: () => Promise<string | null>;
  onToggleScreenControlArmed: () => Promise<void>;
  onToggleScreenShare: () => Promise<void>;
  onCaptureBrowserScreenFrame: () => string | null;
  onRunProtocol: (protocol: ProtocolName) => Promise<void>;
}

function getGreeting(now: Date): string {
  const hr = now.getHours();
  if (hr < 12) return 'Good morning';
  if (hr < 17) return 'Good afternoon';
  return 'Good evening';
}

function formatRemaining(endsAt: number, nowMs: number): string {
  const diff = Math.max(0, Math.ceil((endsAt - nowMs) / 1000));
  const m = Math.floor(diff / 60);
  const s = diff % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function TelemetrySparkline({
  values,
  strokeClass,
}: {
  values: number[];
  strokeClass: string;
}) {
  const safe = values.length >= 2 ? values : [0, 0];
  const width = 120;
  const height = 28;
  const points = safe
    .map((v, idx) => {
      const x = (idx / Math.max(1, safe.length - 1)) * width;
      const clamped = Math.max(0, Math.min(100, v));
      const y = height - (clamped / 100) * (height - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={`w-full h-7 overflow-visible ${strokeClass}`}
      fill="none"
      aria-hidden="true"
    >
      <polyline
        points={points}
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  roomId,
  roomToken,
  bridgeMonitor,
  userName,
  userPhotoUrl,
  devices,
  messages,
  tasks,
  timers,
  notes,
  connectors,
  engineSettings,
  onChangeEngineSettings,
  voiceState,
  hasBridgeOnline,
  screenSharing,
  screenControlArmed,
  googleAuthorized,
  onSelectTab,
  onAskRay,
  onAskRayWithContext,
  onToggleVoice,
  onEmergencyStop,
  onOpenPairModal,
  onToggleTask,
  onCreateTask,
  onCreateTimer,
  onSaveNote,
  onSaveConnector,
  onConnectGoogleWorkspace,
  onToggleScreenControlArmed,
  onToggleScreenShare,
  onCaptureBrowserScreenFrame,
  onRunProtocol,
}) => {
  const [now, setNow] = useState(() => new Date());
  const [globalQuery, setGlobalQuery] = useState('');
  const [quickPrompt, setQuickPrompt] = useState('');
  const [assistantMode, setAssistantMode] = useState<'Chat' | 'Research' | 'Code' | 'Analyze'>('Chat');
  const [newTaskInput, setNewTaskInput] = useState('');
  const [quickNoteTitle, setQuickNoteTitle] = useState('');
  const [quickNoteOpen, setQuickNoteOpen] = useState(false);

  // Live Telemetry Sparklines
  const [cpuHistory, setCpuHistory] = useState<number[]>([0, 0]);
  const [memHistory, setMemHistory] = useState<number[]>([0, 0]);

  // Quick Add App drawer
  const [addAppOpen, setAddAppOpen] = useState(false);
  const [newAppName, setNewAppName] = useState('');
  const [newAppTarget, setNewAppTarget] = useState('');
  const [newAppType, setNewAppType] = useState<AppConnectorType>('url_template');
  const [newAppCategory, setNewAppCategory] = useState<AppConnectorCategory>('automation');
  const [appNotice, setAppNotice] = useState<string | null>(null);

  // Local Direct Bridge & OS Files Quick Explorer
  const [localBridgeAlive, setLocalBridgeAlive] = useState(false);
  const [checkingBridge, setCheckingBridge] = useState(false);
  const [fsRoots, setFsRoots] = useState<LocalBridgeRoot[]>([]);
  const [fsPath, setFsPath] = useState('');
  const [fsParent, setFsParent] = useState('');
  const [fsEntries, setFsEntries] = useState<LocalFileEntry[]>([]);
  const [fsLoading, setFsLoading] = useState(false);
  const [fsNotice, setFsNotice] = useState<string | null>(null);

  // Live Screen Vision + Active Window
  const [activeWindowTitle, setActiveWindowTitle] = useState<string>('');
  const [screenPreviewUrl, setScreenPreviewUrl] = useState<string | null>(null);
  const [capturingScreen, setCapturingScreen] = useState(false);
  const [runningProto, setRunningProto] = useState<ProtocolName | null>(null);
  const [copiedTokenFix, setCopiedTokenFix] = useState(false);

  const globalInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // Press `/` anywhere outside inputs to focus global omni-command bar
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      e.preventDefault();
      globalInputRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const loadQuickDirectory = useCallback(
    async (dirPath: string) => {
      setFsLoading(true);
      try {
        const res = await listBridgeDirectory(roomId, dirPath);
        if (res.ok && res.data) {
          setFsPath(res.data.currentPath);
          setFsParent(res.data.parentPath);
          setFsEntries(res.data.items.slice(0, 12));
          setFsNotice(null);
        } else {
          setFsNotice(res.error || 'Could not read folder.');
        }
      } finally {
        setFsLoading(false);
      }
    },
    [roomId]
  );

  const checkBridgeNow = useCallback(async () => {
    setCheckingBridge(true);
    try {
      await bridgeMonitor.refreshNow();
      const [probe, rootsRes, winRes] = await Promise.all([
        probeLocalDirectBridge(roomId),
        getLocalBridgeRoots(roomId),
        getActiveWindowViaLocalBridge(roomId),
      ]);
      setLocalBridgeAlive(Boolean(probe?.ok));
      if (winRes.ok && winRes.data?.activeWindow) {
        setActiveWindowTitle(winRes.data.activeWindow);
      }
      if (rootsRes.ok && rootsRes.data?.roots) {
        setFsRoots(rootsRes.data.roots);
        if (rootsRes.data.roots.length > 0 && !fsPath) {
          await loadQuickDirectory(rootsRes.data.roots[0].path);
        }
      }
    } finally {
      setCheckingBridge(false);
    }
  }, [bridgeMonitor, fsPath, loadQuickDirectory, roomId]);

  useEffect(() => {
    setLocalBridgeAlive(bridgeMonitor.status === 'connected');
    if (bridgeMonitor.status === 'connected' && fsRoots.length === 0) {
      void Promise.all([getLocalBridgeRoots(roomId), getActiveWindowViaLocalBridge(roomId)]).then(
        async ([rootsRes, winRes]) => {
          if (winRes.ok && winRes.data?.activeWindow) {
            setActiveWindowTitle(winRes.data.activeWindow);
          }
          if (rootsRes.ok && rootsRes.data?.roots) {
            setFsRoots(rootsRes.data.roots);
            if (rootsRes.data.roots.length > 0 && !fsPath) {
              await loadQuickDirectory(rootsRes.data.roots[0].path);
            }
          }
        }
      );
    }
  }, [bridgeMonitor.status, fsPath, fsRoots.length, loadQuickDirectory, roomId]);

  const onlineDevices = useMemo(() => devices.filter((d) => d.online), [devices]);
  const primaryTelemetryDevice = useMemo(
    () =>
      onlineDevices.find((d) => d.type === 'bridge' && d.telemetry?.cpuPercent != null) ||
      onlineDevices.find((d) => d.telemetry?.cpuPercent != null) ||
      onlineDevices[0],
    [onlineDevices]
  );

  // Append real telemetry samples for sparklines
  useEffect(() => {
    const cpu = primaryTelemetryDevice?.telemetry?.cpuPercent;
    const mem = primaryTelemetryDevice?.telemetry?.memoryPercent;
    if (typeof cpu === 'number') {
      setCpuHistory((prev) => [...prev.slice(-15), cpu]);
    }
    if (typeof mem === 'number') {
      setMemHistory((prev) => [...prev.slice(-15), mem]);
    }
  }, [primaryTelemetryDevice?.telemetry?.cpuPercent, primaryTelemetryDevice?.telemetry?.memoryPercent]);

  const recentMessages = useMemo(() => messages.slice(-3), [messages]);
  const openTasks = useMemo(() => tasks.filter((t) => !t.completed).slice(0, 5), [tasks]);
  const recentNotes = useMemo(
    () => [...notes].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5),
    [notes]
  );

  const searchMatches = useMemo(() => {
    const q = globalQuery.trim().toLowerCase();
    if (!q) {
      return {
        notes: [] as BrainNote[],
        apps: [] as AppConnector[],
        files: [] as LocalFileEntry[],
      };
    }
    return {
      notes: notes
        .filter((n) => n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q))
        .slice(0, 4),
      apps: connectors
        .filter(
          (c) =>
            c.enabled &&
            (c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q))
        )
        .slice(0, 4),
      files: fsEntries
        .filter((f) => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q))
        .slice(0, 4),
    };
  }, [connectors, fsEntries, globalQuery, notes]);

  const handleGlobalSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = globalQuery.trim();
    if (!q) return;
    if (searchMatches.apps.length === 1 && !q.includes(' ')) {
      setGlobalQuery('');
      void handleLaunchApp(searchMatches.apps[0]);
      return;
    }
    setGlobalQuery('');
    onAskRay(q);
  };

  const handleQuickPromptSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = quickPrompt.trim();
    if (!text) return;
    const prefix =
      assistantMode === 'Research'
        ? 'Research thoroughly and cite sources: '
        : assistantMode === 'Code'
        ? 'Write clean production code for: '
        : assistantMode === 'Analyze'
        ? 'Analyze this step-by-step: '
        : '';
    setQuickPrompt('');
    if (screenPreviewUrl) {
      onAskRayWithContext(prefix + text, {
        name: 'desktop-screen.png',
        dataUrl: screenPreviewUrl,
        mimeType: 'image/png',
      });
    } else {
      onAskRay(prefix + text);
    }
  };

  const handleSnapScreenInline = async () => {
    setCapturingScreen(true);
    try {
      if (screenSharing) {
        const frame = onCaptureBrowserScreenFrame();
        if (frame) {
          setScreenPreviewUrl(frame);
          playHudSound('blip');
          return;
        }
      }
      const [capRes, winRes] = await Promise.all([
        captureScreenViaLocalBridge(roomId),
        getActiveWindowViaLocalBridge(roomId),
      ]);
      if (winRes.ok && winRes.data?.activeWindow) {
        setActiveWindowTitle(winRes.data.activeWindow);
      }
      if (capRes.ok && capRes.data?.dataUrl) {
        setScreenPreviewUrl(capRes.data.dataUrl);
        playHudSound('affirmative');
        setFsNotice(null);
        return;
      }
      // Fall back to starting browser screen share
      await onToggleScreenShare();
    } finally {
      setCapturingScreen(false);
    }
  };

  const handleQuickOpenFileToRay = async (entry: LocalFileEntry) => {
    if (entry.kind === 'dir') {
      await loadQuickDirectory(entry.path);
      return;
    }
    const res = await readBridgeFile(roomId, entry.path, 1, 250);
    if (res.ok && res.data) {
      onAskRayWithContext(
        `Inspect and summarize this system file (${res.data.path}):\n\n\`\`\`\n${res.data.content.slice(0, 4000)}\n\`\`\``
      );
    } else {
      setFsNotice(res.error || `Unable to read ${entry.name}`);
    }
  };

  const handleAddTaskSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const t = newTaskInput.trim();
    if (!t) return;
    onCreateTask(t);
    setNewTaskInput('');
    playHudSound('blip');
  };

  const handleCreateQuickNote = async (e: React.FormEvent) => {
    e.preventDefault();
    const title = quickNoteTitle.trim();
    if (!title) return;
    const timestamp = Date.now();
    await onSaveNote({
      id: `note-${timestamp}`,
      title,
      slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `note-${timestamp}`,
      folder: 'Inbox',
      content: `# ${title}\n\nCaptured from RAY Command Center.\n\n- [ ] Next action\n\n#inbox #ray`,
      tags: ['inbox', 'ray'],
      links: [],
      source: 'user',
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    setQuickNoteTitle('');
    setQuickNoteOpen(false);
    playHudSound('affirmative');
  };

  const handleAddCustomApp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newAppName.trim() || !newAppTarget.trim()) return;
    const ts = Date.now();
    const connector: AppConnector = {
      id: `conn-${ts}`,
      name: newAppName.trim(),
      category: newAppCategory,
      connectorType: newAppType,
      endpointOrTarget: newAppTarget.trim(),
      method: newAppType === 'webhook' ? 'POST' : 'LAUNCH',
      description: `Added from RAY Command Center (${newAppType})`,
      headersJson: '{}',
      enabled: true,
      requiresConfirmation: false,
      createdAt: ts,
      updatedAt: ts,
    };
    await onSaveConnector(connector);
    setAppNotice(`Added "${connector.name}" — RAY can open or invoke it anytime.`);
    setNewAppName('');
    setNewAppTarget('');
    setAddAppOpen(false);
    playHudSound('affirmative');
  };

  const handleLaunchApp = async (conn: AppConnector) => {
    setAppNotice(null);
    if (conn.connectorType === 'url_template' && /^https?:\/\//i.test(conn.endpointOrTarget)) {
      const cleanUrl = conn.endpointOrTarget.replace(/\{\{[^}]+\}\}/g, '');
      window.open(cleanUrl, '_blank', 'noopener,noreferrer');
      setAppNotice(`Opened ${conn.name}.`);
      return;
    }
    try {
      const res = await authFetch('/api/connectors/test', roomId, {
        method: 'POST',
        body: JSON.stringify({ roomId, connector: conn, args: {} }),
      });
      const data = (await res.json()) as { result?: string; error?: string };
      setAppNotice(data.result || data.error || `Triggered ${conn.name}`);
    } catch (err) {
      setAppNotice(err instanceof Error ? err.message : `Could not launch ${conn.name}`);
    }
  };

  const builtInQuickApps = [
    {
      label: 'Gmail',
      action: () =>
        googleAuthorized
          ? onAskRay('Check my unread Gmail messages')
          : void onConnectGoogleWorkspace(),
    },
    {
      label: 'Calendar',
      action: () =>
        googleAuthorized
          ? onAskRay('Brief me on my upcoming Google Calendar events')
          : void onConnectGoogleWorkspace(),
    },
    {
      label: 'Drive',
      action: () =>
        googleAuthorized
          ? onAskRay('Search my recent Google Drive files')
          : void onConnectGoogleWorkspace(),
    },
    {
      label: 'Brave Search',
      action: () => window.open('https://search.brave.com', '_blank', 'noopener,noreferrer'),
    },
    {
      label: 'NotebookLM',
      action: () => window.open('https://notebooklm.google.com', '_blank', 'noopener,noreferrer'),
    },
    {
      label: 'WhatsApp',
      action: () => window.open('https://web.whatsapp.com', '_blank', 'noopener,noreferrer'),
    },
  ];

  const isVoiceActive = voiceState !== 'off';
  const bridgeAnyOnline = hasBridgeOnline || localBridgeAlive;
  const cpuCurrent = primaryTelemetryDevice?.telemetry?.cpuPercent;
  const memCurrent = primaryTelemetryDevice?.telemetry?.memoryPercent;
  const displayActiveWindow =
    activeWindowTitle || primaryTelemetryDevice?.telemetry?.activeWindow || '';
  const engineLabel =
    engineSettings.provider === 'openrouter'
      ? `OpenRouter · ${engineSettings.openrouterModel}`
      : engineSettings.provider === 'ollama'
      ? `Ollama · ${engineSettings.ollamaModel}`
      : 'Gemini · Cloud';

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto space-y-5">
      {/* 1. Command Header: Greeting + Omni-Search (Notes, Apps, Files, Commands) + Clock & Voice */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 sm:p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="flex items-center gap-3.5 min-w-0">
          {userPhotoUrl ? (
            <img
              src={userPhotoUrl}
              alt={userName}
              referrerPolicy="no-referrer"
              className="w-11 h-11 rounded-full object-cover border border-slate-200 dark:border-slate-700 shrink-0"
            />
          ) : (
            <div className="w-11 h-11 rounded-full bg-blue-600 text-white font-display font-bold text-base flex items-center justify-center shrink-0">
              {userName.slice(0, 1).toUpperCase()}
            </div>
          )}
          <div className="min-w-0">
            <h1 className="font-display text-lg sm:text-xl font-semibold text-slate-900 dark:text-slate-100 truncate">
              {getGreeting(now)}, {userName}!
            </h1>
            <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
              RAY Command Center · {engineLabel}
              {displayActiveWindow ? ` · Focus: ${displayActiveWindow}` : ''}
            </p>
          </div>
        </div>

        {/* Global Omni-Search / Command Input */}
        <form onSubmit={handleGlobalSubmit} className="relative flex-1 max-w-xl">
          <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            ref={globalInputRef}
            id="ray-global-command-input"
            type="text"
            value={globalQuery}
            onChange={(e) => setGlobalQuery(e.target.value)}
            placeholder="Search anything (/): ask RAY, system files, Brain notes, or apps..."
            className="w-full pl-9 pr-20 py-2.5 text-sm bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:border-blue-600"
          />
          <button
            type="submit"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-md whitespace-nowrap"
          >
            Ask RAY
          </button>

          {globalQuery.trim() && (
            <div className="absolute left-0 right-0 top-full mt-1.5 z-30 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-2 space-y-1 shadow-lg">
              {searchMatches.apps.map((app) => (
                <button
                  key={app.id}
                  type="button"
                  onClick={() => {
                    setGlobalQuery('');
                    void handleLaunchApp(app);
                  }}
                  className="w-full text-left px-2.5 py-1.5 rounded text-xs hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-between gap-2"
                >
                  <span className="font-medium text-slate-900 dark:text-slate-100">
                    Launch App: {app.name}
                  </span>
                  <ExternalLink className="w-3.5 h-3.5 text-slate-400" />
                </button>
              ))}
              {searchMatches.notes.map((note) => (
                <button
                  key={note.id}
                  type="button"
                  onClick={() => {
                    setGlobalQuery('');
                    onSelectTab('brain');
                  }}
                  className="w-full text-left px-2.5 py-1.5 rounded text-xs hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-between gap-2"
                >
                  <span className="font-medium text-slate-900 dark:text-slate-100 truncate">
                    Brain Note: {note.title}
                  </span>
                  <span className="text-[11px] text-slate-400 shrink-0">{note.folder}</span>
                </button>
              ))}
              {searchMatches.files.map((file) => (
                <button
                  key={file.path}
                  type="button"
                  onClick={() => {
                    setGlobalQuery('');
                    void handleQuickOpenFileToRay(file);
                  }}
                  className="w-full text-left px-2.5 py-1.5 rounded text-xs hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-between gap-2"
                >
                  <span className="font-medium text-slate-900 dark:text-slate-100 truncate">
                    OS File: {file.name}
                  </span>
                  <span className="text-[11px] font-mono text-slate-400 shrink-0">
                    {file.kind === 'dir' ? 'DIR' : formatBytes(file.sizeBytes)}
                  </span>
                </button>
              ))}
              <button
                type="button"
                onClick={() => {
                  const q = globalQuery.trim();
                  setGlobalQuery('');
                  onAskRay(`Search my system files and Second Brain for: ${q}`);
                }}
                className="w-full text-left px-2.5 py-1.5 rounded text-xs hover:bg-blue-50 dark:hover:bg-blue-950/40 text-blue-700 dark:text-blue-300 font-medium flex items-center justify-between gap-2"
              >
                <span>Ask RAY to search OS files &amp; Brain for &ldquo;{globalQuery.trim()}&rdquo;</span>
                <ArrowRight className="w-3.5 h-3.5 shrink-0" />
              </button>
            </div>
          )}
        </form>

        {/* Live Clock + Voice Core */}
        <div className="flex items-center justify-between lg:justify-end gap-4 shrink-0">
          <div className="text-right tabular-nums">
            <div className="text-xs text-slate-500 dark:text-slate-400">
              {now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}
            </div>
            <div className="font-mono text-base font-semibold text-slate-900 dark:text-slate-100">
              {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </div>
          </div>

          <button
            type="button"
            onClick={onToggleVoice}
            className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-semibold border transition-colors whitespace-nowrap shrink-0 ${
              isVoiceActive
                ? 'bg-blue-600 border-blue-600 text-white'
                : 'bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 hover:border-blue-600'
            }`}
            title="Start or stop hands-free RAY Voice"
          >
            <Mic className="w-3.5 h-3.5" />
            <span>
              {voiceState === 'off'
                ? 'Voice'
                : voiceState === 'standby'
                ? 'Standby ("Hey Ray")'
                : voiceState === 'listening'
                ? 'Listening...'
                : 'RAY Active'}
            </span>
          </button>
        </div>
      </section>

      {bridgeMonitor.status === 'token_mismatch' && (
        <section className="rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-3.5 flex flex-col md:flex-row md:items-center justify-between gap-3 text-xs">
          <div className="space-y-0.5 text-amber-900 dark:text-amber-200">
            <div className="font-semibold flex items-center gap-1.5">
              <ShieldAlert className="w-4 h-4 shrink-0" />
              <span>Desktop Bridge (127.0.0.1:17345) has an older token — sync once to unlock OS Files, Screen &amp; Ollama:</span>
            </div>
            <div className="font-mono text-[11px] opacity-90 break-all">
              node &quot;.\Downloads\relay-bridge-{roomId.toLowerCase()}.mjs&quot; --set-token {roomToken || '<ROOM_TOKEN>'}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => {
                const cmd = `node ".\\Downloads\\relay-bridge-${roomId.toLowerCase()}.mjs" --set-token ${roomToken}`;
                void navigator.clipboard.writeText(cmd).then(() => {
                  setCopiedTokenFix(true);
                  window.setTimeout(() => setCopiedTokenFix(false), 1800);
                });
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 font-semibold bg-amber-600 hover:bg-amber-700 text-white rounded-lg whitespace-nowrap"
            >
              <Copy className="w-3.5 h-3.5" />
              <span>{copiedTokenFix ? 'Copied Fix' : 'Copy --set-token'}</span>
            </button>
            <button
              type="button"
              onClick={onOpenPairModal}
              className="px-3 py-1.5 font-medium border border-amber-400 dark:border-amber-700 text-amber-900 dark:text-amber-200 rounded-lg hover:bg-amber-100 dark:hover:bg-amber-900/40 whitespace-nowrap"
            >
              Bridge Setup
            </button>
          </div>
        </section>
      )}

      {/* 2. Full-Width 4-Column Live Telemetry & KPI Ribbon */}
      <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 tabular-nums">
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 flex flex-col justify-between gap-2">
          <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
            <span>Processor Load</span>
            <Cpu className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
          </div>
          <div className="flex items-end justify-between gap-3">
            <div>
              <div className="font-mono text-xl font-semibold text-slate-900 dark:text-slate-100">
                {cpuCurrent != null ? `${cpuCurrent}%` : 'Nominal'}
              </div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate max-w-[130px]">
                {primaryTelemetryDevice?.name || 'No telemetry yet'}
              </div>
            </div>
            <div className="w-24 shrink-0">
              <TelemetrySparkline
                values={cpuHistory}
                strokeClass="text-blue-600 dark:text-blue-400"
              />
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 flex flex-col justify-between gap-2">
          <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
            <span>Memory Utilization</span>
            <Terminal className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
          </div>
          <div className="flex items-end justify-between gap-3">
            <div>
              <div className="font-mono text-xl font-semibold text-slate-900 dark:text-slate-100">
                {memCurrent != null ? `${memCurrent}%` : 'Ready'}
              </div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate max-w-[140px]">
                {primaryTelemetryDevice?.telemetry?.topProcesses?.[0]
                  ? `Top: ${primaryTelemetryDevice.telemetry.topProcesses[0].name}`
                  : bridgeAnyOnline
                  ? 'OS Bridge synced'
                  : 'Local bridge idle'}
              </div>
            </div>
            <div className="w-24 shrink-0">
              <TelemetrySparkline
                values={memHistory}
                strokeClass="text-emerald-600 dark:text-emerald-400"
              />
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 flex flex-col justify-between gap-2">
          <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
            <span>Screen &amp; Window Vision</span>
            <Monitor className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
          </div>
          <div className="flex items-end justify-between gap-2">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
                {displayActiveWindow || (screenSharing ? 'Live Browser Stream' : 'Standby')}
              </div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400">
                {localBridgeAlive
                  ? 'Bridge 17345 Active'
                  : hasBridgeOnline
                  ? 'WS Mesh Online'
                  : 'Browser Capture Ready'}
              </div>
            </div>
            <button
              type="button"
              onClick={() => void handleSnapScreenInline()}
              disabled={capturingScreen}
              className="px-2.5 py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-md whitespace-nowrap shrink-0"
            >
              {capturingScreen ? 'Snapping...' : 'Snap Screen'}
            </button>
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 flex flex-col justify-between gap-2">
          <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
            <span>Brain, Files &amp; Mesh</span>
            <Brain className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
          </div>
          <div className="flex items-end justify-between gap-2">
            <div>
              <div className="font-mono text-xl font-semibold text-slate-900 dark:text-slate-100">
                {notes.length} notes · {onlineDevices.length} online
              </div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400">
                {fsRoots.length > 0 ? `${fsRoots.length} OS roots mounted` : `${openTasks.length} open tasks`}
              </div>
            </div>
            <button
              type="button"
              onClick={() => onSelectTab('files')}
              className="px-2.5 py-1.5 text-xs font-medium border border-slate-200 dark:border-slate-700 hover:border-blue-600 rounded-md text-slate-800 dark:text-slate-200 whitespace-nowrap shrink-0"
            >
              Files &amp; OS
            </button>
          </div>
        </div>
      </section>

      {/* 3. Main 12-Column Agentic OS Grid */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-5">
        {/* Column 1 (5 cols): JARVIS-Inspired RAY Core Orb + AI Command Console + Second Brain */}
        <div className="xl:col-span-5 space-y-5">
          <RayCoreFace
            voiceState={voiceState}
            bridgeConnected={bridgeAnyOnline}
            ollamaRunning={bridgeMonitor.ollamaRunning}
            engineLabel={engineLabel}
            onToggleVoice={onToggleVoice}
          />

          {/* AI Assistant Console */}
          <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 sm:p-5 space-y-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Bot className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                  RAY AI Console
                </h2>
              </div>

              {/* Engine Switcher */}
              <div className="flex items-center p-0.5 bg-slate-100 dark:bg-slate-950 rounded-lg border border-slate-200 dark:border-slate-800">
                {(['gemini', 'openrouter', 'ollama'] as const).map((prov) => (
                  <button
                    key={prov}
                    type="button"
                    onClick={() =>
                      onChangeEngineSettings((prev) => ({ ...prev, provider: prov }))
                    }
                    className={`px-2 py-1 text-[11px] font-medium rounded-md capitalize transition-colors ${
                      engineSettings.provider === prov
                        ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                        : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                    }`}
                  >
                    {prov}
                  </button>
                ))}
              </div>
            </div>

            {/* Mode Segmented Filter */}
            <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-950 rounded-lg border border-slate-200 dark:border-slate-800">
              {(['Chat', 'Research', 'Code', 'Analyze'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setAssistantMode(mode)}
                  className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                    assistantMode === mode
                      ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>

            {/* Inline Screen Vision Snapshot Preview */}
            {screenPreviewUrl && (
              <div className="rounded-lg border border-blue-200 dark:border-blue-900/60 bg-slate-50 dark:bg-slate-950 p-2.5 space-y-2">
                <div className="flex items-center justify-between text-[11px] text-slate-600 dark:text-slate-300">
                  <span className="font-medium truncate">
                    Screen Frame Attached
                    {displayActiveWindow ? ` · ${displayActiveWindow}` : ''}
                  </span>
                  <button
                    type="button"
                    onClick={() => setScreenPreviewUrl(null)}
                    className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                    aria-label="Discard screen frame"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
                <img
                  src={screenPreviewUrl}
                  alt="Captured screen preview"
                  className="w-full h-32 object-cover rounded border border-slate-200 dark:border-slate-800"
                />
                <button
                  type="button"
                  onClick={() => {
                    const url = screenPreviewUrl;
                    setScreenPreviewUrl(null);
                    onAskRayWithContext(
                      `Analyze what is on my screen${displayActiveWindow ? ` (active window: "${displayActiveWindow}")` : ''} and suggest or execute the next step.`,
                      {
                        name: 'desktop-screen.png',
                        dataUrl: url,
                        mimeType: 'image/png',
                      }
                    );
                  }}
                  className="w-full py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-md"
                >
                  Analyze This Screen with RAY
                </button>
              </div>
            )}

            {/* Recent Conversation Preview */}
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 p-3 space-y-2.5 min-h-[112px] max-h-48 overflow-y-auto">
              {recentMessages.length === 0 ? (
                <div className="text-xs text-slate-500 dark:text-slate-400 space-y-2 py-1">
                  <p>No active messages yet. Try a quick OS or Brain command:</p>
                  <div className="flex flex-wrap gap-1.5">
                    {[
                      'List files on my Desktop and Downloads',
                      'Check my active screen window and help',
                      'Create a Brain note for today’s priorities',
                    ].map((starter) => (
                      <button
                        key={starter}
                        type="button"
                        onClick={() => onAskRay(starter)}
                        className="px-2.5 py-1 text-xs rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:border-blue-600 text-left"
                      >
                        {starter}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                recentMessages.map((m) => (
                  <div key={m.id} className="text-xs leading-relaxed">
                    <span className="font-semibold text-slate-900 dark:text-slate-100">
                      {m.role === 'user' ? `${userName}: ` : 'RAY: '}
                    </span>
                    <span className="text-slate-700 dark:text-slate-300 line-clamp-3">
                      {m.text || '...'}
                    </span>
                  </div>
                ))
              )}
            </div>

            <form onSubmit={handleQuickPromptSubmit} className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void handleSnapScreenInline()}
                title="Capture live screen frame"
                className="p-2 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-600 dark:text-slate-300 hover:border-blue-600 shrink-0"
              >
                <Camera className="w-4 h-4" />
              </button>
              <input
                type="text"
                value={quickPrompt}
                onChange={(e) => setQuickPrompt(e.target.value)}
                placeholder={`Ask RAY (${assistantMode} · ${engineSettings.provider})...`}
                className="flex-1 min-w-0 px-3 py-2 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100 focus:outline-none focus:border-blue-600"
              />
              <button
                type="submit"
                aria-label="Send to RAY"
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg shrink-0"
              >
                <Send className="w-3.5 h-3.5" />
                <span>Send</span>
              </button>
            </form>

            <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
              <span>Includes Screen Vision, Files &amp; Second Brain tools</span>
              <button
                type="button"
                onClick={() => onSelectTab('assistant')}
                className="inline-flex items-center gap-1 font-medium text-blue-600 dark:text-blue-400 hover:underline"
              >
                <span>Full Console</span>
                <ArrowRight className="w-3 h-3" />
              </button>
            </div>
          </section>

          {/* Obsidian Second Brain Summary */}
          <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 sm:p-5 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Brain className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Second Brain ({notes.length})
                </h2>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setQuickNoteOpen((v) => !v)}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium border border-slate-200 dark:border-slate-700 rounded-md text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  <Plus className="w-3 h-3" />
                  <span>Quick Note</span>
                </button>
                <button
                  type="button"
                  onClick={() => onSelectTab('brain')}
                  className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline whitespace-nowrap"
                >
                  Open Vault
                </button>
              </div>
            </div>

            {quickNoteOpen && (
              <form onSubmit={handleCreateQuickNote} className="flex items-center gap-2">
                <input
                  type="text"
                  value={quickNoteTitle}
                  onChange={(e) => setQuickNoteTitle(e.target.value)}
                  placeholder="New note title..."
                  className="flex-1 min-w-0 px-3 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100"
                />
                <button
                  type="submit"
                  className="px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 shrink-0"
                >
                  Save
                </button>
              </form>
            )}

            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {recentNotes.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => onSelectTab('brain')}
                  className="w-full py-2 text-left flex items-center justify-between gap-3 hover:bg-slate-50 dark:hover:bg-slate-800/40 px-1.5 rounded transition-colors"
                >
                  <div className="min-w-0 flex items-center gap-2">
                    <FolderOpen className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    <span className="text-xs font-medium text-slate-900 dark:text-slate-100 truncate">
                      {n.title}
                    </span>
                  </div>
                  <span className="text-[11px] text-slate-500 dark:text-slate-400 shrink-0 tabular-nums">
                    {n.folder} · {new Date(n.updatedAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                  </span>
                </button>
              ))}
            </div>
          </section>
        </div>

        {/* Column 2 (4 cols): Live OS Files Quick Explorer + Apps Launcher (+ Add App) */}
        <div className="xl:col-span-4 space-y-5">
          {/* Live OS Files Quick Explorer */}
          <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 sm:p-5 space-y-3.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <HardDrive className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                  OS Files &amp; Folders
                </h2>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void checkBridgeNow()}
                  disabled={checkingBridge}
                  className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-900 dark:hover:text-slate-100"
                >
                  <RefreshCw className={`w-3 h-3 ${checkingBridge || fsLoading ? 'animate-spin' : ''}`} />
                  <span>Sync</span>
                </button>
                <button
                  type="button"
                  onClick={() => onSelectTab('files')}
                  className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline whitespace-nowrap"
                >
                  Full Explorer
                </button>
              </div>
            </div>

            {fsRoots.length > 0 ? (
              <>
                <div className="flex flex-wrap items-center gap-1.5">
                  {fsRoots.map((root) => (
                    <button
                      key={root.id}
                      type="button"
                      onClick={() => void loadQuickDirectory(root.path)}
                      className={`px-2.5 py-1 text-[11px] font-medium rounded-md border transition-colors ${
                        fsPath === root.path || fsPath.startsWith(root.path)
                          ? 'border-blue-600 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300'
                          : 'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                      }`}
                    >
                      {root.label}
                    </button>
                  ))}
                  {fsParent && fsPath && (
                    <button
                      type="button"
                      onClick={() => void loadQuickDirectory(fsParent)}
                      className="p-1 border border-slate-200 dark:border-slate-700 rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
                      title="Parent directory"
                    >
                      <FolderUp className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                {fsPath && (
                  <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400 truncate">
                    {fsPath}
                  </div>
                )}

                <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-56 overflow-y-auto">
                  {fsEntries.length === 0 ? (
                    <p className="text-xs text-slate-500 py-3">Folder is empty.</p>
                  ) : (
                    fsEntries.slice(0, 7).map((entry) => (
                      <button
                        key={entry.path}
                        type="button"
                        onClick={() => void handleQuickOpenFileToRay(entry)}
                        className="w-full py-2 px-1.5 text-left flex items-center justify-between gap-2 hover:bg-slate-50 dark:hover:bg-slate-800/40 rounded transition-colors"
                      >
                        <span className="inline-flex items-center gap-2 min-w-0 text-xs text-slate-800 dark:text-slate-200">
                          {entry.kind === 'dir' ? (
                            <Folder className="w-3.5 h-3.5 text-blue-600 shrink-0" />
                          ) : (
                            <FileCode2 className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                          )}
                          <span className="truncate">{entry.name}</span>
                        </span>
                        <span className="text-[10px] font-mono text-slate-400 shrink-0 tabular-nums">
                          {entry.kind === 'dir' ? 'OPEN' : formatBytes(entry.sizeBytes)}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </>
            ) : (
              <div className="rounded-lg border border-dashed border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/60 p-3.5 space-y-2.5 text-xs">
                <p className="text-slate-600 dark:text-slate-300 leading-relaxed">
                  Give RAY instant read/search access to your <strong>Desktop, Documents, Downloads, and Vault</strong> via the Desktop OS Bridge, or mount any folder directly in your browser.
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => onSelectTab('files')}
                    className="px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-md"
                  >
                    Mount Browser Folder
                  </button>
                  <button
                    type="button"
                    onClick={onOpenPairModal}
                    className="px-3 py-1.5 text-xs font-medium border border-slate-300 dark:border-slate-700 rounded-md text-slate-700 dark:text-slate-200 hover:border-blue-600"
                  >
                    Setup OS Bridge
                  </button>
                </div>
              </div>
            )}

            {fsNotice && (
              <p className="text-[11px] text-amber-700 dark:text-amber-400">{fsNotice}</p>
            )}
          </section>

          {/* Apps & Quick Launcher (+ Add New App) */}
          <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 sm:p-5 space-y-3.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Blocks className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Apps &amp; Integrations
                </h2>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setAddAppOpen((v) => !v)}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-md"
                >
                  <Plus className="w-3 h-3" />
                  <span>Add App</span>
                </button>
                <button
                  type="button"
                  onClick={() => onSelectTab('apps')}
                  className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline"
                >
                  All Apps
                </button>
              </div>
            </div>

            {addAppOpen && (
              <form
                onSubmit={handleAddCustomApp}
                className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-3 space-y-2.5"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                    Connect New App to RAY
                  </span>
                  <button
                    type="button"
                    onClick={() => setAddAppOpen(false)}
                    className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
                <input
                  type="text"
                  required
                  value={newAppName}
                  onChange={(e) => setNewAppName(e.target.value)}
                  placeholder="App name (e.g., Spotify, Discord, Figma, Linear)"
                  className="w-full px-2.5 py-1.5 text-xs bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md text-slate-900 dark:text-slate-100"
                />
                <div className="grid grid-cols-2 gap-2">
                  <select
                    value={newAppType}
                    onChange={(e) => setNewAppType(e.target.value as AppConnectorType)}
                    className="px-2 py-1.5 text-xs bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md text-slate-900 dark:text-slate-100"
                  >
                    <option value="url_template">Web URL / Deep Link</option>
                    <option value="bridge_app">Desktop App (Bridge)</option>
                    <option value="webhook">REST API / Webhook</option>
                  </select>
                  <select
                    value={newAppCategory}
                    onChange={(e) => setNewAppCategory(e.target.value as AppConnectorCategory)}
                    className="px-2 py-1.5 text-xs bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md text-slate-900 dark:text-slate-100"
                  >
                    <option value="automation">Automation</option>
                    <option value="browser">Browser</option>
                    <option value="notes">Notes / Docs</option>
                    <option value="social">Social / Chat</option>
                    <option value="custom">Custom</option>
                  </select>
                </div>
                <input
                  type="text"
                  required
                  value={newAppTarget}
                  onChange={(e) => setNewAppTarget(e.target.value)}
                  placeholder={
                    newAppType === 'bridge_app'
                      ? 'App exe/name (e.g., Spotify, code, obs64)'
                      : 'https://... or deep link (e.g., spotify://)'
                  }
                  className="w-full px-2.5 py-1.5 text-xs font-mono bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md text-slate-900 dark:text-slate-100"
                />
                <button
                  type="submit"
                  className="w-full py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-md"
                >
                  Save &amp; Enable App
                </button>
              </form>
            )}

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {builtInQuickApps.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  onClick={item.action}
                  className="px-2.5 py-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/50 hover:border-blue-600 text-xs font-medium text-slate-800 dark:text-slate-200 flex items-center justify-between gap-1.5 transition-colors"
                >
                  <span className="truncate">{item.label}</span>
                  <Globe className="w-3 h-3 text-slate-400 shrink-0" />
                </button>
              ))}
              {connectors
                .filter((c) => c.enabled)
                .slice(0, 6)
                .map((conn) => (
                  <button
                    key={conn.id}
                    type="button"
                    onClick={() => void handleLaunchApp(conn)}
                    className="px-2.5 py-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/50 hover:border-blue-600 text-xs font-medium text-slate-800 dark:text-slate-200 flex items-center justify-between gap-1.5 transition-colors"
                  >
                    <span className="truncate">{conn.name}</span>
                    <ExternalLink className="w-3 h-3 text-blue-600 dark:text-blue-400 shrink-0" />
                  </button>
                ))}
            </div>

            {appNotice && (
              <p className="text-[11px] text-emerald-700 dark:text-emerald-400">{appNotice}</p>
            )}
          </section>
        </div>

        {/* Column 3 (3 cols): Tasks & Focus Timers + Security & Protocols */}
        <div className="xl:col-span-3 space-y-5">
          {/* Tasks & Focus Timers */}
          <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 sm:p-5 space-y-3.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Calendar className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Tasks &amp; Focus
                </h2>
              </div>
              <button
                type="button"
                onClick={() => onCreateTimer('Focus Sprint', 25 * 60, 'all')}
                className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium border border-slate-200 dark:border-slate-700 rounded text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <Timer className="w-3 h-3" />
                <span>25m Focus</span>
              </button>
            </div>

            <form onSubmit={handleAddTaskSubmit} className="flex items-center gap-1.5">
              <input
                type="text"
                value={newTaskInput}
                onChange={(e) => setNewTaskInput(e.target.value)}
                placeholder="Add task..."
                className="flex-1 min-w-0 px-2.5 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100"
              />
              <button
                type="submit"
                aria-label="Add task"
                className="px-2.5 py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg shrink-0"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            </form>

            {openTasks.length === 0 ? (
              <p className="text-xs text-slate-500 dark:text-slate-400 py-1">
                No pending tasks. Add one above or ask RAY to plan your day.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {openTasks.map((task) => (
                  <li key={task.id}>
                    <button
                      type="button"
                      onClick={() => onToggleTask(task.id)}
                      className="w-full text-left flex items-start gap-2 py-1 px-1.5 rounded hover:bg-slate-50 dark:hover:bg-slate-800/50 text-xs text-slate-800 dark:text-slate-200"
                    >
                      <span className="mt-0.5 w-3.5 h-3.5 rounded border border-slate-300 dark:border-slate-600 flex items-center justify-center shrink-0">
                        {task.completed && <Check className="w-2.5 h-2.5 text-blue-600" />}
                      </span>
                      <span className="truncate">{task.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {timers.length > 0 && (
              <div className="pt-2 border-t border-slate-100 dark:border-slate-800 space-y-1.5">
                {timers.slice(0, 2).map((t) => (
                  <div key={t.id} className="flex items-center justify-between text-xs tabular-nums">
                    <span className="inline-flex items-center gap-1.5 text-slate-600 dark:text-slate-300 truncate">
                      <Clock className="w-3 h-3 text-blue-600 dark:text-blue-400 shrink-0" />
                      <span className="truncate">{t.label}</span>
                    </span>
                    <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">
                      {formatRemaining(t.endsAt, now.getTime())}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Zero-Trust Guardrails & Protocols */}
          <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 sm:p-5 space-y-3.5">
            <div className="flex items-center gap-2">
              <Shield className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
              <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                Security &amp; Protocols
              </h2>
            </div>

            <div className="space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-slate-600 dark:text-slate-400">Room Token Auth</span>
                <span className="inline-flex items-center gap-1 font-medium text-emerald-700 dark:text-emerald-400">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>Protected</span>
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-600 dark:text-slate-400">FS Secret Shield</span>
                <span className="inline-flex items-center gap-1 font-medium text-emerald-700 dark:text-emerald-400">
                  <Lock className="w-3 h-3" />
                  <span>Active</span>
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-600 dark:text-slate-400">Screen Control</span>
                <button
                  type="button"
                  onClick={() => void onToggleScreenControlArmed()}
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded font-medium border ${
                    screenControlArmed
                      ? 'border-amber-500 text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40'
                      : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'
                  }`}
                >
                  {screenControlArmed ? (
                    <ShieldAlert className="w-3 h-3" />
                  ) : (
                    <ShieldCheck className="w-3 h-3" />
                  )}
                  <span>{screenControlArmed ? 'Armed' : 'Safe'}</span>
                </button>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-600 dark:text-slate-400">Google Workspace</span>
                <button
                  type="button"
                  onClick={() => void onConnectGoogleWorkspace()}
                  className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline"
                >
                  {googleAuthorized ? 'Authorized' : 'Authorize'}
                </button>
              </div>
            </div>

            <div className="pt-2 border-t border-slate-100 dark:border-slate-800 grid grid-cols-2 gap-1.5">
              {(
                [
                  { key: 'house_party', label: 'House Party' },
                  { key: 'sentry_mode', label: 'Sentry Scan' },
                  { key: 'veronica', label: 'Veronica' },
                  { key: 'clean_slate', label: 'Clean Slate' },
                ] as const
              ).map((p) => (
                <button
                  key={p.key}
                  type="button"
                  disabled={runningProto !== null}
                  onClick={async () => {
                    setRunningProto(p.key);
                    try {
                      await onRunProtocol(p.key);
                    } finally {
                      setRunningProto(null);
                    }
                  }}
                  className="px-2.5 py-1.5 text-[11px] font-medium rounded-md border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:border-blue-600 text-left truncate"
                >
                  {p.label}
                </button>
              ))}
              <button
                type="button"
                onClick={onEmergencyStop}
                className="col-span-2 px-2.5 py-1.5 text-[11px] font-semibold rounded-md border border-red-300 dark:border-red-800 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/40 inline-flex items-center justify-center gap-1"
              >
                <OctagonX className="w-3 h-3 shrink-0" />
                <span>Stop All Active Execution</span>
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};
