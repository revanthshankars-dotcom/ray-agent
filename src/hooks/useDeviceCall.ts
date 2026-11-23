import { useCallback, useEffect, useRef, useState } from 'react';
import { callBus } from '../services/callBus';
import { authFetch } from '../utils/roomAuth';
import type { CallPayload } from '../types/relay';

export type CallPhase = 'idle' | 'ringing-in' | 'calling-out' | 'connecting' | 'connected' | 'ended';

export interface CallState {
  phase: CallPhase;
  callId?: string;
  kind?: 'ray' | 'peer';
  peerName?: string;
  peerDeviceId?: string;
  message?: string;
  startedAt?: number;
  muted: boolean;
  error?: string;
}

type Signal = { type: string; callId?: string; from?: string; fromName?: string; sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };

/** Ringtone: classic double ring, generated with WebAudio (no files). */
function createRingtone() {
  let ctx: AudioContext | null = null;
  let timer: number | null = null;
  const burst = () => {
    if (!ctx) return;
    const t = ctx.currentTime;
    for (const offset of [0, 0.5]) {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + offset);
      g.gain.exponentialRampToValueAtTime(0.25, t + offset + 0.03);
      g.gain.setValueAtTime(0.25, t + offset + 0.38);
      g.gain.exponentialRampToValueAtTime(0.0001, t + offset + 0.42);
      g.connect(ctx.destination);
      for (const f of [440, 480]) {
        const o = ctx.createOscillator();
        o.frequency.value = f;
        o.connect(g);
        o.start(t + offset);
        o.stop(t + offset + 0.45);
      }
    }
    if ('vibrate' in navigator) navigator.vibrate?.([400, 200, 400]);
  };
  return {
    start() {
      try {
        ctx = new AudioContext();
        burst();
        timer = window.setInterval(burst, 3000);
      } catch {
        // autoplay blocked – the screen still shows the call
      }
    },
    stop() {
      if (timer) window.clearInterval(timer);
      timer = null;
      void ctx?.close();
      ctx = null;
      if ('vibrate' in navigator) navigator.vibrate?.(0);
    },
  };
}

/**
 * Calls between RAY and Ray, and live WebRTC audio calls between Ray's devices.
 * Signalling goes through the hub ('call:signal'); media is peer-to-peer (TURN when configured).
 */
