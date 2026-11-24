import React, { useEffect, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  BookOpen,
  Camera,
  Check,
  Copy,
  Cpu,
  Ear,
  Globe,
  Link2,
  MapPin,
  Mic,
  Monitor,
  MonitorOff,
  MousePointerClick,
  Paperclip,
  Radio,
  RefreshCw,
  Send,
  Server,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Zap,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  Volume2,
  X,
} from 'lucide-react';
import type {
  AppConnector,
  CapabilityMeta,
  ChatAttachment,
  ChatMessage,
  ConfirmationRequest,
  DeviceInfo,
  EngineSettings,
  GroundingMode,
  GroundingSource,
  LiveVoiceState,
  ProtocolName,
  ProtocolResult,
  ToolCallEvent,
  VoicePersona,
} from '../types/relay';
import { useVoiceRecorder } from '../hooks/useVoiceRecorder';
import { playHudSound } from '../utils/hudAudio';
import { authFetch } from '../utils/roomAuth';
import {
  captureScreenViaLocalBridge,
  fetchLocalOllamaTags,
  runLocalOllamaChatViaBridge, forwardBridgeProxyActionToLocal } from '../services/localBridgeClient';
import type { LocalBridgeMonitorState } from '../hooks/useLocalBridgeMonitor';
import { RayCoreFace } from './RayCoreFace';

interface AssistantViewProps {
  /** Compact pop-up window: hide the workspace toolbar. */
  compact?: boolean;
  roomId: string;
  userName: string;
  localDeviceName: string;
  devices: DeviceInfo[];
  messages: ChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  targetDeviceHint: string;
  setTargetDeviceHint: (hint: string) => void;
  onOpenCamera: () => void;
  pendingAttachments: ChatAttachment[];
  setPendingAttachments: React.Dispatch<React.SetStateAction<ChatAttachment[]>>;
  onPushToHandoff: (label: string, content: string) => void;
  draftPrompt?: string;
  onClearDraftPrompt?: () => void;
  voice: VoicePersona;
  onChangeVoice: (v: VoicePersona) => void;
  wakeEnabled: boolean;
  onToggleWake: () => void;
  wakeSensitivity: number;
  onChangeWakeSensitivity: (val: number) => void;
  wakeSupported: boolean;
  voiceState: LiveVoiceState;
  userCaption: string;
  jarvisCaption: string;
  liveError: string | null;
  onStartLiveVoice: () => void;
  /** Shared-mic control shown next to the voice buttons. */
  voiceRouting?: React.ReactNode;
  onStopLiveVoice: () => void;
  onEmergencyStop: () => void;
  pendingConfirmations: ConfirmationRequest[];
  onAddConfirmation: (req: ConfirmationRequest) => void;
  onResolveConfirmation: (id: string, approved: boolean, secret?: string) => Promise<void>;
  veronicaMode: boolean;
  onPersistMessage: (msg: ChatMessage) => void;
  onUpdatePersistedMessage: (msg: ChatMessage) => void;
  onClearHistory: () => void;
  engineSettings: EngineSettings;
  onChangeEngineSettings: React.Dispatch<React.SetStateAction<EngineSettings>>;
  googleAccessToken: string | null;
  notionToken: string;
  connectors: AppConnector[];
  screenShare: {
    isSharing: boolean;
    screenError: string | null;
    startScreenShare: () => Promise<boolean>;
    stopScreenShare: () => void;
    captureScreenFrame: () => string | null;
  };
  screenControlArmed: boolean;
  onToggleScreenControlArmed: () => Promise<void>;
  hasBridgeOnline: boolean;
  bridgeMonitor?: LocalBridgeMonitorState;
  roomToken?: string;
}

const VOICES: VoicePersona[] = ['Fenrir', 'Charon', 'Puck', 'Kore', 'Zephyr'];

const QUICK_PROMPTS = [
  {
    title: 'Research in the browser',
    prompt: 'Research the best laptops under ₹80,000 this month and compare the top 3 with prices and sources.',
  },
  {
    title: 'Check & fix my PC',
    prompt: 'My PC feels slow — diagnose it and fix what you safely can.',
  },
  {
    title: 'Teach me on screen',
    prompt: 'Show me how to turn on night light in Windows settings.',
  },
  {
    title: 'What did you learn today?',
    prompt: 'What did you learn today? Give me a short briefing.',
  },
];

const PROTOCOL_BUTTONS: Array<{ key: ProtocolName; label: string; desc: string }> = [
  { key: 'house_party', label: 'House Party', desc: 'Full mesh diagnostics' },
  { key: 'sentry_mode', label: 'Sentry Mode', desc: 'Anomaly & security scan' },
  { key: 'veronica', label: 'Veronica', desc: 'Max cloud reasoning' },
  { key: 'clean_slate', label: 'Clean Slate', desc: 'Safe clutter purge' },
];

