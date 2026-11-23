import { useCallback, useEffect, useState } from 'react';
import { authFetch } from '../utils/roomAuth';

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export type PushWakeStatus = 'unsupported' | 'disabled' | 'enabled' | 'denied' | 'working';

/**
 * Registers this device for Web Push so RAY (running in the cloud) can wake it
 * while the app is closed — e.g. "open YouTube on my phone" sent from the PC.
 * Subscribes automatically once notifications are allowed.
 */
export function usePushWake(roomId: string, deviceId: string, onWake?: () => void) {
  const supported =
    typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const [status, setStatus] = useState<PushWakeStatus>(() => {
    if (!supported) return 'unsupported';
    if (Notification.permission === 'denied') return 'denied';
    return 'disabled';
  });

  const subscribe = useCallback(
    async (askPermission: boolean) => {
      if (!supported) return false;
      try {
        if (Notification.permission === 'default') {
          if (!askPermission) return false;
          const perm = await Notification.requestPermission();
          if (perm !== 'granted') {
            setStatus(perm === 'denied' ? 'denied' : 'disabled');
            return false;
          }
        }
        if (Notification.permission !== 'granted') {
          setStatus('denied');
          return false;
        }
        setStatus('working');
        const keyResp = await fetch('/api/push/vapid');
        const { publicKey } = (await keyResp.json()) as { publicKey?: string };
        if (!publicKey) {
          setStatus('disabled');
          return false;
        }
        const reg = await navigator.serviceWorker.ready;
        let sub = await reg.pushManager.getSubscription();
        if (!sub) {
          sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
          });
        }
        const resp = await authFetch('/api/push/subscribe', roomId, {
          method: 'POST',
          body: JSON.stringify({ roomId, deviceId, subscription: sub.toJSON() }),
        });
        setStatus(resp.ok ? 'enabled' : 'disabled');
        return resp.ok;
      } catch {
        setStatus('disabled');
        return false;
      }
    },
    [deviceId, roomId, supported]
  );

  // Silent auto-subscribe when permission was already granted earlier.
  useEffect(() => {
    if (supported && Notification.permission === 'granted') void subscribe(false);
  }, [subscribe, supported]);

  // The service worker posts "ray:wake" when a push lands while RAY is open in the background.
  useEffect(() => {
    if (!supported) return;
    const handler = (evt: MessageEvent) => {
      if (evt.data?.type === 'ray:wake') onWake?.();
    };
    navigator.serviceWorker.addEventListener('message', handler);
    return () => navigator.serviceWorker.removeEventListener('message', handler);
  }, [onWake, supported]);

  return { status, enable: () => subscribe(true) };
}
