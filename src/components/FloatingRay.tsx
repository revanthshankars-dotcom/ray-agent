import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Loader2, Mic, MicOff, Send } from 'lucide-react';
import { AskCard } from './AskCard';
import { authFetch } from '../utils/roomAuth';
import type { LiveVoiceState } from '../types/relay';

/**
 * "Display over other apps" for PCs: a small RAY window that stays on top of every app
 * (Chrome/Edge Document Picture-in-Picture, Windows / macOS / Linux). Mic, live captions, a quick
 * ask box and RAY's questions — while you work in anything else.
 */

interface PipApi {
  requestWindow: (opts: { width: number; height: number; disallowReturnToOpener?: boolean }) => Promise<Window>;
  window: Window | null;
}
const pipApi = (): PipApi | null => (typeof window !== 'undefined' ? ((window as unknown as { documentPictureInPicture?: PipApi }).documentPictureInPicture ?? null) : null);
export const floatSupported = () => Boolean(pipApi());

export interface MiniRayProps {
  roomId: string;
  deviceName: string;
  voiceState: LiveVoiceState;
  userCaption: string;
  jarvisCaption: string;
  onMic: () => void;
}

function MiniRay({ roomId, deviceName, voiceState, userCaption, jarvisCaption, onMic }: MiniRayProps) {
  const [text, setText] = useState('');
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const live = voiceState === 'listening' || voiceState === 'thinking' || voiceState === 'speaking' || voiceState === 'connecting';

  const ask = async () => {
    const msg = text.trim();
    if (!msg || busy) return;
    setBusy(true);
    setReply('');
    setText('');
    try {
      const r = await authFetch('/api/ai/chat', roomId, {
        method: 'POST',
        body: JSON.stringify({ roomId, sourceDeviceName: deviceName, message: msg, engine: { provider: 'auto' } }),
      });
      if (!r.body) throw new Error('No reply');
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() || '';
        for (const part of parts) {
          const line = part.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          const ev = JSON.parse(line.slice(6)) as { type: string; data: unknown };
          if (ev.type === 'text') setReply(String(ev.data || ''));
          if (ev.type === 'error') setReply(`Sorry: ${String(ev.data)}`);
          if (ev.type === 'confirmation_required') setReply('RAY needs your approval — open the RAY window to approve.');
        }
      }
    } catch (err) {
      setReply(err instanceof Error ? err.message : 'RAY is unreachable');
    } finally {
      setBusy(false);
    }
  };

  const status = voiceState === 'listening' ? 'Listening…' : voiceState === 'thinking' ? 'Thinking…' : voiceState === 'speaking' ? 'Speaking' : voiceState === 'connecting' ? 'Connecting…' : voiceState === 'standby' ? 'Say “Hey Ray”' : 'Tap the mic';
  const caption = jarvisCaption || reply || (userCaption ? `“${userCaption}”` : '');

  return (
    <div className="h-screen flex flex-col bg-slate-950 text-white font-sans select-none">
      <div className="flex items-center gap-3 px-4 pt-4">
        <button
          type="button"
          onClick={onMic}
          aria-label={live ? 'Stop listening' : 'Talk to RAY'}
          className={`relative w-14 h-14 shrink-0 rounded-full flex items-center justify-center shadow-lg transition-colors ${live ? 'bg-red-600 hover:bg-red-500' : 'bg-gradient-to-br from-cyan-400 to-blue-600 hover:opacity-90'}`}
        >
          {live && <span className="absolute inset-0 rounded-full bg-red-500/40 animate-ping" />}
          {live ? <MicOff className="relative w-6 h-6" /> : <Mic className="relative w-6 h-6" />}
        </button>
        <div className="min-w-0">
          <p className="text-sm font-semibold tracking-wide">RAY</p>
          <p className="text-xs text-cyan-300/80">{status}</p>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 text-sm leading-relaxed text-slate-100 whitespace-pre-wrap break-words">
        {caption || <span className="text-slate-500">Ask anything — RAY stays on top while you work.</span>}
      </div>
      <form
        className="flex gap-2 p-3 border-t border-white/10"
        onSubmit={(e) => {
          e.preventDefault();
          void ask();
        }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ask RAY…"
          className="flex-1 min-w-0 rounded-lg bg-white/10 border border-white/10 px-3 py-2 text-sm placeholder:text-slate-500 outline-none focus:border-cyan-400"
        />
        <button type="submit" aria-label="Send" disabled={busy || !text.trim()} className="p-2 rounded-lg bg-blue-600 disabled:opacity-40">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
        </button>
      </form>
      <AskCard roomId={roomId} quiet />
    </div>
  );
}

/** Opens / updates the floating RAY window. `open()` must be called from a click or key press. */
export function useFloatingRay(props: MiniRayProps) {
  const winRef = useRef<Window | null>(null);
  const rootRef = useRef<Root | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    rootRef.current?.render(<MiniRay {...props} />);
  }, [props]);

  const close = useCallback(() => {
    winRef.current?.close();
  }, []);

  const open = useCallback(async () => {
    const api = pipApi();
    if (!api) return false;
    if (winRef.current && !winRef.current.closed) {
      winRef.current.focus();
      return true;
    }
    const pip = await api.requestWindow({ width: 340, height: 460, disallowReturnToOpener: true });
    winRef.current = pip;
    // Same styles as RAY (Tailwind build + fonts).
    for (const node of Array.from(document.head.querySelectorAll('style, link[rel="stylesheet"]'))) pip.document.head.appendChild(node.cloneNode(true));
    pip.document.title = 'RAY';
    pip.document.documentElement.className = document.documentElement.className;
    pip.document.body.style.margin = '0';
    const host = pip.document.createElement('div');
    pip.document.body.appendChild(host);
    const root = createRoot(host);
    rootRef.current = root;
    root.render(<MiniRay {...propsRef.current} />);
    setIsOpen(true);
    pip.addEventListener('pagehide', () => {
      root.unmount();
      rootRef.current = null;
      winRef.current = null;
      setIsOpen(false);
    });
    return true;
  }, []);

  return { supported: floatSupported(), isOpen, open, close };
}
