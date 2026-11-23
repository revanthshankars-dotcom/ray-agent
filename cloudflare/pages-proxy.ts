/**
 * Cloudflare Pages Functions → RAY backend proxy.
 *
 * Pages hosts the RAY web app (static build from GitHub). RAY's always-on hub (Express +
 * WebSockets + device bridges) runs on a Node host such as Render. These functions forward
 * /api/*, /ws and /live-jarvis to it, WebSocket upgrades included, so the whole app works
 * from https://<project>.pages.dev.
 *
 * Set RAY_BACKEND_URL in the Pages project (e.g. https://ray-hub.onrender.com).
 */
interface Env {
  RAY_BACKEND_URL?: string;
}

export async function proxyToBackend(context: { request: Request; env: Env }): Promise<Response> {
  const backend = (context.env.RAY_BACKEND_URL || '').trim().replace(/\/+$/, '');
  if (!backend) {
    return new Response(
      JSON.stringify({
        error: 'RAY backend not configured: set RAY_BACKEND_URL in Cloudflare Pages → Settings → Variables (e.g. your Render URL).',
      }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
  const incoming = new URL(context.request.url);
  const target = new URL(incoming.pathname + incoming.search, backend);
  const headers = new Headers(context.request.headers);
  headers.set('X-Forwarded-Host', incoming.host);
  headers.set('X-Forwarded-Proto', incoming.protocol.replace(':', ''));
  headers.delete('host');
  // fetch() passes WebSocket upgrades straight through on Cloudflare.
  return fetch(new Request(target.toString(), new Request(context.request, { headers, redirect: 'manual' })));
}
