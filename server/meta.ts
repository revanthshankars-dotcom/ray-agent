/**
 * Meta apps (WhatsApp + Instagram) — official APIs only.
 *
 * SENDING
 *  - WhatsApp Cloud API: needs a WhatsApp Business number (free tier: 1,000 service
 *    conversations/month). Env: WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID.
 *  - Instagram Messaging API: needs an Instagram Professional (Business/Creator) account
 *    linked to a Facebook Page. Env: INSTAGRAM_ACCESS_TOKEN (+ optional INSTAGRAM_ACCOUNT_ID).
 *    Instagram only allows replying to people who messaged you in the last 24h.
 *  - Personal accounts: RAY opens the chat with the message pre-filled on your phone/PC
 *    (deep link) and you tap send — or, on a PC with Screen Control armed, RAY presses Enter
 *    after you approve. Unofficial "WhatsApp Web" automation is deliberately not used:
 *    it violates Meta's terms and gets numbers banned.
 *
 * RECEIVING
 *  - Webhook at /api/meta/webhook (verify token META_VERIFY_TOKEN, signature checked with
 *    META_APP_SECRET) for the official APIs.
 *  - Android phone bridge relays WhatsApp / Instagram notifications for personal accounts.
 */
import crypto from 'crypto';
import { loadJson, scheduleSave } from './persistence.ts';
import { normalizeRoomId, recordIncomingMessage } from './hub.ts';

const GRAPH = 'https://graph.facebook.com/v21.0';

function env(name: string): string {
  const v = (process.env[name] || '').trim();
  return /^(unset|none)$/i.test(v) ? '' : v;
}

export function metaStatus() {
  return {
    whatsappCloud: Boolean(env('WHATSAPP_TOKEN') && env('WHATSAPP_PHONE_NUMBER_ID')),
    instagramApi: Boolean(env('INSTAGRAM_ACCESS_TOKEN')),
    webhookReady: Boolean(env('META_VERIFY_TOKEN')),
  };
}

// Instagram replies need the sender's IG-scoped id; remember them from incoming webhooks.
let igContacts: Record<string, string> = {};
let contactsLoaded = false;
async function loadContacts() {
  if (contactsLoaded) return;
  contactsLoaded = true;
  const stored = await loadJson<{ ig?: Record<string, string> }>('meta-contacts');
  igContacts = stored?.ig || {};
}
function rememberIgContact(name: string, id: string) {
  igContacts[name.toLowerCase()] = id;
  scheduleSave('meta-contacts', () => ({ ig: igContacts }));
}

export async function sendWhatsAppCloud(to: string, text: string): Promise<string> {
  const token = env('WHATSAPP_TOKEN');
  const phoneId = env('WHATSAPP_PHONE_NUMBER_ID');
  if (!token || !phoneId) throw new Error('WhatsApp Cloud API not configured');
  const digits = to.replace(/[^\d]/g, '');
  if (digits.length < 8) throw new Error('WhatsApp Cloud API needs a phone number with country code.');
  const r = await fetch(`${GRAPH}/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: digits, type: 'text', text: { body: text.slice(0, 4000) } }),
    signal: AbortSignal.timeout(15000),
  });
  const j = (await r.json().catch(() => ({}))) as { error?: { message?: string }; messages?: Array<{ id: string }> };
  if (!r.ok) throw new Error(j.error?.message || `WhatsApp API HTTP ${r.status}`);
  return `WhatsApp message sent to +${digits} (id ${j.messages?.[0]?.id || 'ok'}).`;
}

export async function sendInstagramDm(to: string, text: string): Promise<string> {
  await loadContacts();
  const token = env('INSTAGRAM_ACCESS_TOKEN');
  if (!token) throw new Error('Instagram Messaging API not configured');
  const recipientId = /^\d{6,}$/.test(to) ? to : igContacts[to.toLowerCase().replace(/^@/, '')];
  if (!recipientId) {
    throw new Error(`Instagram only allows replying to people who messaged you recently, and "${to}" has no recent conversation.`);
  }
  const accountPath = env('INSTAGRAM_ACCOUNT_ID') || 'me';
  const r = await fetch(`${GRAPH}/${accountPath}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: recipientId }, message: { text: text.slice(0, 1000) } }),
    signal: AbortSignal.timeout(15000),
  });
  const j = (await r.json().catch(() => ({}))) as { error?: { message?: string } };
  if (!r.ok) throw new Error(j.error?.message || `Instagram API HTTP ${r.status}`);
  return `Instagram DM sent to ${to}.`;
}

