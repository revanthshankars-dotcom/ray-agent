/**
 * RAY calling.
 *
 *  1. RAY calls Ray  — call_me: rings a device (phone by default) now, at a time, after N minutes,
 *     or daily/weekdays. Answering opens a voice conversation with RAY that starts with the message.
 *  2. Device ↔ device — call_device: rings another device; answering starts a live WebRTC audio
 *     call between the two (signalling via the hub, TURN via Cloudflare Realtime when configured).
 *  3. Call someone else — place_phone_call: the Android bridge dials a real number (contact names
 *     resolved on the phone); on a PC the dialer opens (tel: → Windows Phone Link). Always needs
 *     Ray's approval.
 *
 * Offline targets get the ring queued + a push notification ("Incoming call — RAY").
 */
import crypto from 'crypto';
import { Type } from '@google/genai';
import type { FunctionDeclaration } from '@google/genai';
import { createConfirmationRequest } from './capabilities.ts';
import { broadcastHudSound, dispatchBridgeProxyCall, dispatchDeviceCommand, getRoomDevices, pickExecutorDevice } from './hub.ts';
import { loadJson, scheduleSave } from './persistence.ts';
import type { CallPayload, ConfirmationRequest, ScheduledCall } from '../src/types/relay.ts';

// ---------------------------------------------------------------------------
// Ringing
// ---------------------------------------------------------------------------

export async function ringDevice(
  roomId: string,
  targetQuery: string,
  call: Omit<CallPayload, 'callId' | 'createdAt'>
): Promise<{ summary: string; callId: string }> {
  const payload: CallPayload = { ...call, callId: crypto.randomUUID(), createdAt: Date.now() };
  broadcastHudSound(roomId, 'alert');
  const { summary } = await dispatchDeviceCommand({
    roomId,
    type: 'call',
    targetQuery: targetQuery || 'phone',
    source: 'assistant',
    payload: payload as unknown as Record<string, unknown>,
    waitForAckMs: 4000,
  });
  return { summary, callId: payload.callId };
}

// ---------------------------------------------------------------------------
// Scheduler (persisted; survives restarts)
// ---------------------------------------------------------------------------

let schedule: Record<string, ScheduledCall[]> = {};
let loaded = false;

async function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  const stored = await loadJson<{ rooms?: Record<string, ScheduledCall[]> }>('scheduled-calls');
  schedule = stored?.rooms || {};
}

function save() {
  scheduleSave('scheduled-calls', () => ({ rooms: schedule }), 1000);
}

function nextOccurrence(from: number, repeat: ScheduledCall['repeat']): number {
  let t = from + 24 * 3600_000;
  if (repeat === 'weekdays') {
    while ([0, 6].includes(new Date(t).getUTCDay())) t += 24 * 3600_000;
  }
  return t;
}

export async function addScheduledCall(roomId: string, c: Omit<ScheduledCall, 'id' | 'createdAt'>): Promise<ScheduledCall> {
  await ensureLoaded();
  const item: ScheduledCall = { ...c, id: crypto.randomUUID().slice(0, 8), createdAt: Date.now() };
  (schedule[roomId] ||= []).push(item);
  save();
  return item;
}

export async function listScheduledCalls(roomId: string): Promise<ScheduledCall[]> {
  await ensureLoaded();
  return (schedule[roomId] || []).slice().sort((a, b) => a.nextAt - b.nextAt);
}

export async function cancelScheduledCall(roomId: string, idOrText: string): Promise<number> {
  await ensureLoaded();
  const before = (schedule[roomId] || []).length;
  const q = idOrText.toLowerCase();
  schedule[roomId] = (schedule[roomId] || []).filter((c) => !(c.id === idOrText || (q && c.message.toLowerCase().includes(q)) || q === 'all'));
  save();
  return before - schedule[roomId].length;
}

let tickerStarted = false;
export function startCallScheduler(): void {
  if (tickerStarted) return;
  tickerStarted = true;
  setInterval(async () => {
    await ensureLoaded();
    const now = Date.now();
    for (const roomId of Object.keys(schedule)) {
      for (const c of schedule[roomId]) {
        if (c.nextAt > now) continue;
        void ringDevice(roomId, c.targetDevice, { kind: 'ray', fromName: 'RAY', message: c.message });
        c.nextAt = c.repeat === 'none' ? 0 : nextOccurrence(c.nextAt, c.repeat);
      }
      schedule[roomId] = schedule[roomId].filter((c) => c.nextAt > 0);
    }
    save();
  }, 20_000).unref();
}

