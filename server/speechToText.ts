/**
 * ACCURATE VOICE — free Whisper speech-to-text with Ray's own vocabulary.
 *
 * The browser's built-in recogniser cuts Ray off and mishears names. RAY now records each
 * utterance and transcribes it with Whisper large-v3-turbo:
 *   1. Groq (GROQ_API_KEY, free tier, fastest)
 *   2. Cloudflare Workers AI (CLOUDFLARE_API_TOKEN + _ACCOUNT_ID, free daily allowance)
 *   3. Gemini (GEMINI_API_KEY)
 * Each request carries a vocabulary hint built from Ray's memory (people, places, projects), his
 * devices, connectors, smart-home names and common apps — measured: "latch me / Pixelmest" →
 * "Lakshmi / Pixelnest". Whisper also handles Hindi/Tamil and mixed speech automatically.
 */
import { allKeys } from './engines/providers.ts';
import { getIncomingMessages, getRoomBrainNotes, getRoomDevices } from './hub.ts';
import { transcribeAudioClip } from './gemini.ts';

function env(n: string): string {
  const v = (process.env[n] || '').trim();
  return /^(unset|none)$/i.test(v) ? '' : v;
}

export function sttAvailable(): string | null {
  if (allKeys('GROQ_API_KEY').length) return 'groq';
  if (env('CLOUDFLARE_API_TOKEN') && env('CLOUDFLARE_ACCOUNT_ID')) return 'cloudflare';
  if (env('GEMINI_API_KEY')) return 'gemini';
  return null;
}

const COMMON = ['RAY', 'WhatsApp', 'YouTube', 'Spotify', 'Instagram', 'Gmail', 'Google Drive', 'Chrome', 'VS Code', 'Netflix', 'Telegram', 'Zoom', 'Google Meet', 'Notion'];
const STOP = new Set('The A An And Or But I My Me He She It We You They This That These Those Is Are Was Were Be On In At To For Of With From By As Ray RAY Ray’s Ray\'s When What Who Where Why How Monday Tuesday Wednesday Thursday Friday Saturday Sunday January February March April May June July August September October November December'.split(' '));

/** Proper nouns RAY should expect to hear: people, places, projects, devices, apps. */
export function vocabulary(roomId: string, max = 70): string[] {
  const words = new Map<string, number>();
  const bump = (w: string, n = 1) => {
    const t = w.trim().replace(/[’']s$/, '');
    if (t.length < 3 || t.length > 30 || STOP.has(t)) return;
    words.set(t, (words.get(t) || 0) + n);
  };
  const notes = getRoomBrainNotes(roomId);
  const mem = notes.find((n) => n.folder === 'Memory' && /about ray/i.test(n.title))?.content || '';
  for (const line of mem.split('\n').filter((l) => l.startsWith('- ')).slice(0, 120)) {
    for (const m of line.slice(2).matchAll(/(?:^|[\s(,])([A-Z][a-zA-Z0-9]+(?:\s[A-Z][a-zA-Z0-9]+)?)/g)) bump(m[1], 3);
  }
  for (const d of getRoomDevices(roomId)) bump(d.name.replace(/\s*\((OS Bridge|RAY Tabs|Chrome)\)/i, ''), 2);
  for (const m of getIncomingMessages(roomId, { limit: 40 })) if (m.from && !/^\+?\d/.test(m.from)) bump(m.from.split(/[<(]/)[0], 2);
  for (const n of notes.filter((x) => x.folder === 'Skills' || x.folder === 'Knowledge').slice(0, 20)) bump(n.title.replace(/^(Orbit|Skill):\s*/i, '').split(/[:—-]/)[0], 1);
  for (const c of COMMON) bump(c, 1);
  return [...words.entries()].sort((a, b) => b[1] - a[1]).map(([w]) => w).slice(0, max);
}

function promptFor(roomId: string): string {
  const v = vocabulary(roomId);
  return `Ray is speaking to his assistant RAY (commands about his devices, apps, messages and people). Names: ${v.join(', ')}.`.slice(0, 850);
}

// Whisper's classic hallucinations on silence / noise.
const HALLUCINATION = /^(thank you\.?|thanks for watching[.!]*|thank you for watching[.!]*|you|bye\.?|\.+|subtitles by.*|please subscribe.*|ok\.?)$/i;

function clean(text: string, prompt: string): string {
  let t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t || HALLUCINATION.test(t)) return '';
  if (prompt && t.includes(prompt.slice(0, 40))) return ''; // echoed the hint instead of speech
  return t;
}

async function groq(base64: string, mimeType: string, prompt: string): Promise<string> {
  const keys = allKeys('GROQ_API_KEY');
  let lastErr = '';
  for (const k of keys) {
    const form = new FormData();
    const ext = /ogg/.test(mimeType) ? 'ogg' : /mp4|m4a|aac/.test(mimeType) ? 'm4a' : /wav/.test(mimeType) ? 'wav' : /mpeg|mp3/.test(mimeType) ? 'mp3' : 'webm';
    form.append('file', new Blob([Buffer.from(base64, 'base64')], { type: mimeType || 'audio/webm' }), `speech.${ext}`);
    form.append('model', process.env.RAY_STT_MODEL || 'whisper-large-v3-turbo');
    form.append('prompt', prompt);
    form.append('temperature', '0');
    form.append('response_format', 'json');
    if (env('RAY_STT_LANG')) form.append('language', env('RAY_STT_LANG'));
    const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${k.value}` }, body: form, signal: AbortSignal.timeout(20000) });
    if (r.ok) return String(((await r.json()) as { text?: string }).text || '');
    lastErr = `Groq ${r.status}`;
    if (r.status !== 429 && r.status !== 401 && r.status !== 403) break;
  }
  throw new Error(lastErr || 'Groq failed');
}

async function cloudflare(base64: string, prompt: string): Promise<string> {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env('CLOUDFLARE_ACCOUNT_ID')}/ai/run/@cf/openai/whisper-large-v3-turbo`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('CLOUDFLARE_API_TOKEN')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      audio: base64,
      vad_filter: true,
      condition_on_previous_text: false,
      initial_prompt: prompt,
      ...(env('RAY_STT_LANG') ? { language: env('RAY_STT_LANG') } : {}),
    }),
    signal: AbortSignal.timeout(25000),
  });
  const j = (await r.json()) as { result?: { text?: string }; errors?: Array<{ message?: string }> };
  if (!r.ok) throw new Error(j.errors?.[0]?.message || `Cloudflare ${r.status}`);
  return String(j.result?.text || '');
}

/** Best available free transcription for one recorded utterance. */
export async function transcribeSpeech(roomId: string, base64: string, mimeType: string): Promise<{ transcript: string; engine: string }> {
  const prompt = promptFor(roomId);
  const tried: string[] = [];
  if (allKeys('GROQ_API_KEY').length) {
    try {
      return { transcript: clean(await groq(base64, mimeType, prompt), prompt), engine: 'groq-whisper' };
    } catch (e) {
      tried.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (env('CLOUDFLARE_API_TOKEN') && env('CLOUDFLARE_ACCOUNT_ID')) {
    try {
      return { transcript: clean(await cloudflare(base64, prompt), prompt), engine: 'cloudflare-whisper' };
    } catch (e) {
      tried.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (env('GEMINI_API_KEY')) return { transcript: clean(await transcribeAudioClip(base64, mimeType), ''), engine: 'gemini' };
  throw new Error(`No speech-to-text available${tried.length ? ` (${tried.join('; ')})` : ''}`);
}
