/**
 * PHONE LINE — RAY rings Ray's real phone number (like ZeframLou/call-me) and talks with him.
 *
 * phone_call_me dials RAY_USER_PHONE from TWILIO_FROM_NUMBER. Twilio speaks RAY's message, listens
 * (speech → text), RAY answers in short sentences, until Ray says bye or hangs up. With
 * waitForReply the tool returns what Ray said, so a mission can ask him something mid-task
 * ("which flight?", "approve the payment?") and carry on with his answer.
 *
 * Works when no RAY app/bridge is online. Webhooks are verified with Twilio's signature.
 * Env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, RAY_USER_PHONE (E.164),
 * PUBLIC_BASE_URL (Render sets RENDER_EXTERNAL_URL automatically), optional RAY_PHONE_VOICE.
 */
import crypto from 'crypto';
import express from 'express';
import type { Express, Request } from 'express';
import { Type } from '@google/genai';
import type { FunctionDeclaration } from '@google/genai';
import { broadcastRoomEvent } from './hub.ts';
import { quickComplete } from './engines/router.ts';

function env(name: string): string {
  const v = (process.env[name] || '').trim();
  return /^(unset|none)$/i.test(v) ? '' : v;
}
const cfg = () => ({
  sid: env('TWILIO_ACCOUNT_SID'),
  token: env('TWILIO_AUTH_TOKEN'),
  from: env('TWILIO_FROM_NUMBER'),
  to: env('RAY_USER_PHONE'),
  base: (env('PUBLIC_BASE_URL') || env('RENDER_EXTERNAL_URL')).replace(/\/+$/, ''),
  voice: env('RAY_PHONE_VOICE') || 'Polly.Matthew-Neural',
  lang: env('RAY_PHONE_LANG') || 'en-IN',
});

export function phoneLineStatus() {
  const c = cfg();
  return {
    configured: Boolean(c.sid && c.token && c.from && c.to && c.base),
    missing: [
      !c.sid && 'TWILIO_ACCOUNT_SID',
      !c.token && 'TWILIO_AUTH_TOKEN',
      !c.from && 'TWILIO_FROM_NUMBER',
      !c.to && 'RAY_USER_PHONE',
      !c.base && 'PUBLIC_BASE_URL',
    ].filter(Boolean) as string[],
    number: c.to ? `•••${c.to.slice(-4)}` : null,
  };
}

interface PhoneCall {
  id: string;
  roomId: string;
  purpose: string;
  message: string;
  transcript: Array<{ who: 'RAY' | 'Ray'; text: string }>;
  status: 'dialing' | 'in-progress' | 'completed' | 'no-answer' | 'busy' | 'failed' | 'canceled';
  startedAt: number;
  endedAt?: number;
  turns: number;
  waiters: Array<(c: PhoneCall) => void>;
}
const calls = new Map<string, PhoneCall>();
const MAX_TURNS = 10;

function finish(call: PhoneCall, status: PhoneCall['status']) {
  if (call.endedAt) return;
  call.status = status;
  call.endedAt = Date.now();
  call.waiters.splice(0).forEach((w) => w(call));
  broadcastRoomEvent(call.roomId, 'phone:call', publicCall(call));
  setTimeout(() => calls.delete(call.id), 6 * 3600_000);
}
function publicCall(c: PhoneCall) {
  return { id: c.id, purpose: c.purpose, status: c.status, transcript: c.transcript, startedAt: c.startedAt, endedAt: c.endedAt || null };
}
export function recentPhoneCalls(roomId: string) {
  return [...calls.values()].filter((c) => c.roomId === roomId).sort((a, b) => b.startedAt - a.startedAt).slice(0, 5).map(publicCall);
}

// --- TwiML ---------------------------------------------------------------------

