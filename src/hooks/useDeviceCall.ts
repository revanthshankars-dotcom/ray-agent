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
  /** Video call requested (ring shows "Video call"). */
  video?: boolean;
  /** This device is sending camera video. */
  camOn?: boolean;
  /** The other side is sending camera video. */
  remoteCamOn?: boolean;
  facing?: 'user' | 'environment';
  /** A RAY ring that carries a question: answering opens it. */
  askId?: string;
}

type Signal = { type: string; callId?: string; from?: string; fromName?: string; sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit; on?: boolean; video?: boolean };

const VIDEO_CONSTRAINTS = (facing: 'user' | 'environment'): MediaTrackConstraints => ({ facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24 } });

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
 * Calls between RAY and Ray, and live WebRTC voice / video calls between Ray's devices.
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
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
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
    setLocalStream(null);
    setRemoteStream(null);
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
    pendingIceRef.current = [];
    setState((s) => ({ ...s, phase, error, muted: false, camOn: false, remoteCamOn: false }));
    if (phase === 'ended') window.setTimeout(() => setState({ phase: 'idle', muted: false }), 1800);
  }, []);

  const createPeer = useCallback(
    async (peerId: string, callId: string, withVideo = false, isCaller = false) => {
      let iceServers: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
      try {
        const r = await authFetch(`/api/call/ice?room=${encodeURIComponent(paramsRef.current.roomId)}`, paramsRef.current.roomId);
        const j = (await r.json()) as { iceServers?: RTCIceServer[] };
        if (j.iceServers?.length) iceServers = j.iceServers;
      } catch {
        // STUN fallback
      }
      const audio = { echoCancellation: true, noiseSuppression: true };
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio, video: withVideo ? VIDEO_CONSTRAINTS('user') : false });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({ audio }); // no camera / camera refused → voice only
      }
      localStreamRef.current = stream;
      setLocalStream(stream);
      const camOn = stream.getVideoTracks().length > 0;
      setState((s) => ({ ...s, camOn, facing: 'user' }));
      const pc = new RTCPeerConnection({ iceServers });
      pcRef.current = pc;
      stream.getTracks().forEach((t) => pc.addTrack(t, stream));
      // Always negotiate a video channel so either side can switch the camera on mid-call.
      if (isCaller && !camOn) pc.addTransceiver('video', { direction: 'sendrecv' });
      pc.onicecandidate = (e) => {
        if (e.candidate) signal(peerId, { type: 'ice', callId, candidate: e.candidate.toJSON() });
      };
      pc.ontrack = (e) => {
        const remote = e.streams[0] || new MediaStream([e.track]);
        if (!remoteAudioRef.current) remoteAudioRef.current = new Audio();
        remoteAudioRef.current.autoplay = true;
        remoteAudioRef.current.srcObject = remote;
        void remoteAudioRef.current.play().catch(() => {});
        setRemoteStream(remote);
        if (e.track.kind === 'video') {
          const upd = () => setState((s) => ({ ...s, remoteCamOn: !e.track.muted && e.track.readyState === 'live' }));
          e.track.onmute = upd;
          e.track.onunmute = upd;
          e.track.onended = upd;
          upd();
        }
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
      setState({ phase: 'ringing-in', callId: c.callId, kind: c.kind, peerName: c.fromName, peerDeviceId: c.fromDeviceId, message: c.message, muted: false, video: Boolean(c.video), askId: c.askId });
      ringRef.current.start();
    };
    const onSignal = async (e: Event) => {
      const sig = (e as CustomEvent).detail as Signal;
      const st = stateRef.current;
      try {
        if (sig.type === 'accept') {
          // Our ring was answered (we are the caller — even if the call was started by voice on the server).
          ringRef.current.stop();
          const wantVideo = Boolean(stateRef.current.video || sig.video);
          setState({ phase: 'connecting', callId: sig.callId, kind: 'peer', peerName: sig.fromName, peerDeviceId: sig.from, muted: false, video: wantVideo });
          const pc = await createPeer(sig.from!, sig.callId!, wantVideo, true);
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          signal(sig.from!, { type: 'offer', callId: sig.callId, sdp: offer });
        } else if (sig.type === 'offer' && pcRef.current) {
          await pcRef.current.setRemoteDescription(sig.sdp!);
          // Let this side send video later even if it answered without the camera.
          for (const t of pcRef.current.getTransceivers()) {
            if (t.receiver.track.kind === 'video' && !t.sender.track && t.direction === 'recvonly') t.direction = 'sendrecv';
          }
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
        } else if (sig.type === 'cam') {
          setState((s) => ({ ...s, remoteCamOn: Boolean(sig.on) }));
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
        setState({ phase: 'ringing-in', callId, kind, peerDeviceId: q.get('from') || undefined, peerName: kind === 'ray' ? 'RAY' : 'Your device', message: q.get('m') || undefined, muted: false, video: q.get('video') === '1', askId: q.get('ask') || undefined });
      }
    }, 1500);
    return () => window.clearTimeout(t);
  }, []);

  const accept = useCallback(async (withVideo?: boolean) => {
    const st = stateRef.current;
    ringRef.current.stop();
    if (st.kind === 'ray') {
      setState({ phase: 'idle', muted: false });
      if (st.askId) window.dispatchEvent(new CustomEvent('ray:open-ask', { detail: { id: st.askId } }));
      else paramsRef.current.onAnswerRayCall(st.message || '');
      return;
    }
    if (!st.peerDeviceId || !st.callId) return cleanup('ended', 'Caller unknown');
    setState((s) => ({ ...s, phase: 'connecting' }));
    try {
      const video = withVideo ?? Boolean(st.video);
      await createPeer(st.peerDeviceId, st.callId, video, false);
      signal(st.peerDeviceId, { type: 'accept', callId: st.callId, video });
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

  const videoSender = () => pcRef.current?.getTransceivers().find((t) => t.receiver.track.kind === 'video' && t.direction !== 'recvonly' && t.direction !== 'inactive')?.sender;

  /** Camera on/off mid-call (no re-dial: the video channel is negotiated up front). */
  const toggleCamera = useCallback(async () => {
    const st = stateRef.current;
    const local = localStreamRef.current;
    if (!local || !pcRef.current) return;
    const peer = st.peerDeviceId;
    if (st.camOn) {
      local.getVideoTracks().forEach((t) => {
        t.stop();
        local.removeTrack(t);
      });
      await videoSender()?.replaceTrack(null);
      setLocalStream(new MediaStream(local.getTracks()));
      setState((s) => ({ ...s, camOn: false }));
      if (peer) signal(peer, { type: 'cam', callId: st.callId, on: false });
      return;
    }
    try {
      const cam = await navigator.mediaDevices.getUserMedia({ video: VIDEO_CONSTRAINTS(st.facing || 'user') });
      const track = cam.getVideoTracks()[0];
      const sender = videoSender();
      if (!sender) {
        track.stop();
        setState((s) => ({ ...s, error: 'This call can’t carry video — call again as a video call.' }));
        return;
      }
      await sender.replaceTrack(track);
      local.addTrack(track);
      setLocalStream(new MediaStream(local.getTracks()));
      setState((s) => ({ ...s, camOn: true, error: undefined }));
      if (peer) signal(peer, { type: 'cam', callId: st.callId, on: true });
    } catch {
      setState((s) => ({ ...s, error: 'Camera unavailable' }));
    }
  }, [signal]);

  /** Front ↔ back camera (phones). */
  const flipCamera = useCallback(async () => {
    const st = stateRef.current;
    const local = localStreamRef.current;
    if (!local || !st.camOn) return;
    const next = st.facing === 'environment' ? 'user' : 'environment';
    try {
      const cam = await navigator.mediaDevices.getUserMedia({ video: VIDEO_CONSTRAINTS(next) });
      const track = cam.getVideoTracks()[0];
      await videoSender()?.replaceTrack(track);
      local.getVideoTracks().forEach((t) => {
        t.stop();
        local.removeTrack(t);
      });
      local.addTrack(track);
      setLocalStream(new MediaStream(local.getTracks()));
      setState((s) => ({ ...s, facing: next }));
    } catch {
      // only one camera
    }
  }, []);

  /** Ring another of Ray's devices from this one. */
  const callDevice = useCallback(async (targetDeviceId: string, targetName: string, video = false) => {
    const callId = crypto.randomUUID();
    setState({ phase: 'calling-out', callId, kind: 'peer', peerName: targetName, peerDeviceId: targetDeviceId, muted: false, video });
    try {
      await authFetch('/api/device/command', paramsRef.current.roomId, {
        method: 'POST',
        body: JSON.stringify({
          roomId: paramsRef.current.roomId,
          type: 'call',
          targetDevice: targetDeviceId,
          payload: { callId, kind: 'peer', fromName: paramsRef.current.myName, fromDeviceId: paramsRef.current.myDeviceId, createdAt: Date.now(), video },
        }),
      });
    } catch {
      cleanup('ended', 'Could not reach the hub');
    }
  }, [cleanup]);

  return { state, accept, decline, hangup, toggleMute, toggleCamera, flipCamera, callDevice, localStream, remoteStream };
}
