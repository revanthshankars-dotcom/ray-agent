/**
 * MEANING-BASED MEMORY — RAY recalls by meaning, not keywords ("my sister's birthday" finds
 * "Priya, born 12 March").
 *
 * Everything RAY knows — Memory/About Ray facts, Email Style, Knowledge notes, installed skills
 * and Ray's own notes — is split into small units and embedded with a FREE model:
 *   1. Gemini embeddings (GEMINI_API_KEY, free tier)            → 768 dims
 *   2. Cloudflare Workers AI bge-m3 (CLOUDFLARE_API_TOKEN + _ACCOUNT_ID, free daily allowance)
 * Only new/changed units are embedded; vectors are stored int8-quantised per room. Each request
 * embeds the message and pulls in only the closest facts, notes and playbooks (Luke's Day 2: small
 * prompt, the right facts). Without either key RAY falls back to keyword recall.
 */
import crypto from 'crypto';
import { GoogleGenAI } from '@google/genai';
import { getRoomBrainNotes, getRoomDevices, listRoomIds } from './hub.ts';
import { loadJson, scheduleSave } from './persistence.ts';
import type { BrainNote } from '../src/types/relay.ts';

type Kind = 'memory' | 'knowledge' | 'skill' | 'note';
interface Unit {
  h: string;
  kind: Kind;
  noteId: string;
  title: string;
  text: string;
  v: Int8Array;
}
interface RoomIndex {
  provider: string;
  units: Map<string, Unit>;
  building: Promise<void> | null;
  loaded: boolean;
}

const rooms = new Map<string, RoomIndex>();
const MAX_UNITS = 1500;
const MIN_SCORE = Number(process.env.RAY_RECALL_MIN || 0.5);

function env(n: string): string {
  const v = (process.env[n] || '').trim();
  return /^(unset|none)$/i.test(v) ? '' : v;
}

function provider(): 'gemini' | 'cloudflare' | null {
  if (env('GEMINI_API_KEY')) return 'gemini';
  if (env('CLOUDFLARE_API_TOKEN') && env('CLOUDFLARE_ACCOUNT_ID')) return 'cloudflare';
  return null;
}