function FormattedProse({ text }: { text: string }) {
  const blocks = text.split(/(```[\s\S]*?```)/g);
  return (
    <div className="space-y-2.5 text-sm leading-relaxed text-slate-800 dark:text-slate-200">
      {blocks.map((block, bIdx) => {
        if (block.startsWith('```') && block.endsWith('```')) {
          const inner = block.slice(3, -3).replace(/^[a-z]+\n/i, '');
          return (
            <pre
              key={bIdx}
              className="p-3 rounded-lg bg-slate-900 dark:bg-slate-950 text-slate-100 font-mono text-xs overflow-x-auto border border-slate-800"
            >
              <code>{inner}</code>
            </pre>
          );
        }

        const lines = block.split('\n');
        return (
          <div key={bIdx} className="space-y-1.5">
            {lines.map((line, lIdx) => {
              const trimmed = line.trim();
              if (!trimmed) return null;
              if (trimmed.startsWith('### ')) {
                return (
                  <h4 key={lIdx} className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100 pt-1">
                    {trimmed.slice(4)}
                  </h4>
                );
              }
              if (trimmed.startsWith('## ')) {
                return (
                  <h3 key={lIdx} className="font-display text-base font-semibold text-slate-900 dark:text-slate-100 pt-1">
                    {trimmed.slice(3)}
                  </h3>
                );
              }
              const parts = line.split(/(\*\*[^*]+\*\*|`[^`]+`|https?:\/\/[^\s)]+)/g);
              return (
                <p key={lIdx} className="break-words">
                  {parts.map((part, pIdx) => {
                    if (part.startsWith('**') && part.endsWith('**')) {
                      return (
                        <strong key={pIdx} className="font-semibold text-slate-900 dark:text-slate-100">
                          {part.slice(2, -2)}
                        </strong>
                      );
                    }
                    if (part.startsWith('`') && part.endsWith('`')) {
                      return (
                        <code
                          key={pIdx}
                          className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 font-mono text-xs text-slate-900 dark:text-slate-100"
                        >
                          {part.slice(1, -1)}
                        </code>
                      );
                    }
                    if (/^https?:\/\//.test(part)) {
                      return (
                        <a
                          key={pIdx}
                          href={part}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 dark:text-blue-400 underline break-all"
                        >
                          {part}
                        </a>
                      );
                    }
                    return <React.Fragment key={pIdx}>{part}</React.Fragment>;
                  })}
                </p>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

export const AssistantView: React.FC<AssistantViewProps> = ({
  compact = false,
  roomId,
  userName,
  localDeviceName,
  devices,
  messages,
  setMessages,
  targetDeviceHint,
  setTargetDeviceHint,
  onOpenCamera,
  pendingAttachments,
  setPendingAttachments,
  onPushToHandoff,
  draftPrompt,
  onClearDraftPrompt,
  voice,
  onChangeVoice,
  wakeEnabled,
  onToggleWake,
  wakeSensitivity,
  onChangeWakeSensitivity,
  wakeSupported,
  voiceState,
  userCaption,
  jarvisCaption,
  liveError,
  onStartLiveVoice,
  voiceRouting,
  onStopLiveVoice,
  onEmergencyStop,
  pendingConfirmations,
  onAddConfirmation,
  onResolveConfirmation,
  veronicaMode,
  onPersistMessage,
  onUpdatePersistedMessage,
  onClearHistory,
  engineSettings,
  onChangeEngineSettings,
  googleAccessToken,
  notionToken,
  connectors,
  screenShare,
  screenControlArmed,
  onToggleScreenControlArmed,
  hasBridgeOnline,
  bridgeMonitor,
  roomToken = '',
}) => {
  const [input, setInput] = useState('');
  const [secretInputs, setSecretInputs] = useState<Record<string, string>>({});
  const [thinkingMode, setThinkingMode] = useState<'fast' | 'deep'>('fast');
  const [groundingMode, setGroundingMode] = useState<GroundingMode>('search');
  const [userLocation, setUserLocation] = useState<{ latitude: number; longitude: number } | undefined>(
    undefined
  );
  const [autoSpeak, setAutoSpeak] = useState(false);
  const [sending, setSending] = useState(false);
  const [speakingMsgId, setSpeakingMsgId] = useState<string | null>(null);
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
  const [showRegistry, setShowRegistry] = useState(false);
  const [capabilities, setCapabilities] = useState<CapabilityMeta[]>([]);
  const [runningProtocol, setRunningProtocol] = useState<ProtocolName | null>(null);
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [ollamaStatus, setOllamaStatus] = useState<string | null>(null);
  const [openrouterModels, setOpenrouterModels] = useState<string[]>([
    'openrouter/free',
    'google/gemma-4-31b-it:free',
    'google/gemma-4-26b-a4b-it:free',
    'nvidia/nemotron-3-ultra-550b-a55b:free',
    'nvidia/nemotron-3.5-super-vl:free',
    'nvidia/nemotron-3.5-lightning:free',
    'anthropic/claude-3.5-sonnet',
    'openai/gpt-4o-mini',
  ]);
  const [openrouterHasKey, setOpenrouterHasKey] = useState<boolean | null>(null);
  const [openrouterStatus, setOpenrouterStatus] = useState<string | null>(null);
  const [loadingOpenrouter, setLoadingOpenrouter] = useState(false);

  const [groqModels, setGroqModels] = useState<string[]>([
    'llama-3.3-70b-versatile',
    'llama-3.1-8b-instant',
    'mixtral-8x7b-32768',
    'gemma2-9b-it',
  ]);
  const [groqHasKey, setGroqHasKey] = useState<boolean | null>(null);
  const [groqStatus, setGroqStatus] = useState<string | null>(null);
  const [loadingGroq, setLoadingGroq] = useState(false);

  const refreshGroqModels = async () => {
    setLoadingGroq(true);
    setGroqStatus(null);
    try {
      const res = await authFetch(`/api/groq/models?room=${encodeURIComponent(roomId)}`, roomId);
      const data = (await res.json()) as {
        ok?: boolean;
        hasKey?: boolean;
        models?: string[];
        error?: string;
      };
      if (typeof data.hasKey === 'boolean') {
        setGroqHasKey(data.hasKey);
      }
      if (Array.isArray(data.models) && data.models.length > 0) {
        setGroqModels(data.models);
        if (!data.models.includes(engineSettings.groqModel)) {
          onChangeEngineSettings((prev) => ({ ...prev, groqModel: data.models![0] }));
        }
      }
      setGroqStatus(
        data.error ||
          (data.hasKey
            ? `${data.models?.length || 0} Groq models ready`
            : 'Add GROQ_API_KEY in AI Studio Secrets or .env to run Groq requests')
      );
    } catch (err) {
      setGroqStatus(err instanceof Error ? err.message : 'Groq catalog check failed');
    } finally {
      setLoadingGroq(false);
    }
  };

  const [showOfflineGuide, setShowOfflineGuide] = useState(false);
  const [capturingScreen, setCapturingScreen] = useState(false);

  // Auto-sync Ollama models from background bridgeMonitor
  useEffect(() => {
    if (!bridgeMonitor) return;
    if (bridgeMonitor.ollamaRunning && bridgeMonitor.ollamaModels.length > 0) {
      setOllamaModels(bridgeMonitor.ollamaModels);
      if (!bridgeMonitor.ollamaModels.includes(engineSettings.ollamaModel)) {
        onChangeEngineSettings((prev) => ({
          ...prev,
          ollamaModel: bridgeMonitor.ollamaModels[0],
        }));
      }
      setOllamaStatus(
        `${bridgeMonitor.ollamaModels.length} local model${bridgeMonitor.ollamaModels.length > 1 ? 's' : ''} ready (${
          bridgeMonitor.status === 'connected' ? 'Auto-detected via Bridge 17345' : 'Loopback Active'
        })`
      );
    } else if (bridgeMonitor.status === 'token_mismatch') {
      setOllamaStatus(
        `Bridge 17345 token mismatch (401). Run: node ".\\Downloads\\relay-bridge-${roomId.toLowerCase()}.mjs" --set-token ${
          roomToken || '<TOKEN>'
        }`
      );
    }
  }, [
    bridgeMonitor,
    engineSettings.ollamaModel,
    onChangeEngineSettings,
    roomId,
    roomToken,
  ]);

  useEffect(() => {
    if (draftPrompt) {
      setInput(draftPrompt);
      onClearDraftPrompt?.();
    }
  }, [draftPrompt, onClearDraftPrompt]);

  useEffect(() => {
    if (!showRegistry || capabilities.length > 0) return;
    fetch('/api/capabilities')
      .then((r) => r.json())
      .then((d: { capabilities?: CapabilityMeta[] }) => {
        if (Array.isArray(d.capabilities)) setCapabilities(d.capabilities);
      })
      .catch(() => {
        // Ignore fetch failure
      });
  }, [showRegistry, capabilities.length]);

  const refreshOllamaModels = async () => {
    setLoadingModels(true);
    setOllamaStatus(null);
    try {
      const targetUrl = engineSettings.ollamaUrl || 'http://127.0.0.1:11434';
      const isRemoteHost =
        typeof window !== 'undefined' &&
        window.location.hostname !== 'localhost' &&
        window.location.hostname !== '127.0.0.1';

      // When running in cloud preview and cloud WS bridge isn't connected, try browser -> 127.0.0.1:17345 direct bridge first
      if (isRemoteHost && !hasBridgeOnline) {
        const localRes = await fetchLocalOllamaTags(roomId, targetUrl);
        if (localRes.ok) {
          setOllamaModels(localRes.models);
          if (localRes.models.length > 0 && !localRes.models.includes(engineSettings.ollamaModel)) {
            onChangeEngineSettings((prev) => ({ ...prev, ollamaModel: localRes.models[0] }));
          }
          setOllamaStatus(
            localRes.models.length > 0
              ? `${localRes.models.length} local model${localRes.models.length > 1 ? 's' : ''} ready (${localRes.via === 'local-bridge' ? 'Local Bridge 17345' : 'Loopback'})`
              : 'Ollama connected locally, no models pulled yet.'
          );
          return;
        }
      }

      const qs = new URLSearchParams({
        room: roomId,
        url: targetUrl,
        bridge: engineSettings.useBridgeProxy ? 'true' : 'false',
      });
      const res = await authFetch(`/api/ollama/tags?${qs.toString()}`, roomId);
      const data = (await res.json()) as { ok?: boolean; models?: string[]; error?: string };
      if (!res.ok || !data.ok) {
        // Fallback to Local Direct Bridge (127.0.0.1:17345) before giving up
        const localRes = await fetchLocalOllamaTags(roomId, targetUrl);
        if (localRes.ok) {
          setOllamaModels(localRes.models);
          if (localRes.models.length > 0 && !localRes.models.includes(engineSettings.ollamaModel)) {
            onChangeEngineSettings((prev) => ({ ...prev, ollamaModel: localRes.models[0] }));
          }
          setOllamaStatus(
            localRes.models.length > 0
              ? `${localRes.models.length} local model${localRes.models.length > 1 ? 's' : ''} ready (Local Bridge 17345)`
              : 'Ollama connected locally, no models pulled yet.'
          );
        } else {
          setOllamaModels([]);
          setOllamaStatus(localRes.error || data.error || 'Could not reach local Ollama server.');
        }
      } else {
        const list = Array.isArray(data.models) ? data.models : [];
        setOllamaModels(list);
        if (list.length > 0 && !list.includes(engineSettings.ollamaModel)) {
          onChangeEngineSettings((prev) => ({ ...prev, ollamaModel: list[0] }));
        }
        setOllamaStatus(
          list.length > 0
            ? `${list.length} local model${list.length > 1 ? 's' : ''} ready`
            : 'Ollama connected, no models pulled yet.'
        );
      }
    } catch (err) {
      setOllamaStatus(err instanceof Error ? err.message : 'Ollama discovery failed');
    } finally {
      setLoadingModels(false);
    }
  };

  const refreshOpenRouterModels = async () => {
    setLoadingOpenrouter(true);
    setOpenrouterStatus(null);
    try {
      const res = await authFetch(`/api/openrouter/models?room=${encodeURIComponent(roomId)}`, roomId);
      const data = (await res.json()) as {
        ok?: boolean;
        hasKey?: boolean;
        models?: string[];
        error?: string;
      };
      if (typeof data.hasKey === 'boolean') {
        setOpenrouterHasKey(data.hasKey);
      }
      if (Array.isArray(data.models) && data.models.length > 0) {
        setOpenrouterModels(data.models);
        if (!data.models.includes(engineSettings.openrouterModel)) {
          onChangeEngineSettings((prev) => ({ ...prev, openrouterModel: data.models![0] }));
        }
      }
      setOpenrouterStatus(
        data.error ||
          (data.hasKey
            ? `${data.models?.length || 0} OpenRouter models ready`
            : 'Add OPENROUTER_API_KEY in AI Studio Secrets or .env to run OpenRouter requests')
      );
    } catch (err) {
      setOpenrouterStatus(err instanceof Error ? err.message : 'OpenRouter catalog check failed');
    } finally {
      setLoadingOpenrouter(false);
    }
  };

  useEffect(() => {
    if (engineSettings.provider === 'ollama') {
      const isRemoteHost =
        typeof window !== 'undefined' &&
        window.location.hostname !== 'localhost' &&
        window.location.hostname !== '127.0.0.1';
      if (isRemoteHost && hasBridgeOnline && !engineSettings.useBridgeProxy) {
        onChangeEngineSettings((prev) => ({ ...prev, useBridgeProxy: true }));
        return;
      }
      if (ollamaModels.length === 0 && !loadingModels && !ollamaStatus) {
        void refreshOllamaModels();
      }
    }
    if (engineSettings.provider === 'openrouter' && openrouterHasKey === null && !loadingOpenrouter) {
      void refreshOpenRouterModels();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineSettings.provider, engineSettings.useBridgeProxy, hasBridgeOnline]);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const {
    isRecording,
    isTranscribing,
    error: micError,
    startRecording,
    stopAndTranscribe,
  } = useVoiceRecorder(roomId);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, sending, pendingConfirmations.length]);

  const speakMessage = async (msgId: string, text: string) => {
    if (!text.trim()) return;
    if (speakingMsgId === msgId && audioRef.current) {
      audioRef.current.pause();
      setSpeakingMsgId(null);
      return;
    }

    setSpeakingMsgId(msgId);
    try {
      const res = await authFetch('/api/ai/tts', roomId, {
        method: 'POST',
        body: JSON.stringify({ roomId, text, voiceName: voice }),
      });
      const data = (await res.json()) as { audioBase64?: string; mimeType?: string; error?: string };
      if (!res.ok || !data.audioBase64) throw new Error(data.error || 'TTS failed');
      const audio = new Audio(`data:${data.mimeType || 'audio/wav'};base64,${data.audioBase64}`);
      audioRef.current = audio;
      audio.onended = () => setSpeakingMsgId(null);
      await audio.play();
    } catch {
      setSpeakingMsgId(null);
    }
  };

  const handleRunProtocol = async (protocolKey: ProtocolName) => {
    if (runningProtocol) return;
    setRunningProtocol(protocolKey);
    playHudSound('blip');
    try {
      const res = await authFetch('/api/protocols/run', roomId, {
        method: 'POST',
        body: JSON.stringify({ roomId, protocolName: protocolKey, confirmed: false }),
      });
      const data = (await res.json()) as ProtocolResult;
      if (data.requiresConfirmation && data.confirmationId) {
        onAddConfirmation({
          id: data.confirmationId,
          roomId,
          toolName: 'execute_protocol',
          safetyLevel: 'sensitive',
          summary: data.speechResponse,
          targetDevice: 'all',
          args: { protocol_name: protocolKey },
          createdAt: Date.now(),
        });
      } else {
        const msg: ChatMessage = {
          id: `proto-${Date.now()}`,
          role: 'assistant',
          text: `**${data.protocol}** — ${data.speechResponse}`,
          createdAt: Date.now(),
          thinkingMode: protocolKey === 'veronica' ? 'deep' : thinkingMode,
        };
        setMessages((prev) => [...prev, msg]);
        onPersistMessage(msg);
        if (autoSpeak && data.speechResponse) {
          void speakMessage(msg.id, data.speechResponse);
        }
      }
    } catch {
      // Ignore error
    } finally {
      setRunningProtocol(null);
    }
  };

  const handleSnapScreenToComposer = async () => {
    setCapturingScreen(true);
    try {
      if (screenShare.isSharing) {
        const frame = screenShare.captureScreenFrame();
        if (frame) {
          setPendingAttachments((prev) => [
            ...prev,
            {
              id: `screen-${Date.now()}`,
              name: `screen-${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.jpg`,
              mimeType: 'image/jpeg',
              dataUrl: frame,
            },
          ]);
          playHudSound('blip');
          return;
        }
      }

      const bridgeCap = await captureScreenViaLocalBridge(roomId);
      const screenDataUrl = bridgeCap.data?.dataUrl;
      if (bridgeCap.ok && screenDataUrl) {
        const screenMime = bridgeCap.data?.mimeType || 'image/png';
        setPendingAttachments((prev) => [
          ...prev,
          {
            id: `os-screen-${Date.now()}`,
            name: `desktop-screen-${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.png`,
            mimeType: screenMime,
            dataUrl: screenDataUrl,
          },
        ]);
        playHudSound('blip');
        return;
      }

      await screenShare.startScreenShare();
    } finally {
      setCapturingScreen(false);
    }
  };

  const handleSendMessage = async (overrideText?: string) => {
    const textToSend = (overrideText ?? input).trim();
    if ((!textToSend && pendingAttachments.length === 0) || sending) return;

    const currentAttachments = [...pendingAttachments];
    if (!overrideText) setInput('');
    setPendingAttachments([]);
    setSending(true);
    playHudSound('blip');

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      text: textToSend || 'Analyze attached media.',
      attachments: currentAttachments,
      createdAt: Date.now(),
    };

    const assistantMsgId = `assistant-${Date.now()}`;
    const assistantPlaceholder: ChatMessage = {
      id: assistantMsgId,
      role: 'assistant',
      text: '',
      toolCalls: [],
      sources: [],
      createdAt: Date.now(),
      thinkingMode: veronicaMode ? 'deep' : thinkingMode,
    };

    const historyPayload = messages.slice(-10).map((m) => ({
      role: m.role,
      text: m.text,
    }));

    setMessages((prev) => [...prev, userMsg, assistantPlaceholder]);
    onPersistMessage(userMsg);
    onPersistMessage(assistantPlaceholder);

    let latestToolCalls: ToolCallEvent[] = [];
    let latestSources: GroundingSource[] = [];
    let finalReplyText = '';
    let finalReplyKind: 'normal' | 'error' = 'normal';

    try {
      const apiAttachments = currentAttachments.map((att) => {
        const commaIdx = att.dataUrl.indexOf(',');
        return {
          mimeType: att.mimeType,
          dataBase64: commaIdx >= 0 ? att.dataUrl.slice(commaIdx + 1) : att.dataUrl,
        };
      });

      if (screenShare.isSharing && apiAttachments.length === 0) {
        const liveFrame = screenShare.captureScreenFrame();
        if (liveFrame) {
          const commaIdx = liveFrame.indexOf(',');
          apiAttachments.push({
            mimeType: 'image/jpeg',
            dataBase64: commaIdx >= 0 ? liveFrame.slice(commaIdx + 1) : liveFrame,
          });
        }
      }

      if (engineSettings.provider === 'ollama' && !hasBridgeOnline) {
        const handledLocally = await runLocalOllamaChatViaBridge({
          roomId,
          userName,
          ollamaUrl: engineSettings.ollamaUrl,
          model: engineSettings.ollamaModel || 'llama3.2',
          message: userMsg.text,
          history: historyPayload,
          attachments: apiAttachments,
          onToolEvent: (toolEvt, finished) => {
            latestToolCalls = finished
              ? latestToolCalls.map((t) => (t.id === toolEvt.id ? toolEvt : t))
              : [...latestToolCalls, toolEvt];
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantMsgId ? { ...m, toolCalls: latestToolCalls } : m))
            );
          },
          onText: (reply) => {
            finalReplyText = reply;
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantMsgId ? { ...m, text: finalReplyText } : m))
            );
          },
        });
        if (handledLocally) {
          onUpdatePersistedMessage({
            ...assistantPlaceholder,
            text: finalReplyText || 'Completed.',
            toolCalls: latestToolCalls,
            sources: latestSources,
          });
          if (autoSpeak && finalReplyText) {
            void speakMessage(assistantMsgId, finalReplyText);
          }
          return;
        }
      }

      // Abort if the stream goes silent for 45s so the UI never hangs on "processing".
      const streamAbort = new AbortController();
      let idleTimer = window.setTimeout(() => streamAbort.abort(), 45000);
      const bumpIdle = () => {
        window.clearTimeout(idleTimer);
        idleTimer = window.setTimeout(() => streamAbort.abort(), 45000);
      };
      let engineLabel = '';
      const res = await authFetch(
        '/api/ai/chat',
        roomId,
        {
          method: 'POST',
          signal: streamAbort.signal,
          body: JSON.stringify({
            roomId,
            sourceDeviceName: localDeviceName,
            targetDeviceHint: targetDeviceHint === 'auto' ? undefined : targetDeviceHint,
            message: userMsg.text,
            history: historyPayload,
            attachments: apiAttachments,
            deepThinking: thinkingMode === 'deep' || veronicaMode,
            enableSearch: groundingMode === 'search',
            groundingMode,
            userLocation,
            preferredVoice: voice,
            engine: engineSettings,
            customConnectors: connectors,
          }),
        },
        { googleAccessToken, notionToken }
      );

      if (!res.ok) {
        const errPayload = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(errPayload.error || `Request failed (${res.status})`);
      }
      if (!res.body) throw new Error('Streaming response unavailable');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        let chunkRead: ReadableStreamReadResult<Uint8Array>;
        try {
          chunkRead = await reader.read();
        } catch {
          throw new Error('RAY timed out waiting for the AI engine (45s with no response). Try again — RAY will use a different engine.');
        }
        const { value, done } = chunkRead;
        if (done) break;
        bumpIdle();
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';

        for (const chunk of lines) {
          const dataLine = chunk
            .split('\n')
            .find((l) => l.startsWith('data: '));
          if (!dataLine) continue;

          const evt = JSON.parse(dataLine.slice(6)) as { type: string; data: unknown };

          if (evt.type === 'engine') {
            const d = evt.data as { answeredBy?: string; provider?: string; model?: string };
            const label = d.answeredBy || (d.provider ? `${d.provider}${d.model ? ` · ${d.model}` : ''}` : '');
            if (label) {
              engineLabel = label;
              setMessages((prev) => prev.map((m) => (m.id === assistantMsgId ? { ...m, engineLabel } : m)));
            }
          } else if (evt.type === 'tool_start') {
            const toolEvt = evt.data as ToolCallEvent;
            latestToolCalls = [...latestToolCalls, toolEvt];
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantMsgId ? { ...m, toolCalls: latestToolCalls } : m
              )
            );
          } else if (evt.type === 'tool_end') {
            const toolEvt = evt.data as ToolCallEvent;
            latestToolCalls = latestToolCalls.map((t) => (t.id === toolEvt.id ? toolEvt : t));
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantMsgId ? { ...m, toolCalls: latestToolCalls } : m
              )
            );
          } else if (evt.type === 'confirmation_required') {
            onAddConfirmation(evt.data as ConfirmationRequest);
          } else if (evt.type === 'sources') {
            latestSources = evt.data as GroundingSource[];
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantMsgId ? { ...m, sources: latestSources } : m))
            );
          } else if (evt.type === 'text') {
            finalReplyText = String(evt.data || '');
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantMsgId ? { ...m, text: finalReplyText } : m
              )
            );
          } else if (evt.type === 'error') {
            finalReplyKind = 'error';
            finalReplyText = `Error: ${String(evt.data || 'Assistant error')}`;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantMsgId ? { ...m, text: finalReplyText } : m
              )
            );
          }
        }
      }

      window.clearTimeout(idleTimer);
      setMessages((prev) => prev.map((m) => (m.id === assistantMsgId ? { ...m, kind: finalReplyKind } : m)));
      // Errors stay visible in the chat but are not saved as normal answers/briefings.
      if (finalReplyKind !== 'error') {
        onUpdatePersistedMessage({
          ...assistantPlaceholder,
          text: finalReplyText || 'Completed.',
          toolCalls: latestToolCalls,
          sources: latestSources,
          engineLabel: engineLabel || undefined,
        });
      }

      if (autoSpeak && finalReplyText && finalReplyKind !== 'error') {
        void speakMessage(assistantMsgId, finalReplyText);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Request failed';
      // No internet / cloud unreachable → offline mode through this PC's RAY bridge
      // (local model + phone over Wi-Fi, hotspot, Bluetooth or USB tethering).
      if (!navigator.onLine || /fetch|network|load failed|timed out/i.test(msg)) {
        const local = await forwardBridgeProxyActionToLocal(roomId, { action: 'ask', text: userMsg.text });
        const answer = (local.data as { answer?: string; via?: string } | undefined)?.answer;
        if (local.ok && answer) {
          finalReplyText = answer;
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantMsgId ? { ...m, text: answer, engineLabel: 'Offline mode · this PC' } : m))
          );
          if (autoSpeak) void speakMessage(assistantMsgId, answer);
          return;
        }
      }
      finalReplyText = `Error: ${msg}`;
      // Shown as an error bubble only — not saved into history/briefings (#22).
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsgId ? { ...m, text: finalReplyText, kind: 'error' } : m
        )
      );
    } finally {
      setSending(false);
    }
  };

  const handleFileAttach = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    for (const file of files.slice(0, 3)) {
      const dataUrl = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(String(reader.result || ''));
        reader.readAsDataURL(file);
      });
      setPendingAttachments((prev) => [
        ...prev,
        {
          id: `${file.name}-${Date.now()}`,
          name: file.name,
          mimeType: file.type || 'application/octet-stream',
          dataUrl,
        },
      ]);
    }
    e.target.value = '';
  };

  const handleMicClick = async () => {
    if (isRecording) {
      const transcript = await stopAndTranscribe();
      if (transcript) {
        setInput((prev) => (prev ? `${prev} ${transcript}` : transcript));
      }
    } else {
      await startRecording();
    }
  };

  const isLiveConnected =
    voiceState === 'connecting' ||
    voiceState === 'listening' ||
    voiceState === 'thinking' ||
    voiceState === 'speaking';

  return (
    <div className="flex flex-col h-full">
      {/* Workspace Toolbar */}
      <div className={`${compact ? 'hidden' : ''} shrink-0 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 sm:px-6 py-2.5 space-y-2`}>
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <select
              id="target-device-select"
              aria-label="Target device"
              value={targetDeviceHint}
              onChange={(e) => setTargetDeviceHint(e.target.value)}
              className="px-2.5 py-1 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100"
            >
              <option value="auto">Target: Auto</option>
              {devices.map((d) => (
                <option key={d.id} value={d.name}>
                  {d.name} {d.online ? '' : '(Offline)'}
                </option>
              ))}
            </select>

            {/* Hybrid AI Engine Switch */}
            <div className="flex items-center p-0.5 bg-slate-100 dark:bg-slate-800 rounded-lg">
              <button
                type="button"
                title="Auto-routes across all free engines and switches on limits"
                onClick={() => onChangeEngineSettings((prev) => ({ ...prev, provider: 'auto', routerMode: prev.routerMode || 'auto' }))}
                className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  engineSettings.provider === 'auto'
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                <Sparkles className="w-3 h-3 text-cyan-500" />
                <span>Auto (free)</span>
              </button>
              <button
                type="button"
                onClick={() => onChangeEngineSettings((prev) => ({ ...prev, provider: 'gemini' }))}
                className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  engineSettings.provider === 'gemini'
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                <Sparkles className="w-3 h-3" />
                <span>Gemini</span>
              </button>
              <button
                type="button"
                onClick={() => onChangeEngineSettings((prev) => ({ ...prev, provider: 'openrouter' }))}
                className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  engineSettings.provider === 'openrouter'
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                <Globe className="w-3 h-3" />
                <span>OpenRouter</span>
              </button>
              <button
                type="button"
                onClick={() => onChangeEngineSettings((prev) => ({ ...prev, provider: 'groq' }))}
                className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  engineSettings.provider === 'groq'
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                <Zap className="w-3 h-3 text-amber-500" />
                <span>Groq</span>
              </button>
              <button
                type="button"
                onClick={() => onChangeEngineSettings((prev) => ({ ...prev, provider: 'ollama' }))}
                className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  engineSettings.provider === 'ollama'
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                <Server className="w-3 h-3" />
                <span>Local</span>
              </button>
            </div>

            {engineSettings.provider === 'gemini' && (
              <div className="flex items-center p-0.5 bg-slate-100 dark:bg-slate-800 rounded-lg">
                <button
                  type="button"
                  onClick={() => setThinkingMode('fast')}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                    thinkingMode === 'fast' && !veronicaMode
                      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  Fast
                </button>
                <button
                  type="button"
                  onClick={() => setThinkingMode('deep')}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                    thinkingMode === 'deep' || veronicaMode
                      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  {veronicaMode ? 'Veronica Priority' : 'Deep Reasoning'}
                </button>
              </div>
            )}

            {engineSettings.provider === 'gemini' && (
              <div className="flex items-center p-0.5 bg-slate-100 dark:bg-slate-800 rounded-lg">
                {(
                  [
                    { key: 'search', label: 'Web Search', icon: Globe },
                    { key: 'maps', label: 'Maps', icon: MapPin },
                    { key: 'url', label: 'URL Reader', icon: Link2 },
                    { key: 'auto', label: 'OS Tools', icon: Cpu },
                  ] as const
                ).map((g) => {
                  const Icon = g.icon;
                  return (
                    <button
                      key={g.key}
                      type="button"
                      onClick={() => {
                        setGroundingMode(g.key);
                        if (g.key === 'maps' && 'geolocation' in navigator) {
                          navigator.geolocation.getCurrentPosition(
                            (pos) =>
                              setUserLocation({
                                latitude: pos.coords.latitude,
                                longitude: pos.coords.longitude,
                              }),
                            () => {},
                            { timeout: 3000 }
                          );
                        }
                      }}
                      title={
                        g.key === 'search'
                          ? 'Web Search + OS/Brain/App tools'
                          : g.key === 'maps'
                          ? 'Google Maps Places & local search grounding'
                          : g.key === 'url'
                          ? 'Read & analyze full web page URLs pasted in your prompt'
                          : 'Pure OS, Files, Brain & App tools without web search'
                      }
                      className={`inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                        groundingMode === g.key
                          ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                          : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                      }`}
                    >
                      <Icon className="w-3 h-3" />
                      <span>{g.label}</span>
                    </button>
                  );
                })}
              </div>
            )}

            <button
              type="button"
              onClick={() =>
                screenShare.isSharing
                  ? screenShare.stopScreenShare()
                  : void screenShare.startScreenShare()
              }
              title="Stream live screen frames to RAY"
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
                screenShare.isSharing
                  ? 'border-emerald-600/40 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300'
                  : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'
              }`}
            >
              {screenShare.isSharing ? (
                <Monitor className="w-3.5 h-3.5" />
              ) : (
                <MonitorOff className="w-3.5 h-3.5" />
              )}
              <span>{screenShare.isSharing ? 'Sharing Screen' : 'Share Screen'}</span>
            </button>

            <button
              type="button"
              onClick={() => void onToggleScreenControlArmed()}
              title="Arm guarded mouse & keyboard control via Desktop OS Bridge"
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
                screenControlArmed
                  ? 'border-amber-600/50 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300'
                  : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'
              }`}
            >
              {screenControlArmed ? (
                <MousePointerClick className="w-3.5 h-3.5" />
              ) : (
                <Shield className="w-3.5 h-3.5" />
              )}
              <span>{screenControlArmed ? 'Control: Armed' : 'Control: Safe'}</span>
            </button>

            <button
              type="button"
              onClick={() => setShowRegistry((s) => !s)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
                showRegistry
                  ? 'border-blue-600/30 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300'
                  : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'
              }`}
            >
              <Cpu className="w-3.5 h-3.5" />
              <span>Capabilities</span>
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              value={voice}
              onChange={(e) => onChangeVoice(e.target.value as VoicePersona)}
              aria-label="RAY voice persona"
              className="px-2.5 py-1 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100"
            >
              {VOICES.map((v) => (
                <option key={v} value={v}>
                  Voice: {v}
                </option>
              ))}
            </select>

            <button
              type="button"
              onClick={() => setAutoSpeak((v) => !v)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
                autoSpeak
                  ? 'border-blue-600/30 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300'
                  : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'
              }`}
            >
              <Volume2 className="w-3.5 h-3.5" />
              <span>Auto-Speak</span>
            </button>

            {voiceRouting}
            {wakeSupported && (
              <button
                type="button"
                onClick={onToggleWake}
                title='Listen hands-off for "Hey Ray"'
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
                  wakeEnabled
                    ? 'border-emerald-600/40 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300'
                    : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'
                }`}
              >
                <Ear className="w-3.5 h-3.5" />
                <span>Wake: {wakeEnabled ? 'Armed' : 'Off'}</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => (isLiveConnected ? onStopLiveVoice() : onStartLiveVoice())}
              className={`inline-flex items-center gap-1.5 px-3 py-1 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                isLiveConnected
                  ? 'bg-red-600 hover:bg-red-700 text-white'
                  : 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 hover:opacity-90'
              }`}
            >
              <Radio className="w-3.5 h-3.5" />
              <span>{isLiveConnected ? 'End Live Voice' : 'Live Voice'}</span>
            </button>
          </div>
        </div>

        {/* OpenRouter Bar */}
        {engineSettings.provider === 'openrouter' && (
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1.5 border-t border-slate-100 dark:border-slate-800/80 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex items-center gap-1.5 text-slate-600 dark:text-slate-300">
                <span className="text-[11px] font-medium">OpenRouter Model:</span>
                <select
                  value={
                    openrouterModels.includes(engineSettings.openrouterModel)
                      ? engineSettings.openrouterModel
                      : ''
                  }
                  onChange={(e) => {
                    if (e.target.value) {
                      onChangeEngineSettings((prev) => ({ ...prev, openrouterModel: e.target.value }));
                    }
                  }}
                  aria-label="OpenRouter preset model"
                  className="px-2 py-1 text-xs font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md max-w-[260px] text-slate-900 dark:text-slate-100"
                >
                  {!openrouterModels.includes(engineSettings.openrouterModel) && (
                    <option value="">Custom slug...</option>
                  )}
                  {openrouterModels.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>

              <input
                type="text"
                value={engineSettings.openrouterModel}
                onChange={(e) =>
                  onChangeEngineSettings((prev) => ({ ...prev, openrouterModel: e.target.value }))
                }
                placeholder="openrouter/free"
                aria-label="Custom OpenRouter model slug"
                className="px-2 py-1 text-xs font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md w-56 text-slate-900 dark:text-slate-100"
              />

              <button
                type="button"
                onClick={() => void refreshOpenRouterModels()}
                disabled={loadingOpenrouter}
                className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium border border-slate-200 dark:border-slate-700 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200"
              >
                <RefreshCw className={`w-3 h-3 ${loadingOpenrouter ? 'animate-spin' : ''}`} />
                <span>Refresh Catalog</span>
              </button>
            </div>

            <div className="flex items-center gap-2">
              {openrouterHasKey !== null && (
                <span
                  className={`text-[11px] font-medium ${
                    openrouterHasKey
                      ? 'text-emerald-700 dark:text-emerald-400'
                      : 'text-amber-700 dark:text-amber-400'
                  }`}
                >
                  {openrouterHasKey
                    ? 'Server OPENROUTER_API_KEY active'
                    : 'Set OPENROUTER_API_KEY in Secrets/.env'}
                </span>
              )}
              {openrouterStatus && openrouterHasKey && (
                <span className="text-[11px] text-slate-500 dark:text-slate-400">{openrouterStatus}</span>
              )}
              <button
                type="button"
                onClick={() => setShowOfflineGuide(true)}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium border border-blue-600/30 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 rounded-md"
              >
                <BookOpen className="w-3 h-3" />
                <span>Setup Guide</span>
              </button>
            </div>
          </div>
        )}

        {/* Groq Bar */}
        {engineSettings.provider === 'groq' && (
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1.5 border-t border-slate-100 dark:border-slate-800/80 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex items-center gap-1.5 text-slate-600 dark:text-slate-300">
                <span className="text-[11px] font-medium">Groq Model:</span>
                <select
                  value={
                    groqModels.includes(engineSettings.groqModel)
                      ? engineSettings.groqModel
                      : ''
                  }
                  onChange={(e) => {
                    if (e.target.value) {
                      onChangeEngineSettings((prev) => ({ ...prev, groqModel: e.target.value }));
                    }
                  }}
                  aria-label="Groq preset model"
                  className="px-2 py-1 text-xs font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md max-w-[260px] text-slate-900 dark:text-slate-100"
                >
                  {!groqModels.includes(engineSettings.groqModel) && (
                    <option value="">Custom model...</option>
                  )}
                  {groqModels.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>

              <input
                type="text"
                value={engineSettings.groqModel}
                onChange={(e) =>
                  onChangeEngineSettings((prev) => ({ ...prev, groqModel: e.target.value }))
                }
                placeholder="llama-3.3-70b-versatile"
                aria-label="Custom Groq model name"
                className="px-2 py-1 text-xs font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md w-56 text-slate-900 dark:text-slate-100"
              />

              <button
                type="button"
                onClick={() => void refreshGroqModels()}
                disabled={loadingGroq}
                className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium border border-slate-200 dark:border-slate-700 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200"
              >
                <RefreshCw className={`w-3 h-3 ${loadingGroq ? 'animate-spin' : ''}`} />
                <span>Refresh Catalog</span>
              </button>
            </div>

            <div className="flex items-center gap-2">
              {groqHasKey !== null && (
                <span
                  className={`text-[11px] font-medium ${
                    groqHasKey
                      ? 'text-emerald-700 dark:text-emerald-400'
                      : 'text-amber-700 dark:text-amber-400'
                  }`}
                >
                  {groqHasKey
                    ? 'Server GROQ_API_KEY active'
                    : 'Set GROQ_API_KEY in Secrets/.env'}
                </span>
              )}
              {groqStatus && groqHasKey && (
                <span className="text-[11px] text-slate-500 dark:text-slate-400">{groqStatus}</span>
              )}
            </div>
          </div>
        )}

        {/* Local Ollama Bar */}
        {engineSettings.provider === 'ollama' && (
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1.5 border-t border-slate-100 dark:border-slate-800/80 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex items-center gap-1.5 text-slate-600 dark:text-slate-300">
                <span className="text-[11px] font-medium">Ollama URL:</span>
                <input
                  type="text"
                  value={engineSettings.ollamaUrl}
                  onChange={(e) =>
                    onChangeEngineSettings((prev) => ({ ...prev, ollamaUrl: e.target.value }))
                  }
                  placeholder="http://127.0.0.1:11434"
                  className="px-2 py-1 text-xs font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md w-44 text-slate-900 dark:text-slate-100"
                />
              </label>

              {ollamaModels.length > 0 ? (
                <select
                  value={engineSettings.ollamaModel}
                  onChange={(e) =>
                    onChangeEngineSettings((prev) => ({ ...prev, ollamaModel: e.target.value }))
                  }
                  aria-label="Local Ollama model"
                  className="px-2 py-1 text-xs font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md text-slate-900 dark:text-slate-100"
                >
                  {ollamaModels.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={engineSettings.ollamaModel}
                  onChange={(e) =>
                    onChangeEngineSettings((prev) => ({ ...prev, ollamaModel: e.target.value }))
                  }
                  placeholder="llama3.2"
                  aria-label="Ollama model name"
                  className="px-2 py-1 text-xs font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md w-32 text-slate-900 dark:text-slate-100"
                />
              )}

              <label
                className="inline-flex items-center gap-1.5 text-slate-600 dark:text-slate-300 cursor-pointer"
                title="Tunnel Ollama requests through your paired Desktop OS Bridge when using the hosted Cloud URL"
              >
                <input
                  type="checkbox"
                  checked={engineSettings.useBridgeProxy}
                  onChange={(e) =>
                    onChangeEngineSettings((prev) => ({ ...prev, useBridgeProxy: e.target.checked }))
                  }
                  className="accent-blue-600 rounded"
                />
                <span className="text-[11px]">Bridge Proxy</span>
              </label>

              <button
                type="button"
                onClick={() => void refreshOllamaModels()}
                disabled={loadingModels}
                className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium border border-slate-200 dark:border-slate-700 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200"
              >
                <RefreshCw className={`w-3 h-3 ${loadingModels ? 'animate-spin' : ''}`} />
                <span>Detect Models</span>
              </button>
            </div>

            <div className="flex items-center gap-2">
              {ollamaStatus && (
                <span className="text-[11px] text-slate-500 dark:text-slate-400">{ollamaStatus}</span>
              )}
              <button
                type="button"
                onClick={() => setShowOfflineGuide(true)}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium border border-blue-600/30 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 rounded-md"
              >
                <BookOpen className="w-3 h-3" />
                <span>Offline Guide</span>
              </button>
            </div>
          </div>
        )}

        {/* Screen Share error / status notice */}
        {screenShare.screenError && (
          <div className="text-[11px] text-red-600 dark:text-red-400">
            {screenShare.screenError}
          </div>
        )}

        {/* Movie Protocols Bar */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1.5 border-t border-slate-100 dark:border-slate-800/80">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400 mr-1">
              Protocols:
            </span>
            {PROTOCOL_BUTTONS.map((p) => (
              <button
                key={p.key}
                type="button"
                disabled={runningProtocol !== null}
                onClick={() => void handleRunProtocol(p.key)}
                title={p.desc}
                className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 ${
                  p.key === 'veronica' && veronicaMode
                    ? 'border-blue-600/40 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300'
                    : 'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                {runningProtocol === p.key ? `${p.label}...` : p.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
            {engineSettings.provider === 'gemini' && (
              <button
                type="button"
                onClick={() => setShowOfflineGuide(true)}
                className="inline-flex items-center gap-1 text-[11px] text-slate-500 hover:text-blue-600 dark:hover:text-blue-400"
              >
                <Terminal className="w-3 h-3" />
                <span>Offline Setup</span>
              </button>
            )}
            {wakeEnabled && (
              <label className="inline-flex items-center gap-1.5">
                <span>Sensitivity</span>
                <input
                  type="range"
                  min={0.3}
                  max={1}
                  step={0.1}
                  value={wakeSensitivity}
                  onChange={(e) => onChangeWakeSensitivity(Number(e.target.value))}
                  className="w-16 accent-blue-600"
                />
                <span className="font-mono tabular-nums">{wakeSensitivity.toFixed(1)}</span>
              </label>
            )}
            {messages.length > 0 && (
              <button
                type="button"
                onClick={onClearHistory}
                className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-red-600 dark:hover:text-red-400"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Clear</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Ollama & OpenRouter Setup Guide Modal */}
      {showOfflineGuide && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4">
          <div className="w-full max-w-xl rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-200 dark:border-slate-800">
              <div className="flex items-center gap-2">
                <Server className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                <h2 className="font-display text-sm font-bold text-slate-900 dark:text-slate-100">
                  RAY AI Engine Setup (Ollama &amp; OpenRouter)
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setShowOfflineGuide(false)}
                className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5 space-y-4 text-xs text-slate-600 dark:text-slate-300 leading-relaxed max-h-[75vh] overflow-y-auto">
              <div className="space-y-1.5">
                <div className="font-semibold text-slate-900 dark:text-slate-100">
                  1. Install Ollama &amp; Pull Local Models
                </div>
                <pre className="p-3 rounded-lg bg-slate-900 text-slate-100 font-mono text-[11px] overflow-x-auto">
                  {`# Download from https://ollama.com/download, then run:\nollama serve\nollama pull llama3.2\nollama pull qwen2.5-coder:7b\nollama pull llava   # optional for local screen/image vision`}
                </pre>
              </div>

              <div className="space-y-1.5">
                <div className="font-semibold text-slate-900 dark:text-slate-100">
                  2A. Use Local Ollama with This Live App (Bridge Proxy)
                </div>
                <p>
                  Because this workspace runs in the cloud, it reaches your computer&apos;s{' '}
                  <code className="font-mono">127.0.0.1:11434</code> through your paired <strong>Desktop OS Bridge</strong>:
                </p>
                <pre className="p-3 rounded-lg bg-slate-900 text-slate-100 font-mono text-[11px] overflow-x-auto">
                  {`# Click "Pair Device" -> "Desktop OS Bridge" -> Download script, then:\nnpm install ws\nnode relay-bridge-${roomId.toLowerCase()}.mjs\n# Check "Bridge Proxy" in the Ollama bar and click "Detect Models"`}
                </pre>
              </div>

              <div className="space-y-1.5">
                <div className="font-semibold text-slate-900 dark:text-slate-100">
                  2B. Run Everything 100% Offline on Your Machine
                </div>
                <pre className="p-3 rounded-lg bg-slate-900 text-slate-100 font-mono text-[11px] overflow-x-auto">
                  {`npm install\nnpm run dev\n# Open http://localhost:3000 -> switch Engine to Ollama (no Bridge Proxy needed)`}
                </pre>
              </div>

              <div className="space-y-1.5 pt-2 border-t border-slate-200 dark:border-slate-800">
                <div className="font-semibold text-slate-900 dark:text-slate-100">
                  3. OpenRouter Setup (Free &amp; Cloud Models)
                </div>
                <p>
                  OpenRouter endpoints and free model routing are pre-configured on the server. Add{' '}
                  <code className="font-mono">OPENROUTER_API_KEY</code> (from{' '}
                  <code className="font-mono">openrouter.ai/keys</code>) into AI Studio <strong>Secrets</strong> (or{' '}
                  <code className="font-mono">.env</code> locally) — RAY activates it automatically without exposing any key in the browser.
                </p>
              </div>
            </div>
            <div className="px-5 py-3 border-t border-slate-200 dark:border-slate-800 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  onChangeEngineSettings((prev) => ({ ...prev, provider: 'ollama' }));
                  setShowOfflineGuide(false);
                }}
                className="px-3.5 py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg"
              >
                Use Ollama
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Capability Registry Drawer */}
      {showRegistry && (
        <div className="shrink-0 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 px-4 sm:px-6 py-4 max-h-72 overflow-y-auto">
          <div className="max-w-4xl mx-auto space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                  RAY Capability Registry ({capabilities.length})
                </h2>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  Safety-tiered capabilities · Sensitive actions pause for Ray’s explicit authorization.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowRegistry(false)}
                className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
              {capabilities.map((cap) => (
                <div
                  key={cap.name}
                  className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3 space-y-1"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">
                      {cap.name}
                    </span>
                    <span
                      className={`font-mono text-[10px] uppercase font-semibold ${
                        cap.safetyLevel === 'sensitive'
                          ? 'text-red-600 dark:text-red-400'
                          : cap.safetyLevel === 'moderate'
                          ? 'text-amber-700 dark:text-amber-400'
                          : 'text-emerald-700 dark:text-emerald-400'
                      }`}
                    >
                      {cap.safetyLevel}
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-600 dark:text-slate-400 leading-snug">
                    {cap.description}
                  </p>
                  <div className="text-[10px] font-mono text-slate-400">
                    {cap.category}
                    {cap.requiresConfirmation ? ' · confirmation required' : ''}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Live Voice & Wake Standby HUD Strip */}
      {(voiceState !== 'off' || liveError) && (
        <div className="shrink-0 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 px-4 sm:px-6 py-2.5">
          <div className="max-w-3xl mx-auto flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div className="flex items-center gap-3 min-w-0">
              <RayCoreFace
                compact
                voiceState={voiceState}
                bridgeConnected={bridgeMonitor?.status === 'connected' || hasBridgeOnline}
                ollamaRunning={bridgeMonitor?.ollamaRunning}
                onToggleVoice={() => (isLiveConnected ? onStopLiveVoice() : onStartLiveVoice())}
              />
              <div className="min-w-0 space-y-0.5 text-xs">
                {userCaption && (
                  <p className="text-slate-600 dark:text-slate-400 truncate">
                    <span className="font-medium text-slate-800 dark:text-slate-200">{userName}:</span>{' '}
                    {userCaption}
                  </p>
                )}
                {jarvisCaption && (
                  <p className="text-blue-700 dark:text-blue-300 truncate">
                    <span className="font-medium">RAY:</span> {jarvisCaption}
                  </p>
                )}
                {liveError && <p className="text-red-600 dark:text-red-400">{liveError}</p>}
              </div>
            </div>

            {isLiveConnected && (
              <button
                type="button"
                onClick={onEmergencyStop}
                className="px-2.5 py-1 text-xs font-semibold text-red-700 dark:text-red-300 border border-red-300 dark:border-red-800 rounded-md hover:bg-red-50 dark:hover:bg-red-950/40 whitespace-nowrap shrink-0 self-start sm:self-auto"
              >
                Interrupt
              </button>
            )}
          </div>
        </div>
      )}

      {/* Messages Viewport */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 sm:px-6 py-6">
        <div className="max-w-3xl mx-auto space-y-6">
          {/* Sensitive Action Confirmations */}
          {pendingConfirmations.map((req) => (
            <div
              key={req.id}
              className="rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50/70 dark:bg-amber-950/30 p-4 space-y-3"
            >
              <div className="flex items-start gap-2.5">
                <ShieldAlert className="w-4 h-4 text-amber-700 dark:text-amber-400 mt-0.5 shrink-0" />
                <div className="space-y-1">
                  <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                    Authorization Required · <span className="font-mono">{req.toolName}</span> ({req.safetyLevel.toUpperCase()})
                  </div>
                  <p className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed">
                    {req.summary}
                  </p>
                </div>
              </div>
              {req.secretPrompt && (
                <label className="block">
                  <span className="text-[11px] font-medium text-slate-600 dark:text-slate-300">{req.secretPrompt}</span>
                  <input
                    type="password"
                    autoComplete="off"
                    className="mt-1 w-full rounded-lg border border-amber-300 dark:border-amber-800 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-sm"
                    placeholder="Used once · never saved · not shown to the AI"
                    value={secretInputs[req.id] || ''}
                    onChange={(e) => setSecretInputs((p) => ({ ...p, [req.id]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void onResolveConfirmation(req.id, true, secretInputs[req.id] || undefined);
                    }}
                  />
                </label>
              )}
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => void onResolveConfirmation(req.id, false)}
                  className="px-3 py-1.5 text-xs font-medium border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 rounded-lg hover:bg-white dark:hover:bg-slate-900"
                >
                  Deny
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const secret = secretInputs[req.id] || undefined;
                    setSecretInputs((p) => {
                      const n = { ...p };
                      delete n[req.id];
                      return n;
                    });
                    void onResolveConfirmation(req.id, true, secret);
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg"
                >
                  <ShieldCheck className="w-3.5 h-3.5" />
                  <span>Authorize & Execute</span>
                </button>
              </div>
            </div>
          ))}

          {messages.length === 0 ? (
            <div className="py-8 space-y-8">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-6">
                <div className="space-y-2 max-w-xl">
                  <h1 className="font-display text-2xl sm:text-3xl font-bold text-slate-900 dark:text-slate-100 [text-wrap:balance]">
                    At your service, {userName}.
                  </h1>
                  <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
                    Talk or type. RAY researches in a real browser, uses the mouse on your PC and phone, runs coding agents, repairs your devices and learns something new every day. Say{' '}
                    <span className="font-medium text-slate-900 dark:text-slate-100">“Hey Ray”</span> or press{' '}
                    <kbd className="px-1.5 py-0.5 rounded border border-slate-300 dark:border-slate-700 text-[11px] font-mono">Ctrl+Alt+R</kbd> on your PC.
                  </p>
                </div>
                <div className="shrink-0">
                  <RayCoreFace
                    compact
                    voiceState={voiceState}
                    bridgeConnected={bridgeMonitor?.status === 'connected' || hasBridgeOnline}
                    ollamaRunning={bridgeMonitor?.ollamaRunning}
                    onToggleVoice={() => (isLiveConnected ? onStopLiveVoice() : onStartLiveVoice())}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {QUICK_PROMPTS.map((item) => (
                  <button
                    key={item.title}
                    type="button"
                    onClick={() => void handleSendMessage(item.prompt)}
                    className="text-left p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-blue-500/50 transition-colors space-y-1"
                  >
                    <div className="text-sm font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
                      <span>{item.title}</span>
                    </div>
                    <div className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                      {item.prompt}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex flex-col ${
                  msg.role === 'user' ? 'items-end' : 'items-start'
                }`}
              >
                {msg.role === 'user' ? (
                  <div className="max-w-[85%] rounded-xl bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 px-4 py-3 space-y-2">
                    {msg.attachments && msg.attachments.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {msg.attachments.map((att) =>
                          att.mimeType.startsWith('image/') ? (
                            <img
                              key={att.id}
                              src={att.dataUrl}
                              alt={att.name}
                              className="max-h-44 rounded-lg object-cover"
                            />
                          ) : (
                            <div
                              key={att.id}
                              className="text-xs font-mono px-2 py-1 rounded bg-white/10 dark:bg-slate-900/10"
                            >
                              {att.name}
                            </div>
                          )
                        )}
                      </div>
                    )}
                    <p className="text-sm whitespace-pre-wrap break-words">{msg.text}</p>
                  </div>
                ) : (
                  <div className="w-full rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 sm:p-5 space-y-3.5">
                    {msg.toolCalls && msg.toolCalls.length > 0 && (
                      <div className="space-y-1.5 pb-3 border-b border-slate-100 dark:border-slate-800">
                        <div className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                          Capability & Device Actions
                        </div>
                        <div className="space-y-1.5">
                          {msg.toolCalls.map((tc) => (
                            <div
                              key={tc.id}
                              className="rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-mono font-medium text-slate-900 dark:text-slate-100">
                                  {tc.name}
                                </span>
                                <span
                                  className={`font-medium ${
                                    tc.status === 'completed'
                                      ? 'text-emerald-700 dark:text-emerald-400'
                                      : tc.status === 'awaiting_confirmation'
                                      ? 'text-amber-700 dark:text-amber-400 inline-flex items-center gap-1'
                                      : tc.status === 'error'
                                      ? 'text-red-600 dark:text-red-400'
                                      : 'text-blue-600 dark:text-blue-400'
                                  }`}
                                >
                                  {tc.status === 'awaiting_confirmation' && (
                                    <AlertTriangle className="w-3 h-3" />
                                  )}
                                  {tc.status === 'running'
                                    ? 'Executing...'
                                    : tc.status === 'completed'
                                    ? 'Executed'
                                    : tc.status === 'awaiting_confirmation'
                                    ? 'Awaiting Confirmation'
                                    : 'Failed'}
                                </span>
                              </div>
                              {tc.result && (
                                <p className="text-slate-600 dark:text-slate-400 mt-1 break-words">
                                  {tc.result}
                                </p>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {msg.text ? (
                      <FormattedProse text={msg.text} />
                    ) : (
                      <div className="text-xs text-slate-500 dark:text-slate-400">
                        RAY is processing and coordinating devices...
                      </div>
                    )}

                    {msg.kind === 'error' && (
                      <div className="text-[11px] font-semibold text-red-600 dark:text-red-400 rounded-md bg-red-500/10 border border-red-500/30 px-2 py-1">
                        Request failed. Check the tool steps above for anything that already ran; retrying uses another engine.
                      </div>
                    )}
                    {msg.role === 'assistant' && msg.engineLabel && (
                      <div className="text-[10px] font-mono text-slate-400 dark:text-slate-500">answered by {msg.engineLabel}</div>
                    )}

                    {msg.sources && msg.sources.length > 0 && (
                      <div className="pt-3 border-t border-slate-100 dark:border-slate-800 space-y-1.5">
                        <div className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                          Web Sources
                        </div>
                        <ul className="space-y-1">
                          {msg.sources.map((src, idx) => (
                            <li key={idx} className="text-xs truncate">
                              <a
                                href={src.uri}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-blue-600 dark:text-blue-400 hover:underline"
                              >
                                {src.title}
                              </a>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {msg.text && (
                      <div className="pt-2 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void speakMessage(msg.id, msg.text)}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800"
                        >
                          <Volume2 className="w-3.5 h-3.5" />
                          <span>{speakingMsgId === msg.id ? 'Stop Audio' : 'Speak'}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            onPushToHandoff('RAY Briefing', msg.text);
                            setCopiedMsgId(msg.id);
                            window.setTimeout(() => setCopiedMsgId(null), 1600);
                          }}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800"
                        >
                          {copiedMsgId === msg.id ? (
                            <Check className="w-3.5 h-3.5" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                          <span>{copiedMsgId === msg.id ? 'Pushed to Handoff' : 'Send to Devices'}</span>
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Multimodal Composer */}
      <div className="shrink-0 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3 sm:p-4">
        <div className="max-w-3xl mx-auto space-y-2.5">
          {micError && (
            <div className="text-xs text-red-600 dark:text-red-400">{micError}</div>
          )}

          {pendingAttachments.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {pendingAttachments.map((att) => (
                <div
                  key={att.id}
                  className="relative flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 p-1.5 pr-7"
                >
                  {att.mimeType.startsWith('image/') ? (
                    <img
                      src={att.dataUrl}
                      alt={att.name}
                      className="w-10 h-10 rounded object-cover"
                    />
                  ) : (
                    <span className="text-xs font-mono px-1.5">{att.name}</span>
                  )}
                  <span className="text-xs text-slate-600 dark:text-slate-300 max-w-32 truncate">
                    {att.name}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setPendingAttachments((prev) => prev.filter((p) => p.id !== att.id))
                    }
                    aria-label={`Remove ${att.name}`}
                    className="absolute right-1.5 top-1.5 text-slate-400 hover:text-slate-800 dark:hover:text-slate-200"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-end gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,audio/*,application/pdf,text/plain"
              multiple
              className="hidden"
              onChange={handleFileAttach}
            />

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              aria-label="Attach image or file"
              title="Attach image, audio, or document"
              className="p-2.5 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0"
            >
              <Paperclip className="w-4 h-4" />
            </button>

            <button
              type="button"
              onClick={onOpenCamera}
              aria-label="Take camera photo"
              title="Capture photo from camera"
              className="p-2.5 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0"
            >
              <Camera className="w-4 h-4" />
            </button>

            <button
              type="button"
              onClick={() => void handleSnapScreenToComposer()}
              disabled={capturingScreen}
              aria-label="Capture screen frame"
              title={
                screenShare.isSharing
                  ? 'Attach live screen snapshot'
                  : hasBridgeOnline
                  ? 'Capture OS desktop screen via Bridge'
                  : 'Start live screen share'
              }
              className={`p-2.5 border rounded-lg shrink-0 transition-colors ${
                screenShare.isSharing
                  ? 'border-emerald-600/40 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300'
                  : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              <Monitor className="w-4 h-4" />
            </button>

            <button
              type="button"
              onClick={() => void handleMicClick()}
              disabled={isTranscribing}
              aria-label={isRecording ? 'Stop voice recording' : 'Start voice input'}
              title={isRecording ? 'Stop and transcribe' : 'Dictate command'}
              className={`p-2.5 border rounded-lg shrink-0 transition-colors ${
                isRecording
                  ? 'border-red-600 bg-red-600 text-white'
                  : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              {isRecording ? <Square className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
            </button>

            <textarea
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void handleSendMessage();
                }
              }}
              placeholder={
                isRecording
                  ? 'Listening... tap stop to transcribe'
                  : isTranscribing
                  ? 'Transcribing speech...'
                  : `Command RAY, ${userName}...`
              }
              className="flex-1 min-w-0 px-3.5 py-2.5 text-sm bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100 resize-none focus-visible:outline-2 focus-visible:outline-blue-600"
            />

            <button
              type="button"
              onClick={() => void handleSendMessage()}
              disabled={sending || (!input.trim() && pendingAttachments.length === 0)}
              aria-label="Send message"
              className="inline-flex items-center gap-1.5 px-4 py-2.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <Send className="w-4 h-4" />
              <span className="hidden sm:inline">{sending ? 'Running' : 'Send'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
