import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConfirmationRequest, EngineSettings, LiveVoiceState, VoicePersona } from '../types/relay';
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

/** Pick a natural local voice for the free (browser) speech pipeline. */
function pickBrowserVoice(): SpeechSynthesisVoice | null {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null;
  const voices = window.speechSynthesis.getVoices();
  const prefs = [/Google UK English Male/i, /Daniel/i, /en-GB.*(Male|Ryan|George)/i, /Microsoft (Ryan|George|Guy)/i, /en-GB/i, /Google US English/i, /en-US/i];
  for (const re of prefs) {
    const v = voices.find((x) => re.test(`${x.name} ${x.lang}`));
    if (v) return v;
  }
  return voices.find((v) => v.lang?.startsWith('en')) || voices[0] || null;
}

function cleanForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' (code omitted) ')
    .replace(/https?:\/\/\S+/g, 'the link')
    .replace(/[#*_`>|~\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 900);
}

export type VoicePipeline = 'live' | 'classic';

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
  engineSettings?: EngineSettings;
}) {
  const [voiceState, setVoiceState] = useState<LiveVoiceState>(
    params.wakeEnabled ? 'standby' : 'off'
  );
  const [userCaption, setUserCaption] = useState('');
  const [jarvisCaption, setJarvisCaption] = useState('');
  const [liveError, setLiveError] = useState<string | null>(null);
  const [wakeSupported] = useState(() => Boolean(getSpeechRecognitionCtor()));
  const [pipeline, setPipeline] = useState<VoicePipeline>('live');
  const engineRef = useRef(params.engineSettings);
  engineRef.current = params.engineSettings;
  const deviceNameRef = useRef(params.deviceName);
  deviceNameRef.current = params.deviceName;
  // Free fallback pipeline state
  const classicActiveRef = useRef(false);
  const classicRecRef = useRef<SpeechRecognitionInstance | null>(null);
  const classicHistoryRef = useRef<Array<{ role: 'user' | 'assistant'; text: string }>>([]);
  const classicAbortRef = useRef<AbortController | null>(null);
  const liveFailedUntilRef = useRef(0);
  const voiceCapsRef = useRef<{ live: boolean; serverTts?: boolean } | null>(null);

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
      classicActiveRef.current = false;
      clearPlaybackQueue();
      classicAbortRef.current?.abort();
      classicAbortRef.current = null;
      const crec = classicRecRef.current;
      classicRecRef.current = null;
      if (crec) {
        crec.onresult = null;
        crec.onend = null;
        crec.onerror = null;
        try {
          crec.abort();
        } catch {
          // ignore
        }
      }
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();

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

  /**
   * FREE voice pipeline — works with any engine (Groq, Cerebras, Ollama…), no Gemini needed:
   * browser speech-to-text → /api/ai/chat (auto-router + tools) → browser text-to-speech,
   * then keeps listening for follow-ups until Ray goes quiet.
   */
  const startClassicSession = useCallback(
    async (initialPrompt?: string) => {
      const Ctor = getSpeechRecognitionCtor();
      stopWakeListener();
      liveActiveRef.current = true;
      classicActiveRef.current = true;
      setPipeline('classic');
      setLiveError(null);
      setUserCaption('');
      setJarvisCaption('');
      playHudSound('wake');
      let silentTurns = 0;

      // Prefer the server voice (Fish Audio / Gemini TTS) — fall back to the browser voice.
      const speakBrowser = (text: string) =>
        new Promise<void>((resolve) => {
          if (!('speechSynthesis' in window) || !text) return resolve();
          const utter = new SpeechSynthesisUtterance(cleanForSpeech(text));
          const v = pickBrowserVoice();
          if (v) utter.voice = v;
          utter.rate = 1.03;
          utter.pitch = 0.95;
          utter.onend = () => resolve();
          utter.onerror = () => resolve();
          window.speechSynthesis.cancel();
          window.speechSynthesis.speak(utter);
        });

      const speak = async (text: string) => {
        if (!text) return;
        if (voiceCapsRef.current?.serverTts) {
          try {
            const r = await authFetch('/api/ai/tts', params.roomId, {
              method: 'POST',
              body: JSON.stringify({ text: cleanForSpeech(text), voiceName: params.voiceName }),
            });
            const d = (await r.json()) as { audioBase64?: string; mimeType?: string };
            if (r.ok && d.audioBase64 && classicActiveRef.current) {
              await new Promise<void>((resolve) => {
                const audio = new Audio(`data:${d.mimeType || 'audio/mpeg'};base64,${d.audioBase64}`);
                audio.onended = () => resolve();
                audio.onerror = () => resolve();
                audio.play().catch(() => resolve());
              });
              return;
            }
          } catch {
            // fall back to the browser voice
          }
        }
        await speakBrowser(text);
      };

      const ask = async (text: string) => {
        if (!classicActiveRef.current) return;
        if (/^\s*(stop|cancel|never ?mind|that'?s all|goodbye|bye)\b/i.test(text)) {
          await speak('Standing by, Ray.');
          stopLiveSession(true);
          return;
        }
        setVoiceState('thinking');
        setJarvisCaption('');
        const controller = new AbortController();
        classicAbortRef.current = controller;
        let reply = '';
        try {
          const resp = await authFetch(
            '/api/ai/chat',
            params.roomId,
            {
              method: 'POST',
              signal: controller.signal,
              body: JSON.stringify({
                roomId: params.roomId,
                sourceDeviceName: deviceNameRef.current,
                message: `${text}\n\n(Voice conversation: reply in 1-3 short spoken sentences.)`,
                history: classicHistoryRef.current.slice(-8),
                preferredVoice: params.voiceName,
                engine: engineRef.current || { provider: 'auto' },
              }),
            },
            { googleAccessToken: googleTokenRef.current || null, notionToken: notionTokenRef.current || null }
          );
          if (!resp.ok || !resp.body) throw new Error(`Voice request failed (${resp.status})`);
          const reader = resp.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const chunks = buffer.split('\n\n');
            buffer = chunks.pop() || '';
            for (const chunk of chunks) {
              const line = chunk.split('\n').find((l) => l.startsWith('data: '));
              if (!line) continue;
              const evt = JSON.parse(line.slice(6)) as { type: string; data: unknown };
              if (evt.type === 'text') {
                reply = String(evt.data || '');
                setJarvisCaption(reply.slice(-320));
              } else if (evt.type === 'error') {
                reply = `Sorry Ray, ${String(evt.data || 'something went wrong')}`;
              } else if (evt.type === 'confirmation_required') {
                confirmationCbRef.current?.(evt.data as ConfirmationRequest);
              }
            }
          }
        } catch (err) {
          if (!classicActiveRef.current) return;
          reply = err instanceof Error && err.name !== 'AbortError' ? `I couldn't reach my engines, Ray. ${err.message}` : '';
        }
        if (!classicActiveRef.current) return;
        classicHistoryRef.current.push({ role: 'user', text }, { role: 'assistant', text: reply });
        classicHistoryRef.current = classicHistoryRef.current.slice(-16);
        setVoiceState('speaking');
        await speak(reply);
        if (classicActiveRef.current) listen();
      };

      const listen = () => {
        if (!classicActiveRef.current) return;
        if (!Ctor) {
          setLiveError('This browser has no speech recognition. Use Chrome/Edge, or type to RAY.');
          stopLiveSession(true);
          return;
        }
        setVoiceState('listening');
        setUserCaption('');
        const rec = new Ctor();
        rec.continuous = false;
        rec.interimResults = true;
        rec.lang = navigator.language || 'en-US';
        classicRecRef.current = rec;
        let finalText = '';
        rec.onresult = (event) => {
          let interim = '';
          for (let i = event.resultIndex; i < event.results.length; i++) {
            const r = event.results[i];
            if (r.isFinal) finalText += r[0].transcript;
            else interim += r[0].transcript;
          }
          setUserCaption(`${finalText} ${interim}`.trim().slice(-240));
        };
        rec.onerror = (evt) => {
          if (evt.error === 'not-allowed' || evt.error === 'service-not-allowed') {
            setLiveError('Microphone permission denied. Allow the mic for RAY in your browser settings.');
            stopLiveSession(true);
          }
        };
        rec.onend = () => {
          if (classicRecRef.current !== rec || !classicActiveRef.current) return;
          classicRecRef.current = null;
          const said = finalText.trim();
          if (said) {
            silentTurns = 0;
            void ask(said);
          } else if (++silentTurns <= 1) {
            listen();
          } else {
            playHudSound('blip');
            stopLiveSession(true); // Ray went quiet -> back to "Hey Ray" standby
          }
        };
        try {
          rec.start();
        } catch {
          window.setTimeout(listen, 300);
        }
      };

      if (initialPrompt && initialPrompt.trim().length > 2) void ask(initialPrompt.trim());
      else listen();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [params.roomId, params.voiceName, stopWakeListener]
  );

  const startLiveSession = useCallback(
    async (initialPrompt?: string) => {
      if (liveActiveRef.current) return;
      // Decide pipeline: Gemini Live (best) when available, else the free classic pipeline.
      if (!voiceCapsRef.current) {
        try {
          voiceCapsRef.current = (await fetch('/api/voice/capabilities').then((r) => r.json())) as { live: boolean; serverTts?: boolean };
        } catch {
          voiceCapsRef.current = { live: false };
        }
      }
      if (!voiceCapsRef.current.live || Date.now() < liveFailedUntilRef.current) {
        void startClassicSession(initialPrompt);
        return;
      }
      setPipeline('live');
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
        let gotLiveData = false;
        const openedAt = Date.now();
        const fallbackToClassic = (reason: string) => {
          if (gotLiveData || !liveActiveRef.current) return;
          liveFailedUntilRef.current = Date.now() + 10 * 60_000; // don't retry Live for 10 min
          stopLiveSession(false);
          setLiveError(`${reason} — switched to RAY's free voice pipeline.`);
          void startClassicSession(initialPrompt);
        };

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
            if (msg.type !== 'error' && msg.type !== 'closed') gotLiveData = true;
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
              if (!gotLiveData && Date.now() - openedAt < 15000) fallbackToClassic(msg.message || 'Gemini Live unavailable');
              else setLiveError(msg.message || 'Live voice session error');
            }
          } catch {
            // Ignore invalid message
          }
        };

        ws.onclose = () => {
          if (liveActiveRef.current && !gotLiveData && Date.now() - openedAt < 15000) {
            fallbackToClassic('Gemini Live closed the session');
            return;
          }
          if (liveActiveRef.current && !classicActiveRef.current) {
            stopLiveSession(true);
          }
        };
      } catch (err) {
        setLiveError(err instanceof Error ? err.message : 'Unable to start microphone for Live Voice');
        stopLiveSession(true);
      }
    },
    [
      startClassicSession,
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
        // Blocked before a user gesture: retry on the first tap/key anywhere.
        const retry = () => {
          window.removeEventListener('pointerdown', retry);
          window.removeEventListener('keydown', retry);
          if (!cancelled) startStandby();
        };
        window.addEventListener('pointerdown', retry, { once: true });
        window.addEventListener('keydown', retry, { once: true });
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
    pipeline,
  };
}