const esc = (s: string) => s.replace(/[<>&"']/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[ch]!);

function gatherTwiml(call: PhoneCall, say: string): string {
  const c = cfg();
  const action = `${c.base}/api/phone/voice?c=${call.id}&step=reply`;
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Gather input="speech" action="${esc(action)}" method="POST" speechTimeout="auto" timeout="7" language="${esc(c.lang)}"><Say voice="${esc(c.voice)}">${esc(say)}</Say></Gather><Say voice="${esc(c.voice)}">I did not catch that. I will send the rest to your RAY app. Bye.</Say><Hangup/></Response>`;
}
function hangupTwiml(say: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="${esc(cfg().voice)}">${esc(say)}</Say><Hangup/></Response>`;
}

// --- Twilio signature (https://www.twilio.com/docs/usage/security) -------------

function validSignature(req: Request): boolean {
  const sig = String(req.headers['x-twilio-signature'] || '');
  const c = cfg();
  if (!sig || !c.token || !c.base) return false;
  const url = c.base + req.originalUrl;
  const params = (req.body || {}) as Record<string, string>;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const expected = crypto.createHmac('sha1', c.token).update(Buffer.from(data, 'utf8')).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const BYE = /\b(bye|goodbye|that'?s all|that is all|nothing else|hang up|thanks?,? (ray|that'?s it)|ok(ay)? thanks|done)\b/i;

async function rayReply(call: PhoneCall): Promise<string> {
  const convo = call.transcript.map((t) => `${t.who}: ${t.text}`).join('\n');
  try {
    const out = await quickComplete(
      `Phone call purpose: ${call.purpose}\n\nConversation so far:\n${convo}\n\nReply as RAY in at most two short spoken sentences. If Ray gave the answer or decision the call was for, confirm it back and ask if there is anything else.`,
      'You are RAY, Ray’s JARVIS-style assistant, speaking on a phone call. Plain spoken English, no markdown, no lists, no emojis. Never read out secrets.',
      'quick',
      { maxTokens: 120, timeoutMs: 9000 }
    );
    return out.replace(/[*_#`]/g, '').trim().slice(0, 400) || 'Got it.';
  } catch {
    return 'Got it. I will take it from here.';
  }
}

export function registerPhoneRoutes(app: Express) {
  const form = express.urlencoded({ extended: false, limit: '64kb' });

  app.post('/api/phone/voice', form, async (req, res) => {
    res.type('text/xml');
    if (!validSignature(req)) return res.status(403).send(hangupTwiml('Unauthorized.'));
    const call = calls.get(String(req.query.c || ''));
    if (!call || call.endedAt) return res.send(hangupTwiml('This call has ended.'));
    call.status = 'in-progress';
    if (req.query.step !== 'reply') {
      call.transcript.push({ who: 'RAY', text: call.message });
      return res.send(gatherTwiml(call, call.message));
    }
    const heard = String((req.body as Record<string, string>).SpeechResult || '').trim();
    if (heard) call.transcript.push({ who: 'Ray', text: heard });
    broadcastRoomEvent(call.roomId, 'phone:call', publicCall(call));
    call.turns++;
    if (!heard || BYE.test(heard) || call.turns >= MAX_TURNS) {
      const bye = 'Okay. Talk soon.';
      call.transcript.push({ who: 'RAY', text: bye });
      return res.send(hangupTwiml(bye));
    }
    const say = await rayReply(call);
    call.transcript.push({ who: 'RAY', text: say });
    res.send(gatherTwiml(call, say));
  });

  app.post('/api/phone/status', form, (req, res) => {
    if (!validSignature(req)) return res.status(403).end();
    const call = calls.get(String(req.query.c || ''));
    const st = String((req.body as Record<string, string>).CallStatus || '');
    if (call && ['completed', 'no-answer', 'busy', 'failed', 'canceled'].includes(st)) finish(call, st as PhoneCall['status']);
    res.status(204).end();
  });
}

// --- placing the call ------------------------------------------------------------

export async function startPhoneCall(roomId: string, message: string, purpose: string): Promise<PhoneCall> {
  const c = cfg();
  const call: PhoneCall = {
    id: crypto.randomUUID().replace(/-/g, '').slice(0, 16),
    roomId,
    purpose: purpose || message,
    message,
    transcript: [],
    status: 'dialing',
    startedAt: Date.now(),
    turns: 0,
    waiters: [],
  };
  calls.set(call.id, call);
  const body = new URLSearchParams({
    To: c.to,
    From: c.from,
    Url: `${c.base}/api/phone/voice?c=${call.id}`,
    Method: 'POST',
    StatusCallback: `${c.base}/api/phone/status?c=${call.id}`,
    StatusCallbackMethod: 'POST',
    Timeout: '30',
  });
  body.append('StatusCallbackEvent', 'completed');
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(c.sid)}/Calls.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${c.sid}:${c.token}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { message?: string };
    calls.delete(call.id);
    throw new Error(j.message || `Twilio answered ${r.status}`);
  }
  broadcastRoomEvent(roomId, 'phone:call', publicCall(call));
  return call;
}

export const phoneToolDeclarations: FunctionDeclaration[] = [
  {
    name: 'phone_call_me',
    description:
      'Ring Ray’s REAL phone number (normal phone call, works even when no RAY app is open) and talk with him: RAY says the message, listens, and replies until he says bye. Use when Ray says "call me / phone me when …", for urgent alerts, or mid-mission when you need his decision — set waitForReply true to get what he said back and continue the task. For ringing the RAY app instead use call_me.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        message: { type: Type.STRING, description: 'First thing RAY says when he picks up (1–2 sentences).' },
        purpose: { type: Type.STRING, description: 'Why you are calling / what answer you need.' },
        waitForReply: { type: Type.BOOLEAN, description: 'Wait (up to 4 min) for the call to end and return the transcript. Default true.' },
      },
      required: ['message'],
    },
  },
];

export async function executePhoneTool(roomId: string, name: string, args: Record<string, unknown>): Promise<{ result: string } | null> {
  if (name !== 'phone_call_me') return null;
  const st = phoneLineStatus();
  if (!st.configured) return { result: `The phone line is not set up (missing ${st.missing.join(', ')} in Render — see README → Phone line). Use call_me to ring the RAY app instead.` };
  const message = String(args.message || '').trim().slice(0, 500);
  if (!message) return { result: 'message is required.' };
  let call: PhoneCall;
  try {
    call = await startPhoneCall(roomId, message, String(args.purpose || ''));
  } catch (err) {
    return { result: `Could not place the call: ${err instanceof Error ? err.message : err}` };
  }
  if (args.waitForReply === false) return { result: `Calling Ray’s phone (${st.number}) now.` };
  const done = await new Promise<PhoneCall | null>((resolve) => {
    const t = setTimeout(() => resolve(null), 4 * 60_000);
    call.waiters.push((c) => {
      clearTimeout(t);
      resolve(c);
    });
  });
  const said = call.transcript.filter((x) => x.who === 'Ray').map((x) => x.text);
  if (!done) return { result: `Call still running after 4 min. Ray said so far: ${said.join(' | ') || '(nothing yet)'}` };
  if (done.status !== 'completed') return { result: `Ray did not pick up (${done.status}). Try call_me or a notification.` };
  return { result: said.length ? `Ray said: ${said.join(' | ')}\nFull call: ${done.transcript.map((x) => `${x.who}: ${x.text}`).join(' / ')}` : 'Ray picked up but said nothing.' };
}
