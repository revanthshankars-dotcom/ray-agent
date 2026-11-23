/**
 * Durable storage for RAY room state.
 *
 * Backends (picked automatically, first that works):
 *  - Google Cloud Storage when RAY_GCS_BUCKET is set (Cloud Run credentials automatically,
 *    or GCP_SERVICE_ACCOUNT_JSON on other hosts such as Render).
 *  - Cloudflare Workers KV when CLOUDFLARE_API_TOKEN is set (namespace "ray-state" is created
 *    automatically; needs the token's "Workers KV Storage: Edit" permission).
 *  - Local JSON files in .relay-data/ otherwise (wiped on Render free restarts!).
 *
 * Writes are debounced per key so hot paths (telemetry, notes edits) never block.
 */
import fs from 'fs';
import path from 'path';

type Json = Record<string, unknown>;

const LOCAL_DIR = path.join(process.cwd(), '.relay-data', 'state');
const BUCKET_NAME = (process.env.RAY_GCS_BUCKET || '').trim();
const PREFIX = (process.env.RAY_GCS_PREFIX || 'ray').replace(/^\/+|\/+$/g, '');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let bucketPromise: Promise<any | null> | null = null;

async function getBucket() {
  if (!BUCKET_NAME) return null;
  if (!bucketPromise) {
    bucketPromise = import('@google-cloud/storage')
      .then(({ Storage }) => {
        const saJson = (process.env.GCP_SERVICE_ACCOUNT_JSON || '').trim();
        if (saJson) {
          const credentials = JSON.parse(saJson) as { project_id?: string };
          return new Storage({ credentials, projectId: credentials.project_id }).bucket(BUCKET_NAME);
        }
        return new Storage().bucket(BUCKET_NAME);
      })
      .catch((err) => {
        console.warn('[RAY persistence] GCS unavailable, falling back to local files:', err?.message || err);
        return null;
      });
  }
  return bucketPromise;
}

// ---------------------------------------------------------------------------
// Cloudflare Workers KV backend
// ---------------------------------------------------------------------------

interface KvTarget {
  base: string;
  token: string;
}
let kvPromise: Promise<KvTarget | null> | null = null;

function cfEnv(name: string): string {
  const v = (process.env[name] || '').trim();
  return /^(unset|none)$/i.test(v) ? '' : v;
}

async function getKv(): Promise<KvTarget | null> {
  if (BUCKET_NAME) return null;
  const token = cfEnv('CLOUDFLARE_API_TOKEN');
  if (!token || /^(off|false|0)$/i.test(process.env.RAY_CF_KV || '')) return null;
  if (!kvPromise) {
    kvPromise = (async () => {
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      let account = cfEnv('CLOUDFLARE_ACCOUNT_ID');
      if (!account) {
        const r = await fetch('https://api.cloudflare.com/client/v4/accounts?per_page=5', { headers, signal: AbortSignal.timeout(8000) });
        account = ((await r.json()) as { result?: Array<{ id: string }> }).result?.[0]?.id || '';
      }
      if (!account) throw new Error('no Cloudflare account visible to this token');
      const nsBase = `https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces`;
      let nsId = cfEnv('RAY_CF_KV_NAMESPACE_ID');
      if (!nsId) {
        const list = (await (await fetch(`${nsBase}?per_page=100`, { headers, signal: AbortSignal.timeout(8000) })).json()) as {
          success?: boolean;
          result?: Array<{ id: string; title: string }>;
          errors?: Array<{ message: string }>;
        };
        if (!list.success) throw new Error(list.errors?.[0]?.message || 'KV list failed (token needs Workers KV permission)');
        nsId = list.result?.find((n) => n.title === 'ray-state')?.id || '';
        if (!nsId) {
          const created = (await (
            await fetch(nsBase, { method: 'POST', headers, body: JSON.stringify({ title: 'ray-state' }), signal: AbortSignal.timeout(8000) })
          ).json()) as { result?: { id: string }; errors?: Array<{ message: string }> };
          nsId = created.result?.id || '';
          if (!nsId) throw new Error(created.errors?.[0]?.message || 'could not create KV namespace');
        }
      }
      console.log('[RAY persistence] Using Cloudflare KV namespace', nsId);
      return { base: `${nsBase}/${nsId}/values`, token };
    })().catch((err) => {
      console.warn('[RAY persistence] Cloudflare KV unavailable, using local files:', (err as Error).message);
      activeBackend = 'local';
      return null;
    });
  }
  return kvPromise;
}

