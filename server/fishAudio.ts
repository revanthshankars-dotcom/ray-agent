/**
 * Fish Audio — natural, expressive text-to-speech (and voice cloning) for RAY's voice.
 *
 * Env:
 *   FISH_AUDIO_API_KEY   (also read from FISH_API_KEY / FISHAUDIO_API_KEY or any "sk-fish-…" value)
 *   FISH_AUDIO_VOICE_ID  optional voice model id from fish.audio (e.g. a JARVIS-style British voice)
 *   FISH_AUDIO_MODEL     optional TTS model header (default "s1")
 */
const FISH_BASE = 'https://api.fish.audio';

export function getFishKey(): string | null {
  for (const name of ['FISH_AUDIO_API_KEY', 'FISH_API_KEY', 'FISHAUDIO_API_KEY', 'FISH_AUDIO_KEY', 'FISH_KEY']) {
    const v = (process.env[name] || '').trim();
    if (v && !/^(unset|none)$/i.test(v)) return v;
  }
  for (const val of Object.values(process.env)) {
    const v = (val || '').trim();
    if (/^sk-fish-[A-Za-z0-9_-]{20,}$/.test(v)) return v;
  }
  return null;
}

export interface FishKeyStatus {
  configured: boolean;
  valid: boolean | null;
  credit?: number | string;
  status?: number;
  error?: string;
  checkedAt?: number;
}

let lastStatus: FishKeyStatus = { configured: false, valid: null };

export function getFishStatus(): FishKeyStatus {
  return { ...lastStatus, configured: Boolean(getFishKey()) };
}

/** Validate the key with an authenticated, free endpoint (API credit balance). */
export async function checkFishKey(): Promise<FishKeyStatus> {
  const key = getFishKey();
  if (!key) return (lastStatus = { configured: false, valid: null });
  try {
    const r = await fetch(`${FISH_BASE}/wallet/self/api-credit`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10000),
    });
    const text = await r.text();
    let credit: number | string | undefined;
    try {
      const j = JSON.parse(text) as { credit?: number | string };
      credit = j.credit;
    } catch {
      // non-JSON body
    }
    lastStatus = {
      configured: true,
      valid: r.ok ? true : r.status === 401 || r.status === 403 ? false : null,
      credit,
      status: r.status,
      error: r.ok ? undefined : text.slice(0, 200),
      checkedAt: Date.now(),
    };
  } catch (err) {
    lastStatus = { configured: true, valid: null, error: (err as Error).message, checkedAt: Date.now() };
  }
  return lastStatus;
}

/** Text → speech (MP3, base64). Throws on failure so callers can fall back. */
export async function fishTts(text: string, voiceId?: string): Promise<{ audioBase64: string; mimeType: string }> {
  const key = getFishKey();
  if (!key) throw new Error('Fish Audio key not configured');
  const clean = text.replace(/[#*`_~[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 1500);
  const body: Record<string, unknown> = { text: clean || 'Right away, Ray.', format: 'mp3', mp3_bitrate: 128, latency: 'balanced' };
  const ref = (voiceId || process.env.FISH_AUDIO_VOICE_ID || '').trim();
  if (ref) body.reference_id = ref;
  const r = await fetch(`${FISH_BASE}/v1/tts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      model: process.env.FISH_AUDIO_MODEL || 's1',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) {
    const err = await r.text().catch(() => '');
    if (r.status === 401 || r.status === 403) lastStatus = { ...lastStatus, configured: true, valid: false, status: r.status };
    throw new Error(`Fish Audio TTS failed (${r.status}): ${err.slice(0, 160)}`);
  }
  const buf = Buffer.from(await r.arrayBuffer());
  return { audioBase64: buf.toString('base64'), mimeType: 'audio/mpeg' };
}
