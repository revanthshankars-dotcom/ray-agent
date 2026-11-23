/**
 * RAY edge front door (Cloudflare Worker "ray-hub").
 *  - fetch:     forwards EVERYTHING (web app, /api, /ws, /live-jarvis WebSockets) to the RAY hub
 *               at RAY_BACKEND_URL (e.g. Render), so the app is reachable at
 *               https://ray-hub.<subdomain>.workers.dev.
 *  - scheduled: pings the hub every 10 minutes so Render's free plan never sleeps.
 */
export default {
  async fetch(request, env) {
    const backend = String(env.RAY_BACKEND_URL || '').trim().replace(/\/+$/, '');
    if (!backend) {
      return new Response(
        '<!doctype html><meta charset="utf-8"><title>RAY</title><body style="font:16px system-ui;padding:40px;background:#0b1120;color:#e2e8f0">' +
          '<h1>RAY edge is deployed</h1><p>Set <code>RAY_BACKEND_URL</code> on this Worker to your RAY hub (Render) URL to go live.</p></body>',
        { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
      );
    }
    const incoming = new URL(request.url);
    const target = new URL(incoming.pathname + incoming.search, backend);
    const headers = new Headers(request.headers);
    headers.set('X-Forwarded-Host', incoming.host);
    headers.set('X-Forwarded-Proto', incoming.protocol.replace(':', ''));
    headers.delete('host');
    // WebSocket upgrades pass straight through fetch() on Cloudflare.
    return fetch(new Request(target.toString(), new Request(request, { headers, redirect: 'manual' })));
  },

  async scheduled(_event, env, ctx) {
    const backend = String(env.RAY_BACKEND_URL || '').trim().replace(/\/+$/, '');
    if (backend) ctx.waitUntil(fetch(`${backend}/api/health`, { headers: { 'User-Agent': 'ray-keepalive' } }).catch(() => {}));
  },
};
