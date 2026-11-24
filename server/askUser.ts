/**
 * ASK RAY — the agent checks with Ray before it guesses: a question (optionally with choices) that
 * reaches him wherever he is and WAITS for his answer, so a mission can continue with it.
 *
 * Escalation (stops the moment any answer arrives; urgent compresses the timings):
 *   now   → a card in every open RAY window (buttons, typing or voice reply)
 *         → the Android phone's Termux bridge: a dialog over any app + the question spoken aloud
 *           (works while the RAY app is closed)
 *   +45s  → PC pops RAY up on the question; push notification to devices where RAY is closed
 *   +3m   → rings his phone (answering opens the question)
 *   +5m   → real phone call over Twilio, if configured (his spoken reply is the answer)
 */
import crypto from 'crypto';
import type { Express } from 'express';
import { Type } from '@google/genai';
import type { FunctionDeclaration } from '@google/genai';
import { broadcastHudSound, broadcastRoomEvent, dispatchDeviceCommand, getRoomDevices, normalizeRoomId } from './hub.ts';
import { ringDevice } from './calls.ts';
import { phoneLineStatus, startPhoneCall } from './phoneCall.ts';

export interface PendingAsk {
  id: string;
  roomId: string;
  question: string;
  options: string[];
  why: string;
  urgent: boolean;
  createdAt: number;
  answer?: string;
  answeredVia?: string;
  answeredAt?: number;
  reached: string[];
}

const asks = new Map<string, PendingAsk>();
const waiters = new Map<string, Array<(a: PendingAsk) => void>>();
const timers = new Map<string, NodeJS.Timeout[]>();

function publicAsk(a: PendingAsk) {
  return { id: a.id, question: a.question, options: a.options, why: a.why, urgent: a.urgent, createdAt: a.createdAt, answer: a.answer || null, answeredVia: a.answeredVia || null };
}

export function getAsk(roomId: string, id: string): PendingAsk | null {
  const a = asks.get(id);
  return a && a.roomId === roomId ? a : null;
}
export function openAsks(roomId: string) {
  return [...asks.values()].filter((a) => a.roomId === roomId && !a.answer && Date.now() - a.createdAt < 3600_000).map(publicAsk);
}

export function answerAsk(roomId: string, id: string, answer: string, via: string): PendingAsk | null {
  const a = getAsk(roomId, id);
  if (!a || a.answer) return a;
  const text = String(answer || '').trim().slice(0, 2000);
  if (!text) return a;
  a.answer = text;
  a.answeredVia = via;
  a.answeredAt = Date.now();
  for (const t of timers.get(id) || []) clearTimeout(t);
  timers.delete(id);
  broadcastRoomEvent(roomId, 'ask:answered', publicAsk(a));
  for (const w of waiters.get(id) || []) w(a);
  waiters.delete(id);
  setTimeout(() => asks.delete(id), 6 * 3600_000).unref?.();
  return a;
}

const isPhone = (d: { type: string; os?: string }) => d.type === 'bridge' && /android/i.test(d.os || '');
const isPcBridge = (d: { type: string; os?: string }) => d.type === 'bridge' && !/android/i.test(d.os || '');

/** Starts delivering a question; returns immediately. */
export function startAsk(roomId: string, input: { question: string; options?: string[]; why?: string; urgent?: boolean }): PendingAsk {
  const a: PendingAsk = {
    id: crypto.randomUUID().slice(0, 12),
    roomId,
    question: input.question.trim().slice(0, 500),
    options: (input.options || []).map((o) => String(o).trim()).filter(Boolean).slice(0, 6),
    why: String(input.why || '').slice(0, 300),
    urgent: Boolean(input.urgent),
    createdAt: Date.now(),
    reached: [],
  };
  asks.set(a.id, a);
  const payload = { askId: a.id, question: a.question, options: a.options, why: a.why, urgent: a.urgent };
  const t = (ms: number, fn: () => void) => {
    const h = setTimeout(() => {
      if (!asks.get(a.id)?.answer) fn();
    }, ms);
    (timers.get(a.id) || timers.set(a.id, []).get(a.id)!).push(h);
  };
  const devices = () => getRoomDevices(roomId);

  // Stage 1 — open RAY windows + the phone (dialog over any app).
  broadcastRoomEvent(roomId, 'ask:question', publicAsk(a));
  broadcastHudSound(roomId, 'alert');
  a.reached.push('open RAY windows');
  for (const d of devices().filter((x) => x.online && isPhone(x))) {
    void dispatchDeviceCommand({ roomId, type: 'ask', targetQuery: d.id, source: 'assistant', payload, waitForAckMs: 3000 }).catch(() => undefined);
    a.reached.push(`${d.name} (dialog)`);
  }

  // Stage 2 — PC pop-up and push to devices where RAY is closed.
  t(a.urgent ? 0 : 45_000, () => {
    for (const d of devices()) {
      if (d.online && isPcBridge(d)) {
        void dispatchDeviceCommand({ roomId, type: 'ask', targetQuery: d.id, source: 'assistant', payload, waitForAckMs: 3000 }).catch(() => undefined);
        a.reached.push(`${d.name} (pop-up)`);
      } else if (!d.online && d.type !== 'bridge') {
        // Offline app devices: queued + web push ("RAY needs you") that opens the question.
        void dispatchDeviceCommand({ roomId, type: 'ask', targetQuery: d.id, source: 'assistant', payload, waitForAckMs: 0 }).catch(() => undefined);
        a.reached.push(`${d.name} (push)`);
      }
    }
  });

  // Stage 3 — ring the phone (answering shows the question).
  t(a.urgent ? 45_000 : 180_000, () => {
    void ringDevice(roomId, 'phone', { kind: 'ray', fromName: 'RAY', message: a.question, askId: a.id }).catch(() => undefined);
    a.reached.push('ringing your phone');
  });

  // Stage 4 — a real phone call, when Twilio is set up.
  if (phoneLineStatus().configured) {
    t(a.urgent ? 120_000 : 300_000, () => {
      a.reached.push('phone call');
      void startPhoneCall(roomId, `RAY needs your answer. ${a.question}${a.options.length ? ` Options: ${a.options.join(', or ')}.` : ''}`, `Get Ray's answer to: ${a.question}`)
        .then((call) => {
          const check = setInterval(() => {
            const said = call.transcript.filter((x) => x.who === 'Ray').map((x) => x.text);
            if (said.length) {
              clearInterval(check);
              answerAsk(roomId, a.id, said.join(' '), 'phone call');
            } else if (call.endedAt) clearInterval(check);
          }, 2000);
        })
        .catch(() => undefined);
    });
  }
  return a;
}

