import { useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Phone, PhoneOff, RefreshCcw, Video, VideoOff } from 'lucide-react';
import type { CallState } from '../hooks/useDeviceCall';

function useElapsed(startedAt?: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);
  if (!startedAt) return '';
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function StreamVideo({ stream, className, mirrored }: { stream: MediaStream | null; className: string; mirrored?: boolean }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream;
  }, [stream]);
  // Muted: call audio plays through its own audio element.
  return <video ref={ref} autoPlay playsInline muted className={`${className} ${mirrored ? '-scale-x-100' : ''}`} />;
}

const ctrl = 'flex flex-col items-center gap-2 disabled:opacity-40';
const round = 'w-14 h-14 rounded-full flex items-center justify-center';

/** Full-screen phone-style call UI for incoming / outgoing / active voice and video calls. */
export function CallScreen({
  state,
  localStream,
  remoteStream,
  onAccept,
  onDecline,
  onHangup,
  onToggleMute,
  onToggleCamera,
  onFlipCamera,
}: {
  state: CallState;
  localStream?: MediaStream | null;
  remoteStream?: MediaStream | null;
  onAccept: (withVideo?: boolean) => void;
  onDecline: () => void;
  onHangup: () => void;
  onToggleMute: () => void;
  onToggleCamera?: () => void;
  onFlipCamera?: () => void;
}) {
  const elapsed = useElapsed(state.phase === 'connected' ? state.startedAt : undefined);
  if (state.phase === 'idle') return null;

  const name = state.kind === 'ray' ? 'RAY' : state.peerName || 'Your device';
  const isVideo = Boolean(state.video);
  const showRemote = Boolean(state.remoteCamOn && remoteStream && remoteStream.getVideoTracks().length);
  const showLocal = Boolean(state.camOn && localStream && localStream.getVideoTracks().length);
  const live = state.phase === 'connected' || state.phase === 'connecting' || state.phase === 'calling-out';
  const subtitle =
    state.phase === 'ringing-in'
      ? state.kind === 'ray'
        ? 'is calling you'
        : isVideo
        ? 'is calling — video call'
        : 'is calling — live voice call'
      : state.phase === 'calling-out'
      ? 'Ringing…'
      : state.phase === 'connecting'
      ? 'Connecting…'
      : state.phase === 'connected'
      ? elapsed
      : state.error || 'Call ended';

  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center justify-between overflow-hidden bg-gradient-to-b from-slate-950 via-blue-950 to-slate-950 text-white px-6 py-[max(3rem,env(safe-area-inset-top))] pb-[max(3rem,env(safe-area-inset-bottom))]">
      {showRemote && <StreamVideo stream={remoteStream!} className="absolute inset-0 w-full h-full object-cover" />}
      {showRemote && <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-transparent to-black/60 pointer-events-none" />}
      {showLocal && live && (
        <StreamVideo
          stream={localStream!}
          mirrored={state.facing !== 'environment'}
          className="absolute z-10 right-4 top-[max(1rem,env(safe-area-inset-top))] w-28 sm:w-40 aspect-[3/4] object-cover rounded-2xl border border-white/30 shadow-2xl bg-black"
        />
      )}

      <div className={`relative flex flex-col items-center gap-4 text-center ${showRemote ? 'mt-2' : 'mt-8'}`}>
        <p className="text-xs uppercase tracking-[0.3em] text-cyan-300/80">
          {state.phase === 'ringing-in' ? (isVideo ? 'Incoming video call' : 'Incoming call') : state.phase === 'connected' ? (isVideo || showRemote || showLocal ? 'Video call' : 'On call') : 'RAY call'}
        </p>
        {!showRemote && (
          <div className="relative">
            {(state.phase === 'ringing-in' || state.phase === 'calling-out') && <span className="absolute inset-0 rounded-full bg-cyan-400/30 animate-ping" />}
            <div className="relative w-28 h-28 rounded-full bg-gradient-to-br from-cyan-400 to-blue-600 flex items-center justify-center text-3xl font-bold shadow-2xl shadow-cyan-500/30">
              {name.slice(0, 1).toUpperCase()}
            </div>
          </div>
        )}
        <h2 className={`font-semibold ${showRemote ? 'text-xl drop-shadow' : 'text-3xl'}`}>{name}</h2>
        <p className="text-sm text-slate-200 tabular-nums drop-shadow">{subtitle}</p>
        {state.message && state.phase === 'ringing-in' && <p className="max-w-sm text-base text-slate-100/90 italic">“{state.message}”</p>}
        {state.error && state.phase === 'connected' && <p className="text-xs text-amber-300">{state.error}</p>}
      </div>

      {state.phase === 'ringing-in' ? (
        <div className="relative w-full max-w-sm flex items-center justify-between">
          <button type="button" onClick={onDecline} className={ctrl} aria-label="Decline call">
            <span className="w-16 h-16 rounded-full bg-red-600 hover:bg-red-500 flex items-center justify-center shadow-lg">
              <PhoneOff className="w-7 h-7" />
            </span>
            <span className="text-xs text-slate-300">Decline</span>
          </button>
          {state.kind === 'peer' && (
            <button type="button" onClick={() => onAccept(!isVideo)} className={ctrl} aria-label={isVideo ? 'Answer with voice only' : 'Answer with video'}>
              <span className="w-16 h-16 rounded-full bg-white/15 hover:bg-white/25 flex items-center justify-center shadow-lg">
                {isVideo ? <Phone className="w-7 h-7" /> : <Video className="w-7 h-7" />}
              </span>
              <span className="text-xs text-slate-300">{isVideo ? 'Voice only' : 'With video'}</span>
            </button>
          )}
          <button type="button" onClick={() => onAccept(state.kind === 'peer' ? isVideo : undefined)} className={ctrl} aria-label="Answer call">
            <span className="w-16 h-16 rounded-full bg-emerald-500 hover:bg-emerald-400 flex items-center justify-center shadow-lg animate-bounce">
              {isVideo ? <Video className="w-7 h-7" /> : <Phone className="w-7 h-7" />}
            </span>
            <span className="text-xs text-slate-300">Answer</span>
          </button>
        </div>
      ) : state.phase === 'ended' ? (
        <div className="h-24" />
      ) : (
        <div className="relative w-full max-w-sm flex items-center justify-around">
          <button type="button" onClick={onToggleMute} disabled={state.phase !== 'connected'} className={ctrl} aria-label={state.muted ? 'Unmute' : 'Mute'}>
            <span className={`${round} ${state.muted ? 'bg-white text-slate-900' : 'bg-white/15'}`}>{state.muted ? <MicOff className="w-6 h-6" /> : <Mic className="w-6 h-6" />}</span>
            <span className="text-xs text-slate-200">{state.muted ? 'Unmute' : 'Mute'}</span>
          </button>
          {onToggleCamera && state.kind === 'peer' && (
            <button type="button" onClick={onToggleCamera} disabled={state.phase !== 'connected'} className={ctrl} aria-label={state.camOn ? 'Turn camera off' : 'Turn camera on'}>
              <span className={`${round} ${state.camOn ? 'bg-white text-slate-900' : 'bg-white/15'}`}>{state.camOn ? <Video className="w-6 h-6" /> : <VideoOff className="w-6 h-6" />}</span>
              <span className="text-xs text-slate-200">Camera</span>
            </button>
          )}
          {onFlipCamera && state.camOn && (
            <button type="button" onClick={onFlipCamera} className={ctrl} aria-label="Switch camera">
              <span className={`${round} bg-white/15`}>
                <RefreshCcw className="w-6 h-6" />
              </span>
              <span className="text-xs text-slate-200">Flip</span>
            </button>
          )}
          <button type="button" onClick={onHangup} className={ctrl} aria-label="Hang up">
            <span className="w-16 h-16 rounded-full bg-red-600 hover:bg-red-500 flex items-center justify-center shadow-lg">
              <PhoneOff className="w-7 h-7" />
            </span>
            <span className="text-xs text-slate-200">End</span>
          </button>
        </div>
      )}
    </div>
  );
}