let activeBackend: 'gcs' | 'cloudflare-kv' | 'local' = BUCKET_NAME ? 'gcs' : cfEnv('CLOUDFLARE_API_TOKEN') ? 'cloudflare-kv' : 'local';

export function persistenceBackend(): 'gcs' | 'cloudflare-kv' | 'local' {
  return activeBackend;
}

function safeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

export async function loadJson<T extends Json>(key: string): Promise<T | null> {
  const k = safeKey(key);
  const bucket = await getBucket();
  if (bucket) {
    try {
      const [buf] = await bucket.file(`${PREFIX}/${k}.json`).download();
      return JSON.parse(buf.toString('utf8')) as T;
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (code !== 404) console.warn('[RAY persistence] GCS read failed for', k, (err as Error).message);
      // fall through to local copy (useful on first migration)
    }
  }
  const kv = await getKv();
  if (kv) {
    try {
      const r = await fetch(`${kv.base}/${encodeURIComponent(`${PREFIX}/${k}`)}`, {
        headers: { Authorization: `Bearer ${kv.token}` },
        signal: AbortSignal.timeout(10000),
      });
      if (r.ok) return JSON.parse(await r.text()) as T;
    } catch (err) {
      console.warn('[RAY persistence] KV read failed for', k, (err as Error).message);
    }
  }
  try {
    const p = path.join(LOCAL_DIR, `${k}.json`);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
  } catch {
    // corrupt file -> treat as empty
  }
  return null;
}

export function loadJsonSync<T extends Json>(key: string): T | null {
  try {
    const p = path.join(LOCAL_DIR, `${safeKey(key)}.json`);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
  } catch {
    // ignore
  }
  return null;
}

async function writeNow(key: string, value: Json): Promise<void> {
  const k = safeKey(key);
  const body = JSON.stringify(value);
  try {
    fs.mkdirSync(LOCAL_DIR, { recursive: true });
    fs.writeFileSync(path.join(LOCAL_DIR, `${k}.json`), body, { mode: 0o600 });
  } catch {
    // read-only FS (e.g. some serverless) – GCS still gets the write
  }
  const kv = await getKv();
  if (kv) {
    try {
      const r = await fetch(`${kv.base}/${encodeURIComponent(`${PREFIX}/${k}`)}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${kv.token}`, 'Content-Type': 'text/plain' },
        body,
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) console.warn('[RAY persistence] KV write failed for', k, r.status);
    } catch (err) {
      console.warn('[RAY persistence] KV write failed for', k, (err as Error).message);
    }
  }
  const bucket = await getBucket();
  if (bucket) {
    try {
      await bucket.file(`${PREFIX}/${k}.json`).save(body, {
        contentType: 'application/json',
        resumable: false,
      });
    } catch (err) {
      console.warn('[RAY persistence] GCS write failed for', k, (err as Error).message);
    }
  }
}

const pending = new Map<string, { timer: NodeJS.Timeout; getValue: () => Json }>();

/** Debounced save. `getValue` is evaluated at flush time so the latest state wins. */
export function scheduleSave(key: string, getValue: () => Json, delayMs = 1500): void {
  // Cloudflare KV free tier = 1,000 writes/day: coalesce to at most one write per key per 5 min.
  // (Pending writes are flushed on SIGTERM, which Render/Cloud Run send before stopping.)
  if (activeBackend === 'cloudflare-kv') {
    if (pending.has(key)) {
      pending.get(key)!.getValue = getValue;
      return;
    }
    delayMs = Math.max(delayMs, Number(process.env.RAY_KV_WRITE_INTERVAL_MS || 300_000));
  }
  const existing = pending.get(key);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    const entry = pending.get(key);
    pending.delete(key);
    void writeNow(key, (entry?.getValue || getValue)());
  }, delayMs);
  pending.set(key, { timer, getValue });
}

export async function flushAll(): Promise<void> {
  const jobs: Promise<void>[] = [];
  for (const [key, p] of pending) {
    clearTimeout(p.timer);
    jobs.push(writeNow(key, p.getValue()));
  }
  pending.clear();
  await Promise.allSettled(jobs);
}

let shutdownHooked = false;
export function installShutdownFlush(): void {
  if (shutdownHooked) return;
  shutdownHooked = true;
  const handler = (sig: string) => {
    void flushAll().finally(() => process.exit(sig === 'SIGINT' ? 130 : 0));
  };
  process.once('SIGTERM', () => handler('SIGTERM'));
  process.once('SIGINT', () => handler('SIGINT'));
}
