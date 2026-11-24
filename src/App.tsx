import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Blocks, Bot, Brain, Cable, Orbit, ClipboardList, ExternalLink, FolderOpen, Home, Layers, LayoutGrid, Mic, MonitorSmartphone, Sparkles, X } from 'lucide-react';
import { TopBar } from './components/TopBar';
import type { ActiveTab } from './components/TopBar';
import { Sidebar } from './components/Sidebar';
import { DashboardView } from './components/DashboardView';
import { AssistantView } from './components/AssistantView';
import { SecondBrainView } from './components/SecondBrainView';
import { FilesSystemView } from './components/FilesSystemView';
import { AppsConnectorsView } from './components/AppsConnectorsView';
import { DevicesView } from './components/DevicesView';
import { RoutinesView } from './components/RoutinesView';
import { HandoffView } from './components/HandoffView';
import { ConnectionsView } from './components/ConnectionsView';
import { Brain3DView } from './components/Brain3DView';
import { usePushWake } from './hooks/usePushWake';
import { usePWAInstall } from './hooks/usePWAInstall';
import { useDeviceCall } from './hooks/useDeviceCall';
import { CallScreen } from './components/CallScreen';
import { AgentRunPanel } from './components/AgentRunPanel';
import { VoiceRouting } from './components/VoiceRouting';
import { AskCard } from './components/AskCard';
import { useFloatingRay } from './components/FloatingRay';
import { JarvisView } from './components/JarvisView';
import { PairDeviceModal } from './components/PairDeviceModal';
import { CameraModal } from './components/CameraModal';
import { IncomingCommandBar } from './components/IncomingCommandBar';
import { OfflineIndicator } from './components/OfflineIndicator';
import { useRelaySocket } from './hooks/useRelaySocket';
import type { SnapshotReceivedEvent } from './hooks/useRelaySocket';
import { useJarvisVoice } from './hooks/useJarvisVoice';
import { useScreenShare } from './hooks/useScreenShare';
import { useLocalBridgeMonitor } from './hooks/useLocalBridgeMonitor';
import { useFirebase } from './contexts/FirebaseContext';
import { playHudSound } from './utils/hudAudio';
import { authFetch } from './utils/roomAuth';
import type {
  AppConnector,
  BrainNote,
  ChatAttachment,
  ChatMessage,
  ConfirmationRequest,
  EngineSettings,
  ProtocolName,
  SharedTask,
  TaskAnalysisResult,
  VoicePersona,
} from './types/relay';

function getInitialRoomId(): string {
  if (typeof window === 'undefined') return 'RLY-HOME';
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get('room');
  if (fromUrl) {
    const normalized = fromUrl.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
    if (normalized.length >= 3) {
      localStorage.setItem('relay_room_id', normalized);
      return normalized;
    }
  }
  return localStorage.getItem('relay_room_id') || 'RLY-HOME';
}

const VALID_VOICES: VoicePersona[] = ['Kore', 'Puck', 'Charon', 'Fenrir', 'Zephyr'];

const DEFAULT_ENGINE_SETTINGS: EngineSettings = {
  provider: 'auto',
  routerMode: 'auto',
  settingsVersion: 2,
  ollamaUrl: 'http://127.0.0.1:11434',
  ollamaModel: 'llama3.2',
  openrouterModel: 'nvidia/nemotron-3.5-lightning:free',
  groqModel: 'openai/gpt-oss-120b',
  anthropicModel: 'claude-3-5-sonnet-20241022',
  openaiModel: 'gpt-4o',
  hfModel: 'meta-llama/Meta-Llama-3-8B-Instruct',
  useBridgeProxy: false,
  tokenUsage: {
    usedTokens: 14250,
    limitTokens: 100000,
    renewalDate: '2026-12-01',
    costOptimized: true,
  },
};

function loadInitialEngineSettings(): EngineSettings {
  if (typeof window === 'undefined') return DEFAULT_ENGINE_SETTINGS;
  try {
    const raw = localStorage.getItem('jarvis_engine_settings');
    if (!raw) return DEFAULT_ENGINE_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<EngineSettings>;
    const validProviders = ['auto', 'gemini', 'openrouter', 'ollama', 'groq', 'anthropic', 'openai', 'huggingface'];
    // v2 migration: old installs defaulted to Gemini-only; move them onto the free auto-router once.
    const migrated = (parsed.settingsVersion || 1) < 2 && (parsed.provider === 'gemini' || !parsed.provider);
    const provider = migrated
      ? 'auto'
      : validProviders.includes(parsed.provider || '')
      ? (parsed.provider as EngineSettings['provider'])
      : 'auto';
    const rawOrModel =
      typeof parsed.openrouterModel === 'string' && parsed.openrouterModel.trim()
        ? parsed.openrouterModel.trim()
        : 'nvidia/nemotron-3.5-lightning:free';
    return {
      provider,
      routerMode: typeof parsed.routerMode === 'string' ? parsed.routerMode : 'auto',
      settingsVersion: 2,
      ollamaUrl: typeof parsed.ollamaUrl === 'string' && parsed.ollamaUrl.trim() ? parsed.ollamaUrl : 'http://127.0.0.1:11434',
      ollamaModel: typeof parsed.ollamaModel === 'string' && parsed.ollamaModel.trim() ? parsed.ollamaModel : 'llama3.2',
      openrouterModel:
        // openrouter/free stalled in testing (auto-router that can pick paid/image models).
        rawOrModel === 'meta-llama/llama-3.3-70b-instruct:free' || rawOrModel === 'openrouter/free'
          ? 'nvidia/nemotron-3.5-lightning:free'
          : rawOrModel,
      groqModel:
        typeof parsed.groqModel === 'string' && parsed.groqModel.trim() && !/allam|safeguard|whisper|orpheus|guard/i.test(parsed.groqModel)
          ? parsed.groqModel
          : 'openai/gpt-oss-120b',
      anthropicModel: typeof parsed.anthropicModel === 'string' && parsed.anthropicModel.trim() ? parsed.anthropicModel : 'claude-3-5-sonnet-20241022',
      openaiModel: typeof parsed.openaiModel === 'string' && parsed.openaiModel.trim() ? parsed.openaiModel : 'gpt-4o',
      hfModel: typeof parsed.hfModel === 'string' && parsed.hfModel.trim() ? parsed.hfModel : 'meta-llama/Meta-Llama-3-8B-Instruct',
      useBridgeProxy: Boolean(parsed.useBridgeProxy),
      tokenUsage: parsed.tokenUsage || DEFAULT_ENGINE_SETTINGS.tokenUsage,
    };
  } catch {
    return DEFAULT_ENGINE_SETTINGS;
  }
}

