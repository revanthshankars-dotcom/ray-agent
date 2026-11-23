/**
 * Durable storage for RAY room state.
 *
 * Backends (picked automatically):
 *  - Google Cloud Storage when RAY_GCS_BUCKET is set (uses Application Default
 *    Credentials, which Cloud Run provides automatically).
 *  - Local JSON files in .relay-data/ otherwise.
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
      .then(({ Storage }) => new Storage().bucket(BUCKET_NAME))
      .catch((err) => {
        console.warn('[RAY persistence] GCS unavailable, falling back to local files:', err?.message || err);
        return null;
      });
  }
  return bucketPromise;
}

export function persistenceBackend(): 'gcs' | 'local' {
  return BUCKET_NAME ? 'gcs' : 'local';
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
  const existing = pending.get(key);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    pending.delete(key);
    void writeNow(key, getValue());
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