export function useDeviceCall(params: {
  roomId: string;
  myDeviceId: string;
  myName: string;
  sendEvent: (event: string, data: Record<string, unknown>) => boolean;
  /** Called when Ray answers a RAY call: start a voice conversation that opens with this message. */
  onAnswerRayCall: (message: string) => void;
}) {
  const [state, setState] = useState<CallState>({ phase: 'idle', muted: false });
  const stateRef = useRef(state);
  stateRef.current = state;
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const ringRef = useRef(createRingtone());
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const paramsRef = useRef(params);
  paramsRef.current = params;

  // Missed call / no answer after 45 s.
  useEffect(() => {
    if (state.phase !== 'ringing-in' && state.phase !== 'calling-out') return;
    const t = window.setTimeout(() => {
      const st = stateRef.current;
      if (st.phase === 'calling-out' && st.peerDeviceId) signal(st.peerDeviceId, { type: 'hangup', callId: st.callId });
      cleanup('ended', st.phase === 'ringing-in' ? 'Missed call' : 'No answer');
    }, 45000);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase, state.callId]);

  const signal = useCallback((to: string, data: Signal) => {
    paramsRef.current.sendEvent('call:signal', { ...data, to } as unknown as Record<string, unknown>);
  }, []);

  const cleanup = useCallback((phase: CallPhase = 'ended', error?: string) => {
    ringRef.current.stop();
    pcRef.current?.close();
    pcRef.current = null;
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
    pendingIceRef.current = [];
    setState((s) => ({ ...s, phase, error, muted: false }));
    if (phase === 'ended') window.setTimeout(() => setState({ phase: 'idle', muted: false }), 1800);
  }, []);

  const createPeer = useCallback(
    async (peerId: string, callId: string) => {
      let iceServers: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
      try {
        const r = await authFetch(`/api/call/ice?room=${encodeURIComponent(paramsRef.current.roomId)}`, paramsRef.current.roomId);
        const j = (await r.json()) as { iceServers?: RTCIceServer[] };
        if (j.iceServers?.length) iceServers = j.iceServers;
      } catch {
        // STUN fallback
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      localStreamRef.current = stream;
      const pc = new RTCPeerConnection({ iceServers });
      pcRef.current = pc;
      stream.getTracks().forEach((t) => pc.addTrack(t, stream));
      pc.onicecandidate = (e) => {
        if (e.candidate) signal(peerId, { type: 'ice', callId, candidate: e.candidate.toJSON() });
      };
      pc.ontrack = (e) => {
        if (!remoteAudioRef.current) remoteAudioRef.current = new Audio();
        remoteAudioRef.current.autoplay = true;
        remoteAudioRef.current.srcObject = e.streams[0];
        void remoteAudioRef.current.play().catch(() => {});
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') setState((s) => ({ ...s, phase: 'connected', startedAt: Date.now() }));
        if (pc.connectionState === 'failed') cleanup('ended', 'Connection failed (network blocked a direct link).');
      };
      return pc;
    },
    [cleanup, signal]
  );

  // Incoming rings + signalling
  useEffect(() => {
    const onRing = (e: Event) => {
      const c = (e as CustomEvent).detail as CallPayload;
      if (stateRef.current.phase !== 'idle' && stateRef.current.phase !== 'ended') return; // busy
      if (c.kind === 'peer' && c.fromDeviceId === paramsRef.current.myDeviceId) return; // own ring
      setState({ phase: 'ringing-in', callId: c.callId, kind: c.kind, peerName: c.fromName, peerDeviceId: c.fromDeviceId, message: c.message, muted: false });
      ringRef.current.start();
    };
    const onSignal = async (e: Event) => {
      const sig = (e as CustomEvent).detail as Signal;
      const st = stateRef.current;
      try {
        if (sig.type === 'accept') {
          // Our ring was answered (we are the caller — even if the call was started by voice on the server).
          ringRef.current.stop();
          setState({ phase: 'connecting', callId: sig.callId, kind: 'peer', peerName: sig.fromName, peerDeviceId: sig.from, muted: false });
          const pc = await createPeer(sig.from!, sig.callId!);
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          signal(sig.from!, { type: 'offer', callId: sig.callId, sdp: offer });
        } else if (sig.type === 'offer' && pcRef.current) {
          await pcRef.current.setRemoteDescription(sig.sdp!);
          for (const c of pendingIceRef.current) await pcRef.current.addIceCandidate(c);
          pendingIceRef.current = [];
          const answer = await pcRef.current.createAnswer();
          await pcRef.current.setLocalDescription(answer);
          signal(sig.from!, { type: 'answer', callId: sig.callId, sdp: answer });
        } else if (sig.type === 'answer' && pcRef.current) {
          await pcRef.current.setRemoteDescription(sig.sdp!);
          for (const c of pendingIceRef.current) await pcRef.current.addIceCandidate(c);
          pendingIceRef.current = [];
        } else if (sig.type === 'ice' && sig.candidate) {
          if (pcRef.current?.remoteDescription) await pcRef.current.addIceCandidate(sig.candidate);
          else pendingIceRef.current.push(sig.candidate);
        } else if (sig.type === 'hangup' || sig.type === 'decline' || sig.type === 'unavailable') {
          if (st.phase !== 'idle') cleanup('ended', sig.type === 'decline' ? 'Declined' : sig.type === 'unavailable' ? 'Device is offline' : undefined);
        }
      } catch (err) {
        cleanup('ended', err instanceof Error ? err.message : 'Call error');
      }
    };
    callBus.addEventListener('ring', onRing);
    callBus.addEventListener('signal', onSignal);
    return () => {
      callBus.removeEventListener('ring', onRing);
      callBus.removeEventListener('signal', onSignal);
    };
  }, [cleanup, createPeer, signal]);

  // Opened from a push / bridge notification: /?answer=<callId>&kind=…&from=…&m=…
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const callId = q.get('answer');
    if (!callId) return;
    const kind = (q.get('kind') as 'ray' | 'peer') || 'ray';
    window.history.replaceState(null, '', window.location.pathname);
    const t = window.setTimeout(() => {
      if (stateRef.current.phase === 'idle') {
        setState({ phase: 'ringing-in', callId, kind, peerDeviceId: q.get('from') || undefined, peerName: kind === 'ray' ? 'RAY' : 'Your device', message: q.get('m') || undefined, muted: false });
      }
    }, 1500);
    return () => window.clearTimeout(t);
  }, []);

  const accept = useCallback(async () => {
    const st = stateRef.current;
    ringRef.current.stop();
    if (st.kind === 'ray') {
      setState({ phase: 'idle', muted: false });
      paramsRef.current.onAnswerRayCall(st.message || '');
      return;
    }
    if (!st.peerDeviceId || !st.callId) return cleanup('ended', 'Caller unknown');
    setState((s) => ({ ...s, phase: 'connecting' }));
    try {
      await createPeer(st.peerDeviceId, st.callId);
      signal(st.peerDeviceId, { type: 'accept', callId: st.callId });
    } catch (err) {
      cleanup('ended', err instanceof Error ? err.message : 'Microphone unavailable');
    }
  }, [cleanup, createPeer, signal]);

  const decline = useCallback(() => {
    const st = stateRef.current;
    if (st.kind === 'peer' && st.peerDeviceId) signal(st.peerDeviceId, { type: 'decline', callId: st.callId });
    cleanup('ended');
  }, [cleanup, signal]);

  const hangup = useCallback(() => {
    const st = stateRef.current;
    if (st.peerDeviceId) signal(st.peerDeviceId, { type: 'hangup', callId: st.callId });
    cleanup('ended');
  }, [cleanup, signal]);

  const toggleMute = useCallback(() => {
    const next = !stateRef.current.muted;
    localStreamRef.current?.getAudioTracks().forEach((t) => (t.enabled = !next));
    setState((s) => ({ ...s, muted: next }));
  }, []);

  /** Ring another of Ray's devices from this one. */
  const callDevice = useCallback(async (targetDeviceId: string, targetName: string) => {
    const callId = crypto.randomUUID();
    setState({ phase: 'calling-out', callId, kind: 'peer', peerName: targetName, peerDeviceId: targetDeviceId, muted: false });
    try {
      await authFetch('/api/device/command', paramsRef.current.roomId, {
        method: 'POST',
        body: JSON.stringify({
          roomId: paramsRef.current.roomId,
          type: 'call',
          targetDevice: targetDeviceId,
          payload: { callId, kind: 'peer', fromName: paramsRef.current.myName, fromDeviceId: paramsRef.current.myDeviceId, createdAt: Date.now() },
        }),
      });
    } catch {
      cleanup('ended', 'Could not reach the hub');
    }
  }, [cleanup]);

  return { state, accept, decline, hangup, toggleMute, callDevice };
}