/** Parse "at" (ISO or HH:MM in the given UTC offset) / inMinutes into a timestamp. */
function resolveWhen(args: Record<string, unknown>): number | null {
  const inMin = Number(args.inMinutes);
  if (Number.isFinite(inMin) && inMin > 0) return Date.now() + inMin * 60_000;
  const at = String(args.at || '').trim();
  if (!at) return null;
  const hhmm = at.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/i);
  if (hhmm) {
    const ampm = (hhmm[3] || '').toLowerCase();
    const h = ampm ? (Number(hhmm[1]) % 12) + (ampm === 'pm' ? 12 : 0) : Number(hhmm[1]);
    const offsetMin = Number(args.utcOffsetMinutes ?? process.env.RAY_TZ_OFFSET_MINUTES ?? 330); // default IST
    const d = new Date();
    const local = new Date(d.getTime() + offsetMin * 60_000);
    local.setUTCHours(h, Number(hhmm[2]), 0, 0);
    let ts = local.getTime() - offsetMin * 60_000;
    if (ts <= Date.now()) ts += 24 * 3600_000;
    return ts;
  }
  const t = Date.parse(at);
  return Number.isNaN(t) ? null : t;
}

// ---------------------------------------------------------------------------
// WebRTC ICE servers (STUN + optional Cloudflare Realtime TURN for phones on mobile data)
// ---------------------------------------------------------------------------

export async function getIceServers(): Promise<RTCIceServerLike[]> {
  const servers: RTCIceServerLike[] = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
  const keyId = (process.env.CF_TURN_KEY_ID || '').trim();
  const token = (process.env.CF_TURN_KEY_API_TOKEN || '').trim();
  if (keyId && token) {
    try {
      const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: 86400 }),
        signal: AbortSignal.timeout(8000),
      });
      const j = (await r.json()) as { iceServers?: RTCIceServerLike[] | RTCIceServerLike };
      if (r.ok && j.iceServers) servers.push(...(Array.isArray(j.iceServers) ? j.iceServers : [j.iceServers]));
    } catch {
      // STUN only
    }
  }
  return servers;
}
interface RTCIceServerLike {
  urls: string | string[];
  username?: string;
  credential?: string;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export const callToolDeclarations: FunctionDeclaration[] = [
  {
    name: 'call_me',
    description:
      'Make RAY CALL Ray: ring his phone (or another device) with a full-screen incoming call; when he answers, RAY speaks the message and keeps talking. Use for "call me", "call me in 20 minutes", "wake me up at 6:30", "call me every weekday at 9 to remind me…". Omit at/inMinutes to ring now.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        message: { type: Type.STRING, description: 'What RAY says when Ray answers.' },
        targetDevice: { type: Type.STRING, description: 'Device to ring: "phone" (default), "pc", or a device name.' },
        inMinutes: { type: Type.NUMBER, description: 'Ring after this many minutes.' },
        at: { type: Type.STRING, description: 'Clock time "06:30" / "6:30 pm" (Ray’s local time) or ISO date-time.' },
        repeat: { type: Type.STRING, description: 'none (default) | daily | weekdays' },
      },
      required: ['message'],
    },
  },
  {
    name: 'call_device',
    description:
      'Start a LIVE voice call between two of Ray’s devices, e.g. from his work PC to his phone. The target rings; when answered, both are connected (two-way audio). The caller is the device Ray is speaking on.',
    parameters: {
      type: Type.OBJECT,
      properties: { targetDevice: { type: Type.STRING, description: 'Device to call: "phone", "pc", or a device name.' } },
      required: ['targetDevice'],
    },
  },
  {
    name: 'place_phone_call',
    description:
      'Call SOMEONE ELSE by phone: Ray’s Android phone dials the number (contact names are looked up on the phone). On a PC the dialer opens via tel: (Windows Phone Link). Only when Ray explicitly asks to call a person.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        to: { type: Type.STRING, description: 'Contact name as saved on the phone, or a phone number with country code.' },
        via: { type: Type.STRING, description: '"phone" (default) or "pc".' },
      },
      required: ['to'],
    },
  },
  {
    name: 'manage_scheduled_calls',
    description: 'List or cancel RAY’s scheduled calls (wake-up calls, reminders).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        action: { type: Type.STRING, description: 'list | cancel' },
        id: { type: Type.STRING, description: 'Call id, text from its message, or "all" (for cancel).' },
      },
      required: ['action'],
    },
  },
];

