/**
 * Waking offline devices.
 *
 *  1. Web Push  – phones / PCs that installed the RAY PWA and allowed notifications get a
 *                 push even when the app is closed. Tapping it opens RAY, which reconnects
 *                 and immediately runs every queued command.
 *  2. Wake-on-LAN – a sleeping PC whose bridge reported its MAC address is woken by any
 *                 other online bridge on the same network (magic packet).
 *
 * VAPID keys come from RAY_VAPID_PUBLIC_KEY / RAY_VAPID_PRIVATE_KEY, or are generated once
 * and stored with the rest of RAY's durable state.
 */
import crypto from 'crypto';
import type { DeviceInfo } from '../src/types/relay.ts';
import { loadJson, scheduleSave } from './persistence.ts';

type WebPushModule = typeof import('web-push');

let vapid: { publicKey: string; privateKey: string } | null = null;
let webpush: WebPushModule | null = null;

export async function initWakeServices(): Promise<{ pushReady: boolean }> {
  try {
    const mod = await import('web-push');
    webpush = (mod as unknown as { default?: WebPushModule }).default || (mod as unknown as WebPushModule);
  } catch (err) {
    console.warn('[RAY wake] web-push not available:', (err as Error).message);
    return { pushReady: false };
  }

  const envPub = (process.env.RAY_VAPID_PUBLIC_KEY || '').trim();
  const envPriv = (process.env.RAY_VAPID_PRIVATE_KEY || '').trim();
  if (envPub && envPriv) {
    vapid = { publicKey: envPub, privateKey: envPriv };
  } else {
    const stored = await loadJson<{ publicKey?: string; privateKey?: string }>('vapid-keys');
    if (stored?.publicKey && stored.privateKey) {
      vapid = { publicKey: stored.publicKey, privateKey: stored.privateKey };
    } else {
      const generated = webpush.generateVAPIDKeys();
      vapid = generated;
      scheduleSave('vapid-keys', () => ({ ...generated }), 0);
    }
  }
  webpush.setVapidDetails(process.env.RAY_VAPID_SUBJECT || 'mailto:ray-assistant@example.invalid', vapid.publicKey, vapid.privateKey);
  return { pushReady: true };
}

export function getVapidPublicKey(): string | null {
  return vapid?.publicKey || null;
}

export async function sendPush(
  subscription: unknown,
  payload: { title: string; body: string; url?: string; tag?: string; data?: Record<string, unknown> }
): Promise<'sent' | 'expired' | 'failed'> {
  if (!webpush || !vapid) return 'failed';
  try {
    await webpush.sendNotification(subscription as Parameters<WebPushModule['sendNotification']>[0], JSON.stringify(payload), {
      TTL: 60 * 60,
      urgency: 'high',
    });
    return 'sent';
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 404 || status === 410) return 'expired';
    return 'failed';
  }
}

export async function wakeOfflineDevices(params: {
  roomId: string;
  targets: DeviceInfo[];
  onlineDevices: DeviceInfo[];
  pushSubscriptions: Record<string, unknown>;
  reason: string;
  sendToDevice: (deviceId: string, packet: Record<string, unknown>) => boolean;
  onExpiredSubscription: (deviceId: string) => void;
}): Promise<string> {
  const notes: string[] = [];

  for (const target of params.targets) {
    // 1) Web Push wake
    const sub = params.pushSubscriptions[target.id];
    if (sub) {
      const out = await sendPush(sub, {
        title: 'RAY needs this device',
        body: `${params.reason} — tap to run it now.`,
        url: '/?wake=1',
        tag: `ray-wake-${target.id}`,
        data: { roomId: params.roomId, deviceId: target.id },
      });
      if (out === 'sent') notes.push(`Sent a wake-up push to ${target.name}.`);
      if (out === 'expired') params.onExpiredSubscription(target.id);
    }

    // 2) Wake-on-LAN through any other online bridge
    if (target.macAddress) {
      const helper = params.onlineDevices.find((d) => d.type === 'bridge' && d.id !== target.id);
      if (helper) {
        const ok = params.sendToDevice(helper.id, {
          event: 'bridge:proxy_request',
          data: { requestId: crypto.randomUUID(), action: 'wake_on_lan', mac: target.macAddress },
        });
        if (ok) notes.push(`Asked ${helper.name} to send a Wake-on-LAN packet to ${target.name}.`);
      }
    }
  }

  if (notes.length === 0) {
    notes.push('Tip: open RAY once on that device and allow notifications so RAY can wake it remotely.');
  }
  return notes.join(' ');
}