export function waitForAnswer(a: PendingAsk, ms: number): Promise<PendingAsk | null> {
  if (a.answer) return Promise.resolve(a);
  return new Promise((resolve) => {
    const h = setTimeout(() => resolve(null), ms);
    (waiters.get(a.id) || waiters.set(a.id, []).get(a.id)!).push((x) => {
      clearTimeout(h);
      resolve(x);
    });
  });
}

export function registerAskRoutes(app: Express, requireRoomAuth: Parameters<Express['get']>[1]) {
  app.get('/api/ask', requireRoomAuth, (req, res) => {
    const roomId = normalizeRoomId(String(req.query.room || 'RLY-HOME'));
    const id = String(req.query.id || '');
    if (id) {
      const a = getAsk(roomId, id);
      return a ? res.json(publicAsk(a)) : res.status(404).json({ error: 'Question not found (it may have expired).' });
    }
    res.json({ open: openAsks(roomId) });
  });
  app.post('/api/ask/answer', requireRoomAuth, (req, res) => {
    const b = req.body as { roomId?: string; askId?: string; answer?: string; via?: string };
    const a = answerAsk(normalizeRoomId(String(b.roomId || '')), String(b.askId || ''), String(b.answer || ''), String(b.via || 'RAY app').slice(0, 60));
    if (!a) return res.status(404).json({ error: 'Question not found' });
    res.json({ ok: true, answer: a.answer, answeredVia: a.answeredVia });
  });
}

export const askToolDeclarations: FunctionDeclaration[] = [
  {
    name: 'ask_user',
    description:
      'Ask Ray a question and WAIT for his answer — use it instead of guessing when a step is ambiguous, risky, costs money, contacts someone, or needs a decision only he can make (which file, which flight, send or not, how much). It reaches him wherever he is: RAY windows, a pop-up dialog on his Android phone even when the RAY app is closed, push notifications, then rings his phone (and a real phone call if Twilio is set up). Give short options when possible. Returns his answer; continue the task with it.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        question: { type: Type.STRING, description: 'One short, specific question.' },
        options: { type: Type.STRING, description: 'Comma-separated choices, e.g. "Yes, No" or "7pm flight, 9pm flight, Neither".' },
        why: { type: Type.STRING, description: 'One line of context (what task this is for).' },
        urgent: { type: Type.BOOLEAN, description: 'Escalate faster (ring within a minute).' },
        waitMinutes: { type: Type.NUMBER, description: 'How long to wait for the answer (default 5, max 20).' },
        askId: { type: Type.STRING, description: 'Re-check an earlier question instead of asking a new one.' },
      },
    },
  },
];

export async function executeAskTool(roomId: string, name: string, args: Record<string, unknown>): Promise<{ result: string } | null> {
  if (name !== 'ask_user') return null;
  const waitMs = Math.max(30, Math.min(20 * 60, Number(args.waitMinutes || 5) * 60)) * 1000;
  let a: PendingAsk | null = null;
  if (args.askId) {
    a = getAsk(roomId, String(args.askId));
    if (!a) return { result: 'No such question (it may have expired). Ask again.' };
  } else {
    const question = String(args.question || '').trim();
    if (!question) return { result: 'question is required.' };
    const options = String(args.options || '')
      .split(/\s*[,|/]\s*/)
      .filter(Boolean);
    a = startAsk(roomId, { question, options, why: String(args.why || ''), urgent: Boolean(args.urgent) });
  }
  const done = await waitForAnswer(a, a.answer ? 0 : waitMs);
  if (done?.answer) return { result: `Ray answered (via ${done.answeredVia}): ${done.answer}` };
  return {
    result: `No answer yet after ${Math.round(waitMs / 60000)} min (reached: ${a.reached.join(', ')}). The question stays open (askId=${a.id}); his answer will appear in RAY. Do only what is safe without it, and say what is waiting on him.`,
  };
}
