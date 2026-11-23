import { useEffect, useState } from 'react';
import { Mic, MicOff, Phone, PhoneOff } from 'lucide-react';
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

/** Full-screen phone-style call UI for incoming / outgoing / active calls. */
export function CallScreen({
  state,
  onAccept,
  onDecline,
  onHangup,
  onToggleMute,
}: {
  state: CallState;
  onAccept: () => void;
  onDecline: () => void;
  onHangup: () => void;
  onToggleMute: () => void;
}) {
  const elapsed = useElapsed(state.phase === 'connected' ? state.startedAt : undefined);
  if (state.phase === 'idle') return null;

  const name = state.kind === 'ray' ? 'RAY' : state.peerName || 'Your device';
  const subtitle =
    state.phase === 'ringing-in'
      ? state.kind === 'ray'
        ? 'is calling you'
        : 'is calling — live voice call'
      : state.phase === 'calling-out'
      ? 'Ringing…'
      : state.phase === 'connecting'
      ? 'Connecting…'
      : state.phase === 'connected'
      ? elapsed
      : state.error || 'Call ended';

  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center justify-between bg-gradient-to-b from-slate-950 via-blue-950 to-slate-950 text-white px-6 py-[max(3rem,env(safe-area-inset-top))] pb-[max(3rem,env(safe-area-inset-bottom))]">
      <div className="flex flex-col items-center gap-4 mt-8 text-center">
        <p className="text-xs uppercase tracking-[0.3em] text-cyan-300/80">
          {state.phase === 'ringing-in' ? 'Incoming call' : state.phase === 'connected' ? 'On call' : 'RAY call'}
        </p>
        <div className="relative">
          {(state.phase === 'ringing-in' || state.phase === 'calling-out') && (
            <span className="absolute inset-0 rounded-full bg-cyan-400/30 animate-ping" />
          )}
          <div className="relative w-28 h-28 rounded-full bg-gradient-to-br from-cyan-400 to-blue-600 flex items-center justify-center text-3xl font-bold shadow-2xl shadow-cyan-500/30">
            {name.slice(0, 1).toUpperCase()}
          </div>
        </div>
        <h2 className="text-3xl font-semibold">{name}</h2>
        <p className="text-sm text-slate-300 tabular-nums">{subtitle}</p>
        {state.message && state.phase === 'ringing-in' && (
          <p className="max-w-sm text-base text-slate-100/90 italic">“{state.message}”</p>
        )}
      </div>

      {state.phase === 'ringing-in' ? (
        <div className="w-full max-w-xs flex items-center justify-between">
          <button type="button" onClick={onDecline} className="flex flex-col items-center gap-2" aria-label="Decline call">
            <span className="w-16 h-16 rounded-full bg-red-600 hover:bg-red-500 flex items-center justify-center shadow-lg">
              <PhoneOff className="w-7 h-7" />
            </span>
            <span className="text-xs text-slate-300">Decline</span>
          </button>
          <button type="button" onClick={onAccept} className="flex flex-col items-center gap-2" aria-label="Answer call">
            <span className="w-16 h-16 rounded-full bg-emerald-500 hover:bg-emerald-400 flex items-center justify-center shadow-lg animate-bounce">
              <Phone className="w-7 h-7" />
            </span>
            <span className="text-xs text-slate-300">Answer</span>
          </button>
        </div>
      ) : state.phase === 'ended' ? (
        <div className="h-24" />
      ) : (
        <div className="w-full max-w-xs flex items-center justify-around">
          <button type="button" onClick={onToggleMute} disabled={state.phase !== 'connected'} className="flex flex-col items-center gap-2 disabled:opacity-40" aria-label={state.muted ? 'Unmute' : 'Mute'}>
            <span className={`w-14 h-14 rounded-full flex items-center justify-center ${state.muted ? 'bg-white text-slate-900' : 'bg-white/10'}`}>
              {state.muted ? <MicOff className="w-6 h-6" /> : <Mic className="w-6 h-6" />}
            </span>
            <span className="text-xs text-slate-300">{state.muted ? 'Unmute' : 'Mute'}</span>
          </button>
          <button type="button" onClick={onHangup} className="flex flex-col items-center gap-2" aria-label="Hang up">
            <span className="w-16 h-16 rounded-full bg-red-600 hover:bg-red-500 flex items-center justify-center shadow-lg">
              <PhoneOff className="w-7 h-7" />
            </span>
            <span className="text-xs text-slate-300">End</span>
          </button>
        </div>
      )}
    </div>
  );
}