export async function executeCallTool(
  roomId: string,
  sourceDeviceName: string,
  name: string,
  args: Record<string, unknown>,
  opts: { confirmed: boolean }
): Promise<{ result: string; confirmation?: ConfirmationRequest } | null> {
  switch (name) {
    case 'call_me': {
      const message = String(args.message || 'Ray, you asked me to call you.').slice(0, 500);
      const target = String(args.targetDevice || 'phone');
      const repeat = (['daily', 'weekdays'].includes(String(args.repeat)) ? String(args.repeat) : 'none') as ScheduledCall['repeat'];
      const when = resolveWhen(args);
      if (when && when - Date.now() > 45_000) {
        const item = await addScheduledCall(roomId, { targetDevice: target, message, nextAt: when, repeat });
        return {
          result: `Scheduled call ${item.id}: I'll ring ${target} at ${new Date(when).toISOString()}${repeat !== 'none' ? ` (repeats ${repeat})` : ''} and say: "${message}".`,
        };
      }
      const { summary } = await ringDevice(roomId, target, { kind: 'ray', fromName: 'RAY', message });
      return { result: `Calling ${target} now. ${summary}` };
    }

    case 'call_device': {
      const target = String(args.targetDevice || 'phone');
      const devices = getRoomDevices(roomId);
      const caller = devices.find((d) => d.online && d.name === sourceDeviceName) || devices.find((d) => d.online && d.type !== 'bridge');
      if (!caller) return { result: 'I could not tell which device you are calling from. Open RAY on that device first.' };
      const { summary } = await ringDevice(roomId, target, { kind: 'peer', fromName: caller.name, fromDeviceId: caller.id });
      return { result: `Ringing ${target} from ${caller.name}. When it is answered you'll be connected. ${summary}` };
    }

    case 'place_phone_call': {
      const to = String(args.to || '').trim();
      if (!to) return { result: 'Who should I call?' };
      const via = String(args.via || 'phone');
      if (!opts.confirmed) {
        const req = createConfirmationRequest({
          roomId,
          toolName: 'place_phone_call',
          safetyLevel: 'sensitive',
          summary: `Place a phone call to ${to} from your ${via}.`,
          targetDevice: via,
          args,
        });
        broadcastHudSound(roomId, 'alert');
        return { result: `REQUIRES_CONFIRMATION: Ready to call ${to} from your ${via}. Waiting for Ray to tap Approve (confirmationId=${req.id}).`, confirmation: req };
      }
      const exec = pickExecutorDevice(roomId, via, 'app') || pickExecutorDevice(roomId, 'auto', 'app');
      if (!exec) {
        return { result: 'No phone or PC bridge is online to place the call. Start the RAY bridge on your Android phone (Termux) or PC.' };
      }
      const out = await dispatchBridgeProxyCall(roomId, { action: 'place_call', to }, 20000, exec.id);
      return {
        result: out.ok
          ? `${(out.data as { message?: string })?.message || `Calling ${to}`} (via ${out.deviceName}).`
          : `Could not place the call via ${exec.name}: ${out.error}`,
      };
    }

    case 'manage_scheduled_calls': {
      if (String(args.action) === 'cancel') {
        const n = await cancelScheduledCall(roomId, String(args.id || ''));
        return { result: n ? `Cancelled ${n} scheduled call(s).` : 'No matching scheduled call.' };
      }
      const list = await listScheduledCalls(roomId);
      return {
        result: list.length
          ? JSON.stringify(list.map((c) => ({ id: c.id, device: c.targetDevice, at: new Date(c.nextAt).toISOString(), repeat: c.repeat, message: c.message })))
          : 'No scheduled calls.',
      };
    }
    default:
      return null;
  }
}