async function embed(texts: string[], mode: 'doc' | 'query'): Promise<number[][]> {
  const p = provider();
  if (p === 'gemini') {
    const ai = new GoogleGenAI({ apiKey: env('GEMINI_API_KEY') });
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 90) {
      const r = await ai.models.embedContent({
        model: process.env.RAY_EMBED_MODEL || 'gemini-embedding-2',
        contents: texts.slice(i, i + 90),
        config: { taskType: mode === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT', outputDimensionality: 768 },
      });
      for (const e of r.embeddings || []) out.push(e.values || []);
    }
    return out;
  }
  if (p === 'cloudflare') {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 50) {
      const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env('CLOUDFLARE_ACCOUNT_ID')}/ai/run/@cf/baai/bge-m3`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env('CLOUDFLARE_API_TOKEN')}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: texts.slice(i, i + 50) }),
        signal: AbortSignal.timeout(30000),
      });
      const j = (await r.json()) as { result?: { data?: number[][] }; errors?: Array<{ message?: string }> };
      if (!r.ok || !j.result?.data) throw new Error(j.errors?.[0]?.message || `Cloudflare AI ${r.status}`);
      out.push(...j.result.data);
    }
    return out;
  }
  throw new Error('no embedding provider');
}

function quantize(v: number[]): Int8Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  const q = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) q[i] = Math.max(-127, Math.min(127, Math.round((v[i] / n) * 127)));
  return q;
}
function cosineQ(a: Int8Array, b: Int8Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const hash = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

function chunk(text: string, size = 700, max = 6): string[] {
  const paras = text.replace(/\r/g, '').split(/\n{2,}/).map((p) => p.trim()).filter((p) => p.length > 20);
  const out: string[] = [];
  let cur = '';
  for (const p of paras) {
    if ((cur + '\n\n' + p).length > size && cur) {
      out.push(cur);
      cur = '';
      if (out.length >= max) break;
    }
    cur = cur ? `${cur}\n\n${p}` : p.slice(0, size * 2);
  }
  if (cur && out.length < max) out.push(cur);
  return out;
}

function collect(roomId: string): Array<Omit<Unit, 'v'>> {
  const notes = [...getRoomBrainNotes(roomId)].sort((a, b) => b.updatedAt - a.updatedAt);
  const units: Array<Omit<Unit, 'v'>> = [];
  const add = (kind: Kind, n: BrainNote, text: string) => {
    const t = text.trim();
    if (t.length < 4) return;
    units.push({ h: hash(`${kind}|${n.title}|${t}`), kind, noteId: n.id, title: n.title, text: t.slice(0, 1500) });
  };
  for (const n of notes) {
    if (units.length >= MAX_UNITS) break;
    const body = n.content.replace(/^# .*\n+/, '');
    if (n.folder === 'Memory' && /about ray/i.test(n.title)) {
      for (const l of n.content.split('\n')) if (l.startsWith('- ')) add('memory', n, l.slice(2));
    } else if (n.folder === 'Skills' && n.tags.includes('orbit')) {
      add('skill', n, `${n.title}\n${body.slice(0, 900)}`);
    } else if (n.folder === 'Knowledge') {
      if (/^learning topics$/i.test(n.title)) continue;
      for (const c of chunk(body)) add('knowledge', n, `${n.title}\n${c}`);
    } else if (n.folder === 'System') {
      continue;
    } else {
      for (const c of chunk(body, 700, 3)) add('note', n, `${n.title}\n${c}`);
    }
  }
  return units.slice(0, MAX_UNITS);
}

// --- persistence (int8 vectors as base64) -------------------------------------------

interface Stored {
  provider: string;
  units: Array<Omit<Unit, 'v'> & { v: string }>;
}
async function getIndex(roomId: string): Promise<RoomIndex> {
  let idx = rooms.get(roomId);
  if (!idx) {
    idx = { provider: '', units: new Map(), building: null, loaded: false };
    rooms.set(roomId, idx);
  }
  if (!idx.loaded) {
    idx.loaded = true;
    const s = (await loadJson<Record<string, unknown>>(`semantic-${roomId}`).catch(() => null)) as unknown as Stored | null;
    if (s?.units?.length) {
      idx.provider = s.provider;
      for (const u of s.units) idx.units.set(u.h, { ...u, v: new Int8Array(Buffer.from(u.v, 'base64')) });
    }
  }
  return idx;
}
function persist(roomId: string, idx: RoomIndex) {
  scheduleSave(
    `semantic-${roomId}`,
    () => ({ provider: idx.provider, units: [...idx.units.values()].map((u) => ({ ...u, v: Buffer.from(u.v.buffer, u.v.byteOffset, u.v.byteLength).toString('base64') })) }) as unknown as Record<string, unknown>,
    5000
  );
}

/** Embeds new/changed units (background-safe; one build per room at a time). */
export async function refreshIndex(roomId: string): Promise<{ added: number; total: number }> {
  const p = provider();
  if (!p) return { added: 0, total: 0 };
  const idx = await getIndex(roomId);
  if (idx.building) {
    await idx.building;
    return { added: 0, total: idx.units.size };
  }
  let added = 0;
  idx.building = (async () => {
    if (idx.provider && idx.provider !== p) idx.units.clear(); // vectors from another model are not comparable
    idx.provider = p;
    const wanted = collect(roomId);
    const keep = new Set(wanted.map((u) => u.h));
    for (const h of idx.units.keys()) if (!keep.has(h)) idx.units.delete(h);
    const todo = wanted.filter((u) => !idx.units.has(u.h));
    for (let i = 0; i < todo.length; i += 90) {
      const batch = todo.slice(i, i + 90);
      const vecs = await embed(batch.map((u) => u.text), 'doc');
      batch.forEach((u, j) => {
        if (vecs[j]?.length) {
          idx.units.set(u.h, { ...u, v: quantize(vecs[j]) });
          added++;
        }
      });
    }
    if (added || todo.length !== wanted.length) persist(roomId, idx);
  })().finally(() => {
    idx.building = null;
  });
  await idx.building;
  return { added, total: idx.units.size };
}

export interface Recall {
  memory: string[];
  passages: Array<{ title: string; text: string; score: number }>;
  skills: Array<{ noteId: string; title: string; score: number }>;
}

/** The facts, passages and playbooks closest in meaning to this message, or null when unavailable. */
export async function semanticRecall(roomId: string, message: string): Promise<Recall | null> {
  const text = (message || '').trim();
  if (!provider() || text.length < 4) return null;
  const idx = await getIndex(roomId);
  // Don't make Ray wait for a big first build: use what is indexed, keep building in the background.
  const build = refreshIndex(roomId).catch((e) => console.warn('[RAY memory] index:', e instanceof Error ? e.message : e));
  await Promise.race([build, new Promise((r) => setTimeout(r, 2500))]);
  if (!idx.units.size) return null;
  let q: Int8Array;
  try {
    const [v] = await Promise.race([embed([text.slice(0, 2000)], 'query'), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))]);
    q = quantize(v);
  } catch {
    return null;
  }
  const scored = [...idx.units.values()].map((u) => ({ u, s: cosineQ(q, u.v) })).filter((x) => x.s >= MIN_SCORE).sort((a, b) => b.s - a.s);
  const out: Recall = { memory: [], passages: [], skills: [] };
  const seenNotes = new Set<string>();
  for (const { u, s } of scored) {
    if (u.kind === 'memory' && out.memory.length < 10) out.memory.push(u.text);
    else if (u.kind === 'skill' && out.skills.length < 2 && s >= MIN_SCORE + 0.05) out.skills.push({ noteId: u.noteId, title: u.title, score: s });
    else if ((u.kind === 'knowledge' || u.kind === 'note') && out.passages.length < 4 && !seenNotes.has(`${u.noteId}:${u.kind}`)) {
      seenNotes.add(`${u.noteId}:${u.kind}`);
      out.passages.push({ title: u.title, text: u.text.replace(/^[^\n]*\n/, '').slice(0, 900), score: s });
    }
  }
  return out;
}

export async function semanticStatus(roomId: string) {
  const idx = await getIndex(roomId);
  return { provider: provider(), indexed: idx.units.size, building: Boolean(idx.building) };
}

let indexer = false;
/** Keeps every active room's index fresh (new memories, notes, skills) every 10 minutes. */
export function startSemanticIndexer(): void {
  if (indexer) return;
  indexer = true;
  setInterval(async () => {
    if (!provider()) return;
    for (const roomId of listRoomIds()) {
      if (!getRoomDevices(roomId).length) continue;
      await refreshIndex(roomId).catch(() => undefined);
    }
  }, 10 * 60_000).unref();
}
