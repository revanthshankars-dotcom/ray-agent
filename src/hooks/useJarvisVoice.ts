import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConfirmationRequest, LiveVoiceState, VoicePersona } from '../types/relay';
import { playHudSound } from '../utils/hudAudio';
import { authFetch, ensureRoomBootstrap, getStoredRoomToken } from '../utils/roomAuth';

interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechRecognitionResultEvent) => void) | null;
  onerror: ((event: Event & { error?: string }) => void) | null;
  onend: (() => void) | null;
}

interface SpeechRecognitionResultEvent {
  resultIndex: number;
  results: {
    length: number;
    [idx: number]: {
      isFinal: boolean;
      0: { transcript: string; confidence: number };
    };
  };
}

function getSpeechRecognitionCtor(): (new () => SpeechRecognitionInstance) | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionInstance;
    webkitSpeechRecognition?: new () => SpeechRecognitionInstance;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

function float32ToPcmBase64(float32: Float32Array): string {
  const buf = new ArrayBuffer(float32.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64PcmToFloat32(base64: string): Float32Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const view = new DataView(bytes.buffer);
  const samples = new Float32Array(Math.floor(bytes.byteLength / 2));
  for (let i = 0; i < samples.length; i++) {
    samples[i] = view.getInt16(i * 2, true) / 32768;
  }
  return samples;
}

function matchesWakePhrase(transcript: string, sensitivity: number): boolean {
  const clean = transcript.toLowerCase().replace(/[^a-z\s]/g, ' ').trim();
  if (!clean) return false;
  if (/\b(hey|ok|okay|hi)\s+(ray|jarvis)\b/.test(clean) || /\b(ray|jarvis)\b/.test(clean)) {
    return true;
  }
  if (sensitivity >= 0.7) {
    return /\b(rei|rey|jarves|jarvice|jervis|jarviz)\b/.test(clean);
  }
  return false;
}

export function useJarvisVoice(params: {
  roomId: string;
  deviceName: string;
  voiceName: VoicePersona;
  wakeEnabled: boolean;
  wakeSensitivity: number;
  googleAccessToken?: string | null;
  notionToken?: string | null;
  onConfirmationRequired?: (req: ConfirmationRequest) => void;
}) {
  const [voiceState, setVoiceState] = useState<LiveVoiceState>(
    params.wakeEnabled ? 'standby' : 'off'
  );
  const [userCaption, setUserCaption] = useState('');
  const [jarvisCaption, setJarvisCaption] = useState('');
  const [liveError, setLiveError] = useState<string | null>(null);
  const [wakeSupported] = useState(() => Boolean(getSpeechRecognitionCtor()));

  const liveActiveRef = useRef(false);
  const wakeEnabledRef = useRef(params.wakeEnabled);
  wakeEnabledRef.current = params.wakeEnabled;
  const sensitivityRef = useRef(params.wakeSensitivity);
  sensitivityRef.current = params.wakeSensitivity;
  const googleTokenRef = useRef(params.googleAccessToken || '');
  googleTokenRef.current = params.googleAccessToken || '';
  const notionTokenRef = useRef(params.notionToken || '');
  notionTokenRef.current = params.notionToken || '';
  const confirmationCbRef = useRef(params.onConfirmationRequired);
  confirmationCbRef.current = params.onConfirmationRequired;

  const wsRef = useRef<WebSocket | null>(null);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const inputCtxRef = useRef<AudioContext | null>(null);
  const outputCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());

  const clearPlaybackQueue = useCallback(() => {
    for (const src of activeSourcesRef.current) {
      try {
        src.stop();
      } catch {
        // Already stopped
      }
    }
    activeSourcesRef.current.clear();
    nextStartTimeRef.current = 0;
  }, []);

  const schedulePcmChunk = useCallback((base64Audio: string) => {
    let outCtx = outputCtxRef.current;
    if (!outCtx || outCtx.state === 'closed') {
      outCtx = new AudioContext({ sampleRate: 24000 });
      outputCtxRef.current = outCtx;
    }
    if (outCtx.state === 'suspended') {
      void outCtx.resume();
    }

    const float32 = base64PcmToFloat32(base64Audio);
    if (float32.length === 0) return;

    const buffer = outCtx.createBuffer(1, float32.length, 24000);
    buffer.copyToChannel(new Float32Array(float32), 0);

    const source = outCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(outCtx.destination);

    const now = outCtx.currentTime;
    const startAt = Math.max(now, nextStartTimeRef.current);
    nextStartTimeRef.current = startAt + buffer.duration;

    activeSourcesRef.current.add(source);
    source.onended = () => {
      activeSourcesRef.current.delete(source);
    };
    source.start(startAt);
  }, []);

  const stopWakeListener = useCallback(() => {
    const rec = recognitionRef.current;
    recognitionRef.current = null;
    if (rec) {
      rec.onresult = null;
      rec.onend = null;
      rec.onerror = null;
      try {
        rec.abort();
      } catch {
        // Ignore
      }
    }
  }, []);

  const stopLiveSession = useCallback(
    (returnToStandby = true) => {
      liveActiveRef.current = false;
      clearPlaybackQueue();

      try {
        processorRef.current?.disconnect();
      } catch {
        // Ignore
      }
      processorRef.current = null;

      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;

      if (inputCtxRef.current && inputCtxRef.current.state !== 'closed') {
        void inputCtxRef.current.close();
      }
      inputCtxRef.current = null;

      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.close();
      }
      wsRef.current = null;

      setVoiceState(returnToStandby && wakeEnabledRef.current ? 'standby' : 'off');
    },
    [clearPlaybackQueue]
  );

  const startLiveSession = useCallback(
    async (initialPrompt?: string) => {
      if (liveActiveRef.current) return;
      setLiveError(null);
      stopWakeListener();
      liveActiveRef.current = true;
      setVoiceState('connecting');
      setUserCaption('');
      setJarvisCaption('');
      playHudSound('wake');

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (!liveActiveRef.current) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        micStreamRef.current = stream;

        const inputCtx = new AudioContext({ sampleRate: 16000 });
        inputCtxRef.current = inputCtx;

        if (!outputCtxRef.current || outputCtxRef.current.state === 'closed') {
          outputCtxRef.current = new AudioContext({ sampleRate: 24000 });
        }

        let rToken = getStoredRoomToken(params.roomId);
        if (!rToken) {
          const boot = await ensureRoomBootstrap(params.roomId);
          rToken = boot.roomToken || '';
        }

        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const url = `${proto}//${window.location.host}/live-jarvis?room=${encodeURIComponent(
          params.roomId
        )}&token=${encodeURIComponent(rToken)}&device=${encodeURIComponent(
          params.deviceName
        )}&voice=${encodeURIComponent(params.voiceName)}`;

        const ws = new WebSocket(url);
        wsRef.current = ws;

        ws.onopen = () => {
          if (!liveActiveRef.current) {
            ws.close();
            return;
          }
          setVoiceState('listening');

          if (googleTokenRef.current || notionTokenRef.current) {
            ws.send(
              JSON.stringify({
                type: 'context',
                googleAccessToken: googleTokenRef.current,
                notionToken: notionTokenRef.current,
              })
            );
          }

          const source = inputCtx.createMediaStreamSource(stream);
          const processor = inputCtx.createScriptProcessor(4096, 1, 1);
          processorRef.current = processor;

          processor.onaudioprocess = (e) => {
            if (!liveActiveRef.current || ws.readyState !== WebSocket.OPEN) return;
            const pcmBase64 = float32ToPcmBase64(e.inputBuffer.getChannelData(0));
            ws.send(JSON.stringify({ type: 'audio', data: pcmBase64 }));
          };

          source.connect(processor);
          processor.connect(inputCtx.destination);

          if (initialPrompt) {
            ws.send(JSON.stringify({ type: 'text', text: initialPrompt }));
          }
        };

        ws.onmessage = (evt) => {
          try {
            const msg = JSON.parse(evt.data as string) as {
              type?: string;
              data?: unknown;
              text?: string;
              status?: string;
              interrupted?: boolean;
              message?: string;
            };
            if (msg.type === 'audio' && typeof msg.data === 'string') {
              setVoiceState('speaking');
              schedulePcmChunk(msg.data);
            } else if (msg.type === 'inputTranscript' && msg.text) {
              setUserCaption((prev) => `${prev} ${msg.text}`.trim().slice(-240));
            } else if (msg.type === 'outputTranscript' && msg.text) {
              setJarvisCaption((prev) => `${prev} ${msg.text}`.trim().slice(-320));
            } else if (msg.type === 'status') {
              if (msg.status === 'in_progress') {
                setVoiceState((prev) => (prev === 'speaking' ? 'speaking' : 'thinking'));
              } else if (msg.status === 'idle') {
                setVoiceState('listening');
              }
            } else if (msg.type === 'interrupted') {
              clearPlaybackQueue();
              setVoiceState('listening');
            } else if (msg.type === 'confirmation_required' && msg.data) {
              confirmationCbRef.current?.(msg.data as ConfirmationRequest);
            } else if (msg.type === 'error') {
              setLiveError(msg.message || 'Live voice session error');
            }
          } catch {
            // Ignore invalid message
          }
        };

        ws.onclose = () => {
          if (liveActiveRef.current) {
            stopLiveSession(true);
          }
        };
      } catch (err) {
        setLiveError(err instanceof Error ? err.message : 'Unable to start microphone for Live Voice');
        stopLiveSession(true);
      }
    },
    [
      clearPlaybackQueue,
      params.deviceName,
      params.roomId,
      params.voiceName,
      schedulePcmChunk,
      stopLiveSession,
      stopWakeListener,
    ]
  );

  const emergencyStop = useCallback(async () => {
    clearPlaybackQueue();
    playHudSound('blip');
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'interrupt' }));
    }
    try {
      await authFetch('/api/jarvis/interrupt', params.roomId, {
        method: 'POST',
        body: JSON.stringify({ roomId: params.roomId }),
      });
    } catch {
      // Ignore network error during interrupt
    }
    if (liveActiveRef.current) {
      stopLiveSession(true);
    }
    setVoiceState(wakeEnabledRef.current ? 'standby' : 'off');
  }, [clearPlaybackQueue, params.roomId, stopLiveSession]);

  // Stage 1: Low-power Wake-Word Standby loop ("Hey Jarvis" / "Jarvis")
  useEffect(() => {
    if (!params.wakeEnabled) {
      stopWakeListener();
      if (!liveActiveRef.current) setVoiceState('off');
      return;
    }

    if (liveActiveRef.current) return;

    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      setVoiceState('off');
      return;
    }

    setVoiceState('standby');
    let cancelled = false;

    const startStandby = () => {
      if (cancelled || !wakeEnabledRef.current || liveActiveRef.current) return;
      const rec = new Ctor();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = 'en-US';
      recognitionRef.current = rec;

      rec.onresult = (event) => {
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const transcript = event.results[i]?.[0]?.transcript || '';
          if (/\b((ray|jarvis)\s*,?\s*stop|stop\s*,?\s*(ray|jarvis))\b/i.test(transcript)) {
            void emergencyStop();
            return;
          }
          if (matchesWakePhrase(transcript, sensitivityRef.current)) {
            const afterWake = transcript
              .replace(/.*?\b(?:hey|ok|okay|hi)?\s*(?:ray|jarvis)\b/i, '')
              .trim();
            void startLiveSession(afterWake.length > 3 ? afterWake : undefined);
            return;
          }
        }
      };

      rec.onerror = (evt) => {
        if (evt.error === 'not-allowed' || evt.error === 'service-not-allowed') {
          setLiveError('Microphone permission denied for Wake Standby.');
          cancelled = true;
        }
      };

      rec.onend = () => {
        if (!cancelled && wakeEnabledRef.current && !liveActiveRef.current) {
          window.setTimeout(startStandby, 400);
        }
      };

      try {
        rec.start();
      } catch {
        // Already started or blocked before user gesture
      }
    };

    startStandby();

    return () => {
      cancelled = true;
      stopWakeListener();
    };
  }, [params.wakeEnabled, voiceState === 'standby', emergencyStop, startLiveSession, stopWakeListener]);

  useEffect(() => {
    return () => {
      stopWakeListener();
      stopLiveSession(false);
    };
  }, [stopLiveSession, stopWakeListener]);

  return {
    voiceState,
    userCaption,
    jarvisCaption,
    liveError,
    wakeSupported,
    startLiveSession,
    stopLiveSession,
    emergencyStop,
  };
}
