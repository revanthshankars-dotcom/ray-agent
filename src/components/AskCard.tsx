import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, HelpCircle, Loader2, Mic, Send, X } from 'lucide-react';
import { authFetch } from '../utils/roomAuth';
import { blobToBase64, recordUtterance } from '../utils/voiceCapture';
import { playHudSound } from '../utils/hudAudio';

export interface AskItem {
  id: string;
  question: string;
  options: string[];
  why?: string;
  urgent?: boolean;
}

/**
 * "RAY needs your answer" — the agent paused a task to check with Ray. Answer with a tap, by typing
 * or by voice; the first answer from any device is the one RAY uses.
 */
export function AskCard({ roomId, quiet }: { roomId: string; /** No sound/voice (the main window already announces it). */ quiet?: boolean }) {
  const [queue, setQueue] = useState<AskItem[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<'send' | 'voice' | null>(null);
  const [done, setDone] = useState<string>('');
  const listening = useRef(false);
  const current = queue[0];

  const add = useCallback((a: AskItem) => {
    if (!a?.id || !a.question) return;
    setQueue((q) => (q.some((x) => x.id === a.id) ? q : [...q, { ...a, options: a.options || [] }]));
    if (quiet) return;
    playHudSound('alert');
    if ('speechSynthesis' in window && document.visibilityState === 'visible') {
      try {
        const u = new SpeechSynthesisUtterance(`Ray, ${a.question}`);
        u.rate = 1.02;
        window.speechSynthesis.speak(u);
      } catch {
        // ignore
      }
    }
  }, [quiet]);

  const fetchAsk = useCallback(
    async (id: string) => {
      try {
        const r = await authFetch(`/api/ask?room=${encodeURIComponent(roomId)}&id=${encodeURIComponent(id)}`, roomId);
        if (!r.ok) return;
        const a = (await r.json()) as AskItem & { answer?: string | null; answeredVia?: string | null };
        if (a.answer) setDone(`Already answered via ${a.answeredVia}: “${a.answer}”`);
        else add(a);
      } catch {
        // offline
      }
    },
    [roomId, add]
  );

  useEffect(() => {
    const onAsk = (e: Event) => add((e as CustomEvent<AskItem>).detail);
    const onOpen = (e: Event) => void fetchAsk(String((e as CustomEvent<{ id: string }>).detail?.id || ''));
    const onAnswered = (e: Event) => {
      const a = (e as CustomEvent<{ id: string; answer: string; answeredVia: string }>).detail;
      setQueue((q) => q.filter((x) => x.id !== a.id));
      setDone(`RAY got your answer (${a.answeredVia}): “${a.answer}”`);
    };
    window.addEventListener('ray:ask', onAsk);
    window.addEventListener('ray:open-ask', onOpen);
    window.addEventListener('ray:ask-answered', onAnswered);
    // Opened from a push notification / PC pop-up: /?ask=<id>
    const id = new URLSearchParams(window.location.search).get('ask');
    if (id) void fetchAsk(id);
    // Questions asked while this window was closed.
    void authFetch(`/api/ask?room=${encodeURIComponent(roomId)}`, roomId)
      .then((r) => (r.ok ? r.json() : { open: [] }))
      .then((j: { open?: AskItem[] }) => (j.open || []).forEach((a) => setQueue((q) => (q.some((x) => x.id === a.id) ? q : [...q, a]))))
      .catch(() => undefined);
    return () => {
      window.removeEventListener('ray:ask', onAsk);
      window.removeEventListener('ray:open-ask', onOpen);
      window.removeEventListener('ray:ask-answered', onAnswered);
    };
  }, [roomId, add, fetchAsk]);

  useEffect(() => {
    if (!done) return;
    const t = window.setTimeout(() => setDone(''), 5000);
    return () => window.clearTimeout(t);
  }, [done]);

  const send = async (answer: string) => {
    if (!current || !answer.trim()) return;
    setBusy('send');
    try {
      await authFetch('/api/ask/answer', roomId, { method: 'POST', body: JSON.stringify({ roomId, askId: current.id, answer: answer.trim(), via: 'RAY app' }) });
      setQueue((q) => q.slice(1));
      setText('');
      setDone(`Sent: “${answer.trim()}”`);
    } finally {
      setBusy(null);
    }
  };

  const voice = async () => {
    if (listening.current) return;
    listening.current = true;
    setBusy('voice');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const u = await recordUtterance(stream, { isActive: () => listening.current, startTimeoutMs: 8000 }).finally(() => stream.getTracks().forEach((t) => t.stop()));
      if (u.blob) {
        const r = await authFetch('/api/ai/transcribe', roomId, { method: 'POST', body: JSON.stringify({ roomId, audioBase64: await blobToBase64(u.blob), mimeType: u.mimeType }) });
        const t = r.ok ? String(((await r.json()) as { transcript?: string }).transcript || '') : '';
        if (t) setText(t);
      }
    } catch {
      // mic unavailable — type instead
    } finally {
      listening.current = false;
      setBusy(null);
    }
  };

  if (!current) {
    return done ? (
      <div role="status" className="fixed z-[90] left-1/2 -translate-x-1/2 bottom-24 md:bottom-6 max-w-[calc(100vw-2rem)] rounded-xl bg-emerald-600 text-white text-xs px-3 py-2 shadow-lg inline-flex items-center gap-1.5">
        <CheckCircle2 className="w-4 h-4 shrink-0" />
        <span className="truncate">{done}</span>
      </div>
    ) : null;
  }

  return (
    <div role="dialog" aria-modal="false" aria-labelledby="ray-ask-q" className={quiet ? "fixed z-[95] inset-x-0 bottom-0 p-2" : "fixed z-[95] inset-x-0 bottom-16 md:inset-auto md:right-6 md:bottom-6 md:w-[26rem] p-3 md:p-0"}>
      <div className={`rounded-2xl border bg-white dark:bg-slate-900 shadow-2xl p-4 ${current.urgent ? 'border-rose-400' : 'border-blue-300 dark:border-blue-800'}`}>
        <div className="flex items-start gap-2">
          <HelpCircle className={`w-5 h-5 shrink-0 mt-0.5 ${current.urgent ? 'text-rose-500' : 'text-blue-500'}`} />
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">RAY needs your answer{queue.length > 1 ? ` · 1 of ${queue.length}` : ''}</p>
            <p id="ray-ask-q" className="mt-0.5 text-sm font-medium text-slate-900 dark:text-slate-100 break-words">
              {current.question}
            </p>
            {current.why && <p className="mt-0.5 text-xs text-slate-500 break-words">{current.why}</p>}
          </div>
          <button type="button" aria-label="Answer later" title="Answer later (RAY keeps waiting)" className="p-1 rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800" onClick={() => setQueue((q) => (q.length > 1 ? [...q.slice(1), q[0]] : []))}>
            <X className="w-4 h-4" />
          </button>
        </div>
        {current.options.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {current.options.map((o) => (
              <button key={o} type="button" disabled={busy !== null} onClick={() => void send(o)} className="px-3 py-1.5 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50">
                {o}
              </button>
            ))}
          </div>
        )}
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void send(text);
          }}
        >
          <input
            className="flex-1 min-w-0 rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent px-2.5 py-1.5 text-sm"
            placeholder={current.options.length ? 'Or type something else…' : 'Your answer…'}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button type="button" aria-label="Answer by voice" title="Answer by voice" disabled={busy !== null} onClick={() => void voice()} className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 disabled:opacity-50">
            {busy === 'voice' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mic className="w-4 h-4" />}
          </button>
          <button type="submit" aria-label="Send answer" disabled={busy !== null || !text.trim()} className="p-2 rounded-lg bg-blue-600 text-white disabled:opacity-50">
            {busy === 'send' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </form>
      </div>
    </div>
  );
}