export default function App() {
  const [roomId, setRoomId] = useState<string>(getInitialRoomId);
  // Opened from the pairing QR (…&connect=1) → go straight to the one-tap connect screen.
  // Pop-up mode (?popup=1): the compact RAY window opened by Ctrl+Alt+R, "Hey Ray" or another device.
  const [popupMode] = useState(() => typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('popup'));
  const [activeTab, setActiveTab] = useState<ActiveTab>(() => {
    if (typeof window === 'undefined') return 'dashboard';
    const q = new URLSearchParams(window.location.search);
    return q.has('popup') ? 'assistant' : q.has('connect') ? 'connect' : 'dashboard';
  });
  // Distinct window titles let the PC bridge find these windows and raise them above other apps.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const t = q.has('answer') ? 'RAY Call' : q.has('popup') ? 'RAY Assistant' : '';
    if (!t) return;
    document.title = t;
    const keep = window.setInterval(() => {
      if (document.title !== t) document.title = t;
    }, 1500);
    return () => window.clearInterval(keep);
  }, []);
  const [pairModalOpen, setPairModalOpen] = useState(false);
  const [manualCameraOpen, setManualCameraOpen] = useState(false);
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('relay_theme') === 'dark';
  });

  const [voice, setVoice] = useState<VoicePersona>(() => {
    if (typeof window === 'undefined') return 'Fenrir';
    const saved = localStorage.getItem('jarvis_voice') as VoicePersona | null;
    return saved && VALID_VOICES.includes(saved) ? saved : 'Fenrir';
  });
  const [wakeEnabled, setWakeEnabled] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('jarvis_wake') === 'true';
  });
  const [wakeSensitivity, setWakeSensitivity] = useState<number>(() => {
    if (typeof window === 'undefined') return 0.75;
    const num = Number(localStorage.getItem('jarvis_wake_sensitivity'));
    return Number.isFinite(num) && num >= 0.3 && num <= 1 ? num : 0.75;
  });

  const [engineSettings, setEngineSettings] = useState<EngineSettings>(loadInitialEngineSettings);
  // Strictly in-memory Notion integration token (never stored in localStorage/sessionStorage/Firestore)
  const [notionToken, setNotionToken] = useState<string>('');

  useEffect(() => {
    try {
      localStorage.setItem('jarvis_engine_settings', JSON.stringify(engineSettings));
    } catch {
      // Ignore storage quota errors
    }
  }, [engineSettings]);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [localAnalyses, setLocalAnalyses] = useState<TaskAnalysisResult[]>([]);
  const [pendingConfirmations, setPendingConfirmations] = useState<ConfirmationRequest[]>([]);
  const [targetDeviceHint, setTargetDeviceHint] = useState('auto');
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([]);
  const [draftPrompt, setDraftPrompt] = useState<string>('');

  const {
    user,
    authReady,
    profileReady,
    authError,
    googleAccessToken,
    userProfile,
    cloudTasks,
    cloudAnalyses,
    cloudRoutines,
    cloudMessages,
    cloudHandoffs,
    cloudBrainNotes,
    cloudConnectors,
    signInWithGoogle,
    connectGoogleWorkspace,
    signOutUser,
    updatePreferences,
    saveTaskToCloud,
    toggleTaskInCloud,
    deleteTaskFromCloud,
    saveAnalysisToCloud,
    deleteAnalysisFromCloud,
    saveRoutineToCloud,
    deleteRoutineFromCloud,
    saveMessageToCloud,
    updateMessageInCloud,
    clearMessagesInCloud,
    saveHandoffToCloud,
    deleteHandoffFromCloud,
    saveBrainNoteToCloud,
    deleteBrainNoteFromCloud,
    saveConnectorToCloud,
    deleteConnectorFromCloud,
  } = useFirebase();

  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) {
      root.classList.add('dark');
      localStorage.setItem('relay_theme', 'dark');
    } else {
      root.classList.remove('dark');
      localStorage.setItem('relay_theme', 'light');
    }
  }, [darkMode]);

  // Global keyboard shortcuts (Alt+H/R/B/F/A)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const key = e.key.toLowerCase();
      if (key === 'h') {
        e.preventDefault();
        setActiveTab('dashboard');
      } else if (key === 'r') {
        e.preventDefault();
        setActiveTab('assistant');
      } else if (key === 'b') {
        e.preventDefault();
        setActiveTab('brain');
      } else if (key === 'f') {
        e.preventDefault();
        setActiveTab('files');
      } else if (key === 'a') {
        e.preventDefault();
        setActiveTab('apps');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Hydrate preferences from Firestore userProfile when available
  useEffect(() => {
    if (!userProfile) return;
    if (VALID_VOICES.includes(userProfile.preferredVoice)) {
      setVoice(userProfile.preferredVoice);
      localStorage.setItem('jarvis_voice', userProfile.preferredVoice);
    }
    setWakeEnabled(Boolean(userProfile.wakeEnabled));
    localStorage.setItem('jarvis_wake', String(Boolean(userProfile.wakeEnabled)));
    if (typeof userProfile.wakeSensitivity === 'number') {
      const clamped = Math.max(0.3, Math.min(1, userProfile.wakeSensitivity));
      setWakeSensitivity(clamped);
      localStorage.setItem('jarvis_wake_sensitivity', String(clamped));
    }
  }, [userProfile]);

  const handleSnapshotReceived = useCallback((evt: SnapshotReceivedEvent) => {
    setPendingAttachments((prev) => [
      ...prev,
      {
        id: `snap-${Date.now()}`,
        name: `${evt.deviceName} snapshot.jpg`,
        mimeType: 'image/jpeg',
        dataUrl: evt.dataUrl,
      },
    ]);
  }, []);

  const [localBridgeOnline, setLocalBridgeOnline] = useState(false);

  const {
    identity,
    status,
    roomToken,
    roomAuthError,
    applyManualRoomToken,
    snapshot,
    incomingActions,
    dismissAction,
    pendingSnapshotRequest,
    clearSnapshotRequest,
    submitSnapshot,
    renameDevice,
    removeDevice,
    shareLocationTelemetry,
    createTask,
    toggleTask,
    deleteTask,
    pushHandoff,
    deleteHandoff,
    createTimer,
    cancelTimer,
    deleteRoutine,
    sendEvent,
  } = useRelaySocket(roomId, handleSnapshotReceived, localBridgeOnline);

  const bridgeMonitor = useLocalBridgeMonitor(roomId, engineSettings.ollamaUrl, roomToken);
  useEffect(() => {
    setLocalBridgeOnline(bridgeMonitor.status === 'connected');
  }, [bridgeMonitor.status]);

  const screenShare = useScreenShare();
  const pushWake = usePushWake(roomId, identity.id);
  const pwa = usePWAInstall();
  const deviceCall = useDeviceCall({
    roomId,
    myDeviceId: identity.id,
    myName: identity.name,
    sendEvent,
    onAnswerRayCall: (message) => {
      // Answering RAY's call opens a voice conversation that starts with what RAY called to say.
      void startLiveSession(
        message
          ? `(You just phoned me, Ray, and I answered. Tell me this now, briefly and naturally: "${message}". Then ask if I need anything else.)`
          : '(You just phoned me, Ray, and I answered. Greet me and ask what I need.)'
      );
    },
  });
  const [moreNavOpen, setMoreNavOpen] = useState(false);
  const [brainFocusNoteId, setBrainFocusNoteId] = useState<string | null>(null);

  const handleAddConfirmation = useCallback((req: ConfirmationRequest) => {
    setPendingConfirmations((prev) => {
      if (prev.some((p) => p.id === req.id)) return prev;
      return [...prev, req];
    });
    playHudSound('alert');
  }, []);

  // Shared mic: where spoken commands run (saved), and a one-session override from a pop-up link
  // (?runon=) or from another device asking this one to listen.
  const [voiceRunOn, setVoiceRunOn] = useState<string>(() => {
    try {
      return localStorage.getItem('ray.voiceRunOn') || '';
    } catch {
      return '';
    }
  });
  const [sessionRunOn, setSessionRunOn] = useState<string>(() =>
    typeof window === 'undefined' ? '' : new URLSearchParams(window.location.search).get('runon') || ''
  );
  const changeVoiceRunOn = useCallback((v: string) => {
    setVoiceRunOn(v);
    try {
      localStorage.setItem('ray.voiceRunOn', v);
    } catch {
      // private mode
    }
  }, []);

  const {
    voiceState,
    userCaption,
    jarvisCaption,
    liveError,
    wakeSupported,
    startLiveSession,
    stopLiveSession,
    emergencyStop,
    pipeline: voicePipeline,
  } = useJarvisVoice({
    roomId,
    deviceName: identity.name,
    voiceName: voice,
    wakeEnabled,
    wakeSensitivity,
    googleAccessToken,
    notionToken,
    onConfirmationRequired: handleAddConfirmation,
    engineSettings,
    runOn: sessionRunOn || voiceRunOn,
  });

  // "Display over other apps" on PCs: a small RAY window that stays on top of everything.
  const floating = useFloatingRay({
    roomId,
    deviceName: identity.name,
    voiceState,
    userCaption,
    jarvisCaption,
    onMic: () => (voiceState === 'off' || voiceState === 'standby' ? void startLiveSession() : stopLiveSession(true)),
  });
  useEffect(() => {
    const onFloat = () => void floating.open();
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        void floating.open();
      }
    };
    window.addEventListener('ray:float', onFloat);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('ray:float', onFloat);
      window.removeEventListener('keydown', onKey);
    };
  }, [floating.open]);

  useEffect(() => {
    const onRemote = (e: Event) => {
      const runOn = String((e as CustomEvent<{ runOn?: string }>).detail?.runOn || '');
      setSessionRunOn(runOn);
      if (voiceState === 'off' || voiceState === 'standby') void startLiveSession();
    };
    window.addEventListener('ray:remote-listen', onRemote);
    return () => window.removeEventListener('ray:remote-listen', onRemote);
  }, [voiceState, startLiveSession]);

  // A remote-mic session ends when the conversation does.
  const prevVoiceState = useRef(voiceState);
  useEffect(() => {
    if (prevVoiceState.current !== 'off' && prevVoiceState.current !== 'standby' && (voiceState === 'off' || voiceState === 'standby')) setSessionRunOn('');
    prevVoiceState.current = voiceState;
  }, [voiceState]);

  // Pop-up window opened with listen=1 (Ctrl+Alt+R, wake from another device): start listening at once.
  useEffect(() => {
    if (!popupMode || !new URLSearchParams(window.location.search).has('listen')) return;
    const t = window.setTimeout(() => {
      if (voiceState === 'off') void startLiveSession();
    }, 900);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [popupMode]);

  // Track snapshot items & deleted items so Gemini tool creations sync to Firestore without resurrecting deletes
  const knownSnapshotIdsRef = useRef<Set<string>>(new Set());
  const deletedCloudKeysRef = useRef<Set<string>>(new Set());
  const cloudEnabled = Boolean(user && profileReady);

  // Sync cloudMessages into Assistant message state when signed in
  const prevCloudCountRef = useRef(0);
  useEffect(() => {
    if (!cloudEnabled) {
      prevCloudCountRef.current = 0;
      return;
    }
    if (cloudMessages.length === 0 && prevCloudCountRef.current === 0) return;
    prevCloudCountRef.current = cloudMessages.length;
    setMessages((prev) => {
      const cloudMap = new Map(cloudMessages.map((m) => [m.id, m]));
      const merged: ChatMessage[] = cloudMessages.map((cm) => {
        const localMatch = prev.find((lm) => lm.id === cm.id);
        return localMatch?.attachments?.length
          ? { ...cm, attachments: localMatch.attachments }
          : cm;
      });
      for (const lm of prev) {
        if (!cloudMap.has(lm.id)) {
          merged.push(lm);
        }
      }
      return merged.sort((a, b) => a.createdAt - b.createdAt);
    });
  }, [cloudEnabled, cloudMessages]);

  // Auto-persist newly created server-side Gemini tasks, routines, handoffs, and Second Brain notes to Firestore
  useEffect(() => {
    if (!cloudEnabled) return;
    for (const t of snapshot.tasks) {
      const key = `task:${t.id}`;
      if (!knownSnapshotIdsRef.current.has(key)) {
        knownSnapshotIdsRef.current.add(key);
        if (!deletedCloudKeysRef.current.has(key) && !cloudTasks.some((ct) => ct.id === t.id)) {
          void saveTaskToCloud(t);
        }
      }
    }
    for (const r of snapshot.routines) {
      const key = `routine:${r.id}`;
      if (!knownSnapshotIdsRef.current.has(key)) {
        knownSnapshotIdsRef.current.add(key);
        if (!deletedCloudKeysRef.current.has(key) && !cloudRoutines.some((cr) => cr.id === r.id)) {
          void saveRoutineToCloud(r);
        }
      }
    }
    for (const h of snapshot.handoffs) {
      const key = `handoff:${h.id}`;
      if (!knownSnapshotIdsRef.current.has(key)) {
        knownSnapshotIdsRef.current.add(key);
        if (!deletedCloudKeysRef.current.has(key) && !cloudHandoffs.some((ch) => ch.id === h.id)) {
          void saveHandoffToCloud(h);
        }
      }
    }
    for (const b of snapshot.brainNotes || []) {
      const key = `brain:${b.id}:${b.updatedAt}`;
      if (!knownSnapshotIdsRef.current.has(key)) {
        knownSnapshotIdsRef.current.add(key);
        if (!deletedCloudKeysRef.current.has(`brain:${b.id}`)) {
          const existing = cloudBrainNotes.find((cb) => cb.id === b.id);
          if (!existing || b.updatedAt > existing.updatedAt) {
            void saveBrainNoteToCloud(b);
          }
        }
      }
    }
  }, [
    cloudEnabled,
    snapshot.tasks,
    snapshot.routines,
    snapshot.handoffs,
    snapshot.brainNotes,
    cloudTasks,
    cloudRoutines,
    cloudHandoffs,
    cloudBrainNotes,
    saveTaskToCloud,
    saveRoutineToCloud,
    saveHandoffToCloud,
    saveBrainNoteToCloud,
  ]);

  const effectiveTasks = useMemo(
    () => (cloudEnabled ? cloudTasks : snapshot.tasks),
    [cloudEnabled, cloudTasks, snapshot.tasks]
  );

  const effectiveRoutines = useMemo(
    () => (cloudEnabled ? cloudRoutines : snapshot.routines),
    [cloudEnabled, cloudRoutines, snapshot.routines]
  );

  const effectiveHandoffs = useMemo(
    () => (cloudEnabled ? cloudHandoffs : snapshot.handoffs),
    [cloudEnabled, cloudHandoffs, snapshot.handoffs]
  );

  const effectiveAnalyses = useMemo(
    () => (cloudEnabled ? cloudAnalyses : localAnalyses),
    [cloudEnabled, cloudAnalyses, localAnalyses]
  );

  const effectiveBrainNotes = useMemo(() => {
    const roomNotes = snapshot.brainNotes || [];
    if (!cloudEnabled) return roomNotes;
    const map = new Map<string, BrainNote>();
    for (const rn of roomNotes) {
      if (!deletedCloudKeysRef.current.has(`brain:${rn.id}`)) {
        map.set(rn.id, rn);
      }
    }
    for (const cn of cloudBrainNotes) {
      const existing = map.get(cn.id);
      if (!existing || cn.updatedAt >= existing.updatedAt) {
        map.set(cn.id, cn);
      }
    }
    return Array.from(map.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }, [cloudEnabled, cloudBrainNotes, snapshot.brainNotes]);

  const effectiveConnectors = useMemo(() => {
    const roomConns = snapshot.connectors || [];
    if (!cloudEnabled) return roomConns;
    const map = new Map<string, AppConnector>();
    for (const rc of roomConns) map.set(rc.id, rc);
    for (const cc of cloudConnectors) map.set(cc.id, cc);
    return Array.from(map.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }, [cloudEnabled, cloudConnectors, snapshot.connectors]);

  const hasBridgeOnline = useMemo(
    () =>
      bridgeMonitor.status === 'connected' ||
      snapshot.devices.some(
        (d) => d.online && (d.type === 'bridge' || d.capabilities.includes('os-bridge'))
      ),
    [bridgeMonitor.status, snapshot.devices]
  );

  const handleChangeVoice = useCallback(
    (nextVoice: VoicePersona) => {
      setVoice(nextVoice);
      localStorage.setItem('jarvis_voice', nextVoice);
      if (cloudEnabled) {
        void updatePreferences({ preferredVoice: nextVoice });
      }
    },
    [cloudEnabled, updatePreferences]
  );

  const handleToggleWake = useCallback(() => {
    setWakeEnabled((prev) => {
      const next = !prev;
      localStorage.setItem('jarvis_wake', String(next));
      if (cloudEnabled) {
        void updatePreferences({ wakeEnabled: next });
      }
      return next;
    });
  }, [cloudEnabled, updatePreferences]);

  const handleChangeWakeSensitivity = useCallback(
    (val: number) => {
      const clamped = Math.max(0.3, Math.min(1, val));
      setWakeSensitivity(clamped);
      localStorage.setItem('jarvis_wake_sensitivity', String(clamped));
      if (cloudEnabled) {
        void updatePreferences({ wakeSensitivity: clamped });
      }
    },
    [cloudEnabled, updatePreferences]
  );

  const handleCreateTask = useCallback(
    (
      title: string,
      assignedDevice = 'All Devices',
      meta?: Pick<SharedTask, 'category' | 'priority' | 'effortMinutes' | 'analysisId'>
    ) => {
      if (cloudEnabled) {
        const task: SharedTask = {
          id: `tsk-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          title,
          completed: false,
          assignedDevice,
          category: meta?.category || 'general',
          priority: meta?.priority || 'medium',
          effortMinutes: meta?.effortMinutes ?? 15,
          analysisId: meta?.analysisId,
          createdAt: Date.now(),
        };
        void saveTaskToCloud(task);
      } else {
        createTask(title, assignedDevice);
      }
    },
    [cloudEnabled, createTask, saveTaskToCloud]
  );

  const handleToggleTask = useCallback(
    (id: string) => {
      if (snapshot.tasks.some((t) => t.id === id)) {
        toggleTask(id);
      }
      if (cloudEnabled) {
        const target = cloudTasks.find((t) => t.id === id) || snapshot.tasks.find((t) => t.id === id);
        if (target) {
          void toggleTaskInCloud(id, !target.completed);
        }
      }
    },
    [cloudEnabled, cloudTasks, snapshot.tasks, toggleTask, toggleTaskInCloud]
  );

  const handleDeleteTask = useCallback(
    (id: string) => {
      deletedCloudKeysRef.current.add(`task:${id}`);
      deleteTask(id);
      if (cloudEnabled) {
        void deleteTaskFromCloud(id);
      }
    },
    [cloudEnabled, deleteTask, deleteTaskFromCloud]
  );

  const handlePushHandoff = useCallback(
    (params: {
      label: string;
      content: string;
      kind: 'text' | 'link' | 'code' | 'image';
      targetDevice: string;
    }) => {
      if (cloudEnabled) {
        void saveHandoffToCloud({
          id: `hof-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          label: params.label,
          content: params.content,
          kind: params.kind,
          sourceDevice: identity.name,
          targetDevice: params.targetDevice,
          createdAt: Date.now(),
        });
      } else {
        pushHandoff(params);
      }
    },
    [cloudEnabled, identity.name, pushHandoff, saveHandoffToCloud]
  );

  const handleDeleteHandoff = useCallback(
    (id: string) => {
      deletedCloudKeysRef.current.add(`handoff:${id}`);
      deleteHandoff(id);
      if (cloudEnabled) {
        void deleteHandoffFromCloud(id);
      }
    },
    [cloudEnabled, deleteHandoff, deleteHandoffFromCloud]
  );

  const handleDeleteRoutine = useCallback(
    (id: string) => {
      deletedCloudKeysRef.current.add(`routine:${id}`);
      deleteRoutine(id);
      if (cloudEnabled) {
        void deleteRoutineFromCloud(id);
      }
    },
    [cloudEnabled, deleteRoutine, deleteRoutineFromCloud]
  );

  const handleSaveAnalysis = useCallback(
    (analysis: TaskAnalysisResult) => {
      setLocalAnalyses((prev) => [analysis, ...prev.filter((a) => a.id !== analysis.id)].slice(0, 30));
      if (cloudEnabled) {
        void saveAnalysisToCloud(analysis);
      }
    },
    [cloudEnabled, saveAnalysisToCloud]
  );

  const handleDeleteAnalysis = useCallback(
    (id: string) => {
      setLocalAnalyses((prev) => prev.filter((a) => a.id !== id));
      if (cloudEnabled) {
        void deleteAnalysisFromCloud(id);
      }
    },
    [cloudEnabled, deleteAnalysisFromCloud]
  );

  const handlePersistMessage = useCallback(
    (msg: ChatMessage) => {
      if (cloudEnabled) {
        void saveMessageToCloud(roomId, msg);
      }
    },
    [cloudEnabled, roomId, saveMessageToCloud]
  );

  const handleUpdatePersistedMessage = useCallback(
    (msg: ChatMessage) => {
      if (cloudEnabled) {
        void updateMessageInCloud(msg.id, {
          text: msg.text,
          toolCalls: msg.toolCalls,
          sources: msg.sources,
        });
      }
    },
    [cloudEnabled, updateMessageInCloud]
  );

  const handleClearHistory = useCallback(() => {
    setMessages([]);
    if (cloudEnabled) {
      void clearMessagesInCloud();
    }
  }, [clearMessagesInCloud, cloudEnabled]);

  const handleSaveBrainNote = useCallback(
    async (note: BrainNote) => {
      deletedCloudKeysRef.current.delete(`brain:${note.id}`);
      await authFetch('/api/brain/notes', roomId, {
        method: 'POST',
        body: JSON.stringify({ roomId, note }),
      }).catch(() => {});
      if (cloudEnabled) {
        await saveBrainNoteToCloud(note);
      }
    },
    [cloudEnabled, roomId, saveBrainNoteToCloud]
  );

  const handleDeleteBrainNote = useCallback(
    async (noteId: string) => {
      deletedCloudKeysRef.current.add(`brain:${noteId}`);
      await authFetch(`/api/brain/notes/${encodeURIComponent(noteId)}?room=${encodeURIComponent(roomId)}`, roomId, {
        method: 'DELETE',
      }).catch(() => {});
      if (cloudEnabled) {
        await deleteBrainNoteFromCloud(noteId);
      }
    },
    [cloudEnabled, deleteBrainNoteFromCloud, roomId]
  );

  const handleSaveConnector = useCallback(
    async (connector: AppConnector) => {
      const res = await authFetch('/api/connectors', roomId, {
        method: 'POST',
        body: JSON.stringify({ roomId, connector }),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(errBody.error || 'Failed to save connector');
      }
      if (cloudEnabled) {
        await saveConnectorToCloud(connector);
      }
    },
    [cloudEnabled, roomId, saveConnectorToCloud]
  );

  const handleDeleteConnector = useCallback(
    async (connectorId: string) => {
      await authFetch(
        `/api/connectors/${encodeURIComponent(connectorId)}?room=${encodeURIComponent(roomId)}`,
        roomId,
        { method: 'DELETE' }
      ).catch(() => {});
      if (cloudEnabled) {
        await deleteConnectorFromCloud(connectorId);
      }
    },
    [cloudEnabled, deleteConnectorFromCloud, roomId]
  );

  const handleToggleScreenControlArmed = useCallback(async () => {
    const nextArmed = !Boolean(snapshot.screenControlArmed);
    await authFetch('/api/screen/arm', roomId, {
      method: 'POST',
      body: JSON.stringify({ roomId, armed: nextArmed }),
    }).catch(() => {});
    playHudSound(nextArmed ? 'affirmative' : 'blip');
  }, [roomId, snapshot.screenControlArmed]);

  const handleEmergencyStopAll = useCallback(async () => {
    screenShare.stopScreenShare();
    await Promise.allSettled([
      emergencyStop(),
      authFetch('/api/screen/arm', roomId, {
        method: 'POST',
        body: JSON.stringify({ roomId, armed: false }),
      }),
    ]);
  }, [emergencyStop, roomId, screenShare]);

  const handleRunProtocol = useCallback(
    async (protocol: ProtocolName) => {
      const res = await authFetch('/api/protocols/run', roomId, {
        method: 'POST',
        body: JSON.stringify({ roomId, protocol }),
      });
      const data = (await res.json().catch(() => ({}))) as { summary?: string };
      playHudSound('affirmative');
      if (data.summary) {
        const msg: ChatMessage = {
          id: `proto-${Date.now()}`,
          role: 'assistant',
          text: data.summary,
          createdAt: Date.now(),
        };
        setMessages((prev) => [...prev, msg]);
        if (cloudEnabled) {
          void saveMessageToCloud(roomId, msg);
        }
      }
    },
    [cloudEnabled, roomId, saveMessageToCloud]
  );

  const handleResolveConfirmation = useCallback(
    async (id: string, approved: boolean, secret?: string) => {
      setPendingConfirmations((prev) => prev.filter((c) => c.id !== id));
      try {
        const res = await authFetch(
          '/api/confirmations/resolve',
          roomId,
          {
            method: 'POST',
            body: JSON.stringify({
              roomId,
              confirmationId: id,
              approved,
              ...(approved && secret ? { secret } : {}),
              sourceDeviceName: identity.name,
              preferredVoice: voice,
              customConnectors: effectiveConnectors,
            }),
          },
          { googleAccessToken, notionToken }
        );
        const data = (await res.json()) as {
          summary?: string;
          speechResponse?: string;
          error?: string;
        };
        const text = data.speechResponse || data.summary || (approved ? 'Executed, Ray.' : 'Cancelled, Ray.');
        playHudSound(approved ? 'affirmative' : 'alert');
        const msg: ChatMessage = {
          id: `conf-${Date.now()}`,
          role: 'assistant',
          text,
          createdAt: Date.now(),
        };
        setMessages((prev) => [...prev, msg]);
        if (cloudEnabled) {
          void saveMessageToCloud(roomId, msg);
        }
      } catch (err) {
        const msg: ChatMessage = {
          id: `conf-err-${Date.now()}`,
          role: 'assistant',
          text: `Unable to resolve confirmation: ${err instanceof Error ? err.message : 'Request failed'}`,
          createdAt: Date.now(),
        };
        setMessages((prev) => [...prev, msg]);
      }
    },
    [cloudEnabled, effectiveConnectors, googleAccessToken, identity.name, notionToken, roomId, saveMessageToCloud, voice]
  );

  const handleChangeRoom = (nextRoom: string) => {
    const cleaned = nextRoom.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
    if (cleaned.length < 3) return;
    localStorage.setItem('relay_room_id', cleaned);
    const url = new URL(window.location.href);
    url.searchParams.set('room', cleaned);
    url.searchParams.delete('token');
    window.history.replaceState({}, '', url.toString());
    setRoomId(cleaned);
    setPairModalOpen(false);
  };

  const handleCameraCapture = (dataUrl: string) => {
    if (pendingSnapshotRequest) {
      submitSnapshot(dataUrl, pendingSnapshotRequest.commandId, pendingSnapshotRequest.reason);
    } else {
      setPendingAttachments((prev) => [
        ...prev,
        {
          id: `cam-${Date.now()}`,
          name: `camera-${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.jpg`,
          mimeType: 'image/jpeg',
          dataUrl,
        },
      ]);
      setManualCameraOpen(false);
    }
  };

  const handleAskRayWithContext = useCallback(
    (prompt: string, imageAttachment?: { name: string; dataUrl: string; mimeType: string }) => {
      if (imageAttachment) {
        setPendingAttachments((prev) => [
          ...prev,
          {
            id: `ctx-${Date.now()}`,
            name: imageAttachment.name,
            mimeType: imageAttachment.mimeType,
            dataUrl: imageAttachment.dataUrl,
          },
        ]);
      }
      setDraftPrompt(prompt);
      setActiveTab('assistant');
    },
    []
  );

  const cameraOpen = manualCameraOpen || Boolean(pendingSnapshotRequest);
  const showEmergencyStop =
    voiceState === 'connecting' ||
    voiceState === 'listening' ||
    voiceState === 'thinking' ||
    voiceState === 'speaking' ||
    voiceState === 'standby' ||
    screenShare.isSharing ||
    Boolean(snapshot.screenControlArmed);

  const displayName = userProfile?.displayName || user?.displayName || 'Ray';

  return (
    <div className="h-screen flex flex-col bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 overflow-hidden">
      {popupMode ? (
        <header className="h-12 shrink-0 flex items-center gap-2.5 px-3 border-b border-slate-200 dark:border-slate-800 bg-white/90 dark:bg-slate-900/90 backdrop-blur">
          <span className="relative w-7 h-7 rounded-full bg-gradient-to-br from-blue-500 to-violet-600 grid place-items-center shadow shadow-blue-600/30">
            <Bot className="w-4 h-4 text-white" />
          </span>
          <div className="min-w-0 leading-tight">
            <p className="text-sm font-semibold">RAY</p>
            <p className="text-[11px] text-slate-500 truncate">
              {voiceState === 'off' ? 'Ready — say “Hey Ray” or tap the mic' : voiceState === 'listening' ? 'Listening…' : voiceState === 'thinking' ? 'Thinking…' : voiceState === 'speaking' ? 'Speaking…' : 'Connecting…'}
            </p>
          </div>
          <button
            type="button"
            aria-label={voiceState === 'off' ? 'Start listening' : 'Stop listening'}
            onClick={() => (voiceState === 'off' ? void startLiveSession() : stopLiveSession(false))}
            className={`ml-auto w-9 h-9 rounded-full grid place-items-center transition-colors ${voiceState === 'off' ? 'bg-blue-600 text-white hover:bg-blue-500' : 'bg-rose-500 text-white animate-pulse'}`}
          >
            <Mic className="w-4 h-4" />
          </button>
          <a
            href={`/?room=${encodeURIComponent(roomId)}`}
            target="_blank"
            rel="noreferrer"
            aria-label="Open the full RAY app"
            className="w-9 h-9 rounded-full grid place-items-center text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <ExternalLink className="w-4 h-4" />
          </a>
        </header>
      ) : (
      <TopBar
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        onOpenPairModal={() => setPairModalOpen(true)}
        onEmergencyStop={() => void handleEmergencyStopAll()}
        showEmergencyStop={showEmergencyStop}
        onFloat={floating.supported ? () => void floating.open() : undefined}
        floating={floating.isOpen}
      />
      )}

      <OfflineIndicator />

      <div className="flex-1 flex min-h-0 overflow-hidden">
        {!popupMode && (
        <Sidebar
          activeTab={activeTab}
          onSelectTab={setActiveTab}
          onCallDevice={(id, name, video) => void deviceCall.callDevice(id, name, video)}
          roomId={roomId}
          socketStatus={status}
          devices={snapshot.devices}
          localDeviceId={identity.id}
          timers={snapshot.timers}
          darkMode={darkMode}
          onToggleDarkMode={() => setDarkMode((d) => !d)}
          onOpenPairModal={() => setPairModalOpen(true)}
          onSelectDeviceTarget={(deviceName) => {
            setTargetDeviceHint(deviceName);
            setActiveTab('assistant');
          }}
          onCancelTimer={cancelTimer}
          user={user}
          authReady={authReady}
          authError={authError}
          onSignIn={signInWithGoogle}
          onSignOut={async () => {
            setNotionToken('');
            await signOutUser();
            setMessages([]);
          }}
        />
        )}

        <main
          className={`flex-1 min-w-0 ${popupMode ? '' : 'pb-[calc(3.5rem+env(safe-area-inset-bottom))]'} md:pb-0 ${
            activeTab === 'assistant' || activeTab === 'brain' ? 'overflow-hidden' : 'overflow-y-auto'
          }`}
        >
          <div className="h-full">
            {activeTab === 'dashboard' && (
            <DashboardView
              roomId={roomId}
              roomToken={roomToken}
              bridgeMonitor={bridgeMonitor}
              userName={displayName}
              userPhotoUrl={user?.photoURL}
              devices={snapshot.devices}
              messages={messages}
              tasks={effectiveTasks}
              timers={snapshot.timers}
              notes={effectiveBrainNotes}
              connectors={effectiveConnectors}
              engineSettings={engineSettings}
              onChangeEngineSettings={setEngineSettings}
              voiceState={voiceState}
              hasBridgeOnline={hasBridgeOnline}
              screenSharing={screenShare.isSharing}
              screenControlArmed={Boolean(snapshot.screenControlArmed)}
              googleAuthorized={Boolean(googleAccessToken)}
              onSelectTab={setActiveTab}
              onAskRay={(prompt) => {
                setDraftPrompt(prompt);
                setActiveTab('assistant');
              }}
              onAskRayWithContext={handleAskRayWithContext}
              onToggleVoice={() => {
                if (voiceState === 'off') {
                  void startLiveSession();
                } else {
                  stopLiveSession(false);
                }
              }}
              onEmergencyStop={() => void handleEmergencyStopAll()}
              onOpenPairModal={() => setPairModalOpen(true)}
              onToggleTask={handleToggleTask}
              onCreateTask={(title) => handleCreateTask(title)}
              onCreateTimer={createTimer}
              onSaveNote={handleSaveBrainNote}
              onSaveConnector={handleSaveConnector}
              onConnectGoogleWorkspace={connectGoogleWorkspace}
              onToggleScreenControlArmed={handleToggleScreenControlArmed}
              onToggleScreenShare={async () => {
                if (screenShare.isSharing) {
                  screenShare.stopScreenShare();
                } else {
                  await screenShare.startScreenShare();
                }
              }}
              onCaptureBrowserScreenFrame={screenShare.captureScreenFrame}
              onRunProtocol={handleRunProtocol}
            />
          )}

          {activeTab === 'assistant' && (
            <AssistantView
              voiceRouting={
                <VoiceRouting
                  roomId={roomId}
                  devices={snapshot.devices}
                  myDeviceId={identity.id}
                  myName={identity.name}
                  runOn={sessionRunOn || voiceRunOn}
                  onRunOnChange={(v) => {
                    setSessionRunOn('');
                    changeVoiceRunOn(v);
                  }}
                />
              }
              compact={popupMode}
              roomId={roomId}
              userName={displayName}
              localDeviceName={identity.name}
              devices={snapshot.devices}
              messages={messages}
              setMessages={setMessages}
              targetDeviceHint={targetDeviceHint}
              setTargetDeviceHint={setTargetDeviceHint}
              onOpenCamera={() => setManualCameraOpen(true)}
              pendingAttachments={pendingAttachments}
              setPendingAttachments={setPendingAttachments}
              onPushToHandoff={(label, content) =>
                handlePushHandoff({
                  label,
                  content,
                  kind: 'text',
                  targetDevice: targetDeviceHint === 'auto' ? 'all' : targetDeviceHint,
                })
              }
              draftPrompt={draftPrompt}
              onClearDraftPrompt={() => setDraftPrompt('')}
              voice={voice}
              onChangeVoice={handleChangeVoice}
              wakeEnabled={wakeEnabled}
              onToggleWake={handleToggleWake}
              wakeSensitivity={wakeSensitivity}
              onChangeWakeSensitivity={handleChangeWakeSensitivity}
              wakeSupported={wakeSupported}
              voiceState={voiceState}
              userCaption={userCaption}
              jarvisCaption={jarvisCaption}
              liveError={liveError}
              onStartLiveVoice={startLiveSession}
              onStopLiveVoice={() => stopLiveSession(false)}
              onEmergencyStop={() => void handleEmergencyStopAll()}
              pendingConfirmations={pendingConfirmations}
              onAddConfirmation={handleAddConfirmation}
              onResolveConfirmation={handleResolveConfirmation}
              veronicaMode={Boolean(snapshot.veronicaMode)}
              onPersistMessage={handlePersistMessage}
              onUpdatePersistedMessage={handleUpdatePersistedMessage}
              onClearHistory={handleClearHistory}
              engineSettings={engineSettings}
              onChangeEngineSettings={setEngineSettings}
              googleAccessToken={googleAccessToken}
              notionToken={notionToken}
              connectors={effectiveConnectors}
              screenShare={screenShare}
              screenControlArmed={Boolean(snapshot.screenControlArmed)}
              onToggleScreenControlArmed={handleToggleScreenControlArmed}
              hasBridgeOnline={hasBridgeOnline}
              bridgeMonitor={bridgeMonitor}
              roomToken={roomToken}
            />
          )}

          {activeTab === 'brain' && (
            <SecondBrainView
              roomId={roomId}
              notes={effectiveBrainNotes}
              hasBridgeOnline={hasBridgeOnline}
              googleAccessToken={googleAccessToken}
              notionToken={notionToken}
              connectors={effectiveConnectors}
              onConnectGoogleWorkspace={connectGoogleWorkspace}
              onSaveConnector={handleSaveConnector}
              onSaveNote={handleSaveBrainNote}
              onDeleteNote={handleDeleteBrainNote}
              onAskJarvis={(prompt) => {
                setDraftPrompt(prompt);
                setActiveTab('assistant');
              }}
              onOpenAppsTab={() => setActiveTab('apps')}
              focusNoteId={brainFocusNoteId}
            />
          )}

          {activeTab === 'brain3d' && (
            <Brain3DView
              roomId={roomId}
              googleAccessToken={googleAccessToken}
              notes={effectiveBrainNotes}
              onOpenInEditor={(id) => {
                setBrainFocusNoteId(id);
                setActiveTab('brain');
              }}
              onAskRay={(prompt) => {
                setDraftPrompt(prompt);
                setActiveTab('assistant');
              }}
            />
          )}

          {activeTab === 'files' && (
            <FilesSystemView
              roomId={roomId}
              devices={snapshot.devices}
              hasBridgeOnline={hasBridgeOnline}
              screenSharing={screenShare.isSharing}
              screenControlArmed={Boolean(snapshot.screenControlArmed)}
              onToggleScreenShare={async () => {
                if (screenShare.isSharing) {
                  screenShare.stopScreenShare();
                } else {
                  await screenShare.startScreenShare();
                }
              }}
              onToggleScreenControlArmed={handleToggleScreenControlArmed}
              onCaptureBrowserScreenFrame={screenShare.captureScreenFrame}
              onOpenPairModal={() => setPairModalOpen(true)}
              onAskRayWithContext={handleAskRayWithContext}
              onSaveToBrain={handleSaveBrainNote}
            />
          )}

          {activeTab === 'apps' && (
            <AppsConnectorsView
              roomId={roomId}
              googleAccessToken={googleAccessToken}
              notionToken={notionToken}
              onChangeNotionToken={setNotionToken}
              onConnectGoogleWorkspace={connectGoogleWorkspace}
              connectors={effectiveConnectors}
              onSaveConnector={handleSaveConnector}
              onDeleteConnector={handleDeleteConnector}
              onConfirmationRequired={handleAddConfirmation}
              onAskJarvis={(prompt) => {
                setDraftPrompt(prompt);
                setActiveTab('assistant');
              }}
            />
          )}

          {activeTab === 'devices' && (
            <DevicesView
              roomId={roomId}
              devices={snapshot.devices}
              commands={snapshot.commands}
              localDeviceId={identity.id}
              onRenameDevice={renameDevice}
              onRemoveDevice={removeDevice}
              onCallDevice={(id, name, video) => void deviceCall.callDevice(id, name, video)}
              onShareLocation={shareLocationTelemetry}
              onOpenPairModal={() => setPairModalOpen(true)}
            />
          )}

          {activeTab === 'routines' && (
            <RoutinesView
              roomId={roomId}
              localDeviceName={identity.name}
              devices={snapshot.devices}
              tasks={effectiveTasks}
              timers={snapshot.timers}
              routines={effectiveRoutines}
              analyses={effectiveAnalyses}
              engineSettings={engineSettings}
              googleAccessToken={googleAccessToken}
              notionToken={notionToken}
              customConnectors={effectiveConnectors}
              onCreateTask={handleCreateTask}
              onToggleTask={handleToggleTask}
              onDeleteTask={handleDeleteTask}
              onCreateTimer={createTimer}
              onCancelTimer={cancelTimer}
              onDeleteRoutine={handleDeleteRoutine}
              onSaveAnalysis={handleSaveAnalysis}
              onDeleteAnalysis={handleDeleteAnalysis}
            />
          )}

          {activeTab === 'jarvis' && (
            <JarvisView
              roomId={roomId}
              devices={snapshot.devices}
              onOpenConnect={() => setActiveTab('connect')}
              onAskRay={(prompt) => {
                setDraftPrompt(prompt);
                setActiveTab('assistant');
              }}
            />
          )}

          {activeTab === 'connect' && (
            <ConnectionsView
              roomId={roomId}
              devices={snapshot.devices}
              messages={snapshot.incomingMessages || []}
              engineSettings={engineSettings}
              onChangeEngineSettings={setEngineSettings}
              pushStatus={pushWake.status}
              onEnablePush={() => pushWake.enable()}
              voicePipeline={voicePipeline}
              wakeEnabled={wakeEnabled}
              bridgeConnected={bridgeMonitor.status === 'connected'}
              onEnableWake={() => setWakeEnabled(true)}
              pwa={pwa}
            />
          )}

          {activeTab === 'handoff' && (
            <HandoffView
              handoffs={effectiveHandoffs}
              devices={snapshot.devices}
              onPushHandoff={handlePushHandoff}
              onDeleteHandoff={handleDeleteHandoff}
              onAskAssistant={(prompt) => {
                setDraftPrompt(prompt);
                setActiveTab('assistant');
              }}
            />
          )}
          </div>
        </main>
      </div>

      <AgentRunPanel roomId={roomId} />

      <AskCard roomId={roomId} />
      <CallScreen
        state={deviceCall.state}
        localStream={deviceCall.localStream}
        remoteStream={deviceCall.remoteStream}
        onAccept={(withVideo) => void deviceCall.accept(withVideo)}
        onDecline={deviceCall.decline}
        onHangup={deviceCall.hangup}
        onToggleMute={deviceCall.toggleMute}
        onToggleCamera={() => void deviceCall.toggleCamera()}
        onFlipCamera={() => void deviceCall.flipCamera()}
      />

      {!popupMode && (<>
      {/* Mobile Bottom Nav — 4 primary destinations + "More" sheet (bigger tap targets) */}
      {moreNavOpen && (
        <div className="md:hidden fixed inset-0 z-40 bg-slate-950/50 backdrop-blur-sm" onClick={() => setMoreNavOpen(false)}>
          <div
            className="absolute bottom-0 inset-x-0 rounded-t-2xl bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">More</span>
              <button type="button" aria-label="Close" onClick={() => setMoreNavOpen(false)} className="p-1.5 rounded-lg text-slate-500">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  { id: 'brain', label: 'Notes', icon: Brain },
                  { id: 'brain3d', label: '3D Brain', icon: Orbit },
                  { id: 'files', label: 'Files & OS', icon: FolderOpen },
                  { id: 'apps', label: 'Apps', icon: Blocks },
                  { id: 'devices', label: 'Devices', icon: MonitorSmartphone },
                  { id: 'routines', label: 'Routines', icon: ClipboardList },
                  { id: 'handoff', label: 'Handoff', icon: Layers },
                ] as const
              ).map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setActiveTab(item.id);
                      setMoreNavOpen(false);
                    }}
                    className={`flex flex-col items-center gap-1.5 rounded-xl py-3 text-xs font-medium border ${
                      activeTab === item.id
                        ? 'border-blue-500/40 bg-blue-500/10 text-blue-600 dark:text-blue-300'
                        : 'border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    <Icon className="w-5 h-5" />
                    {item.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
      <nav className="md:hidden fixed bottom-0 inset-x-0 border-t border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-slate-900/95 backdrop-blur grid grid-cols-5 z-30 pb-[env(safe-area-inset-bottom)]">
        {(
          [
            { id: 'dashboard', label: 'Home', icon: Home },
            { id: 'assistant', label: 'RAY', icon: Bot },
            { id: 'jarvis', label: 'Core', icon: Sparkles },
            { id: 'connect', label: 'Connect', icon: Cable },
          ] as const
        ).map((item) => {
          const Icon = item.icon;
          const active = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setActiveTab(item.id)}
              className={`h-14 flex flex-col items-center justify-center gap-1 text-[11px] font-medium ${
                active ? 'text-blue-600 dark:text-blue-400' : 'text-slate-500 dark:text-slate-400'
              }`}
            >
              <span className={`px-3 py-0.5 rounded-full ${active ? 'bg-blue-500/12 dark:bg-blue-400/15' : ''}`}>
                <Icon className="w-5 h-5" />
              </span>
              <span>{item.label}</span>
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => setMoreNavOpen(true)}
          className={`h-14 flex flex-col items-center justify-center gap-1 text-[11px] font-medium ${
            ['brain', 'brain3d', 'files', 'apps', 'devices', 'routines', 'handoff'].includes(activeTab) ? 'text-blue-600 dark:text-blue-400' : 'text-slate-500 dark:text-slate-400'
          }`}
        >
          <span className="px-3 py-0.5"><LayoutGrid className="w-5 h-5" /></span>
          <span>More</span>
        </button>
      </nav>

      </>)}

      <IncomingCommandBar actions={incomingActions} onDismiss={dismissAction} />

      <PairDeviceModal
        open={pairModalOpen}
        roomId={roomId}
        roomToken={roomToken}
        roomAuthError={roomAuthError}
        bridgeStatus={bridgeMonitor.status}
        bridgeStartupInstalled={bridgeMonitor.startupInstalled}
        ollamaRunning={bridgeMonitor.ollamaRunning}
        onApplyRoomToken={applyManualRoomToken}
        onClose={() => setPairModalOpen(false)}
        onChangeRoom={handleChangeRoom}
      />

      <CameraModal
        open={cameraOpen}
        reason={pendingSnapshotRequest?.reason}
        onClose={() => {
          setManualCameraOpen(false);
          clearSnapshotRequest();
        }}
        onCapture={handleCameraCapture}
      />
    </div>
  );
}
