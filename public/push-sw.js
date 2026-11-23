/* RAY push wake handler — imported into the Workbox service worker. */
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: 'RAY', body: event.data ? event.data.text() : '' };
  }
  const title = payload.title || 'RAY';
  const options = {
    body: payload.body || 'RAY has something for you.',
    icon: '/pwa-192x192.png',
    badge: '/pwa-192x192.png',
    tag: payload.tag || 'ray',
    renotify: true,
    requireInteraction: true,
    data: { url: payload.url || '/', ...(payload.data || {}) },
  };
  event.waitUntil(
    (async () => {
      // If RAY is already open somewhere, nudge it to reconnect instead of only notifying.
      const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of clientsList) c.postMessage({ type: 'ray:wake', payload });
      await self.registration.showNotification(title, options);
    })()
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    (async () => {
      const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of clientsList) {
        if ('focus' in c) {
          c.postMessage({ type: 'ray:wake' });
          return c.focus();
        }
      }
      return self.clients.openWindow(target);
    })()
  );
});