/** Deep link that opens a chat with the text pre-filled (personal accounts). */
export function buildComposeLink(app: string, to: string, text: string, platform: 'android' | 'desktop'): string | null {
  const t = encodeURIComponent(text);
  const digits = to.replace(/[^\d]/g, '');
  const handle = to.replace(/^@/, '').trim();
  switch (app) {
    case 'whatsapp':
      if (digits.length >= 8) return platform === 'android' ? `https://wa.me/${digits}?text=${t}` : `whatsapp://send?phone=${digits}&text=${t}`;
      return platform === 'android' ? `https://wa.me/?text=${t}` : `whatsapp://send?text=${t}`;
    case 'instagram':
      return handle ? `https://ig.me/m/${encodeURIComponent(handle)}` : 'https://www.instagram.com/direct/inbox/';
    case 'messenger':
      return handle ? `https://m.me/${encodeURIComponent(handle)}` : 'https://www.messenger.com/';
    case 'telegram':
      return handle && !digits ? `https://t.me/${encodeURIComponent(handle)}` : `tg://msg?text=${t}`;
    case 'sms':
      return `sms:${digits}?body=${t}`;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Webhook (incoming WhatsApp Cloud + Instagram messages)
// ---------------------------------------------------------------------------

export function verifyMetaWebhook(query: Record<string, unknown>): string | null {
  const mode = String(query['hub.mode'] || '');
  const token = String(query['hub.verify_token'] || '');
  const challenge = String(query['hub.challenge'] || '');
  const expected = env('META_VERIFY_TOKEN');
  if (mode === 'subscribe' && expected && token === expected) return challenge;
  return null;
}

export function checkMetaSignature(rawBody: Buffer | undefined, signatureHeader: string | undefined): boolean {
  const secret = env('META_APP_SECRET');
  if (!secret) return false; // never accept unsigned webhook posts (would allow fake messages)
  if (!rawBody || !signatureHeader?.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const given = signatureHeader.slice(7);
  return expected.length === given.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given));
}

interface MetaWebhookBody {
  object?: string;
  entry?: Array<{
    changes?: Array<{
      value?: {
        contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
        messages?: Array<{ from?: string; timestamp?: string; type?: string; text?: { body?: string } }>;
      };
    }>;
    messaging?: Array<{ sender?: { id?: string }; timestamp?: number; message?: { text?: string; is_echo?: boolean } }>;
  }>;
}

export async function handleMetaWebhook(body: MetaWebhookBody): Promise<number> {
  await loadContacts();
  const roomId = normalizeRoomId(process.env.RAY_DEFAULT_ROOM || 'RLY-HOME');
  let n = 0;
  for (const entry of body.entry || []) {
    // WhatsApp Cloud API
    for (const ch of entry.changes || []) {
      const v = ch.value || {};
      const nameByWa = new Map((v.contacts || []).map((c) => [c.wa_id || '', c.profile?.name || '']));
      for (const m of v.messages || []) {
        const text = m.text?.body || (m.type ? `[${m.type}]` : '');
        const from = nameByWa.get(m.from || '') || `+${m.from}`;
        if (recordIncomingMessage(roomId, { app: 'whatsapp', from: `${from} (+${m.from})`, text, receivedAt: Number(m.timestamp) * 1000 || Date.now(), viaDevice: 'WhatsApp Cloud API' })) n++;
      }
    }
    // Instagram Messaging
    for (const ev of entry.messaging || []) {
      if (!ev.message?.text || ev.message.is_echo) continue;
      const senderId = ev.sender?.id || '';
      let name = senderId;
      const token = env('INSTAGRAM_ACCESS_TOKEN');
      if (token && senderId) {
        try {
          const r = await fetch(`${GRAPH}/${senderId}?fields=username,name&access_token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(5000) });
          const j = (await r.json()) as { username?: string; name?: string };
          name = j.username || j.name || senderId;
        } catch {
          // keep id
        }
      }
      if (senderId) rememberIgContact(name, senderId);
      if (recordIncomingMessage(roomId, { app: 'instagram', from: name, text: ev.message.text, receivedAt: ev.timestamp || Date.now(), viaDevice: 'Instagram API' })) n++;
    }
  }
  return n;
}
