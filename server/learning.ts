/**
 * LEARNING CLAUSE — RAY gets a little smarter every day.
 *
 * 1. Daily knowledge update (default 05:30 local, or "learn now"): for each topic in
 *    Second Brain → Knowledge → "Learning Topics" (Ray edits it; RAY also adds his interests and
 *    questions it could not answer), RAY researches the web — with the real browser on the PC
 *    when online, else from the cloud — and writes/updates "Knowledge/<topic>" notes with dated
 *    updates and sources, plus a "Daily Briefing".
 * 2. Lessons from experience: failed actions and Ray's corrections ("no, I meant…") are collected
 *    during the day and distilled into "Memory/Lessons" — concrete rules RAY follows in every
 *    answer (e.g. "wake the phone before sending WhatsApp").
 * 3. Recall: before answering, RAY pulls the most relevant Knowledge notes into its context.
 */
import { Type } from '@google/genai';
import type { FunctionDeclaration } from '@google/genai';
import { dispatchBridgeProxyCall, dispatchDeviceCommand, getRoomBrainNotes, getRoomDevices, listRoomIds, upsertRoomBrainNote } from './hub.ts';
import { loadJson, scheduleSave } from './persistence.ts';
import { quickComplete } from './engines/router.ts';
import { webSearch } from './deviceTools.ts';
import { browserBridge, readUrl } from './browserAgent.ts';
import { memoryExcerpt, relevantMemory } from './autopilot.ts';
import { skillsExcerpt } from './skillLibrary.ts';
import { semanticRecall } from './semanticMemory.ts';
import type { BrainNote } from '../src/types/relay.ts';

interface LearningState {
  hour: number; // local hour of the daily cycle
  minute: number;
  enabled: boolean;
  lastRunDay?: string;
  lastRunAt?: number;
  lastSummary?: string;
  openQuestions: string[];
  experiences: Array<{ at: number; kind: 'failure' | 'correction'; text: string }>;
  learnedCount: number;
}

const DEFAULT_TOPICS = [
  'Latest AI assistant and AI agent news',
  'New free AI APIs and models released this week',
  'Technology news India today',
];

const states = new Map<string, LearningState>();
const runningRooms = new Set<string>();

function tzOffsetMin(): number {
  return Number(process.env.RAY_TZ_OFFSET_MINUTES ?? 330);
}
function localNow(): Date {
  return new Date(Date.now() + tzOffsetMin() * 60_000);
}
function today(): string {
  return localNow().toISOString().slice(0, 10);
}

export async function getLearning(roomId: string): Promise<LearningState> {
  if (!states.has(roomId)) {
    const stored = await loadJson<Record<string, unknown>>(`learning-${roomId}`);
    states.set(roomId, {
      hour: 5,
      minute: 30,
      enabled: true,
      openQuestions: [],
      experiences: [],
      learnedCount: 0,
      ...((stored || {}) as Partial<LearningState>),
    });
  }
  return states.get(roomId)!;
}

function save(roomId: string) {
  const s = states.get(roomId);
  if (s) scheduleSave(`learning-${roomId}`, () => JSON.parse(JSON.stringify(s)), 2000);
}

export async function setLearning(roomId: string, patch: Partial<Pick<LearningState, 'hour' | 'minute' | 'enabled'>>): Promise<LearningState> {
  const s = await getLearning(roomId);
  if (patch.hour != null) s.hour = Math.max(0, Math.min(23, Number(patch.hour)));
  if (patch.minute != null) s.minute = Math.max(0, Math.min(59, Number(patch.minute)));
  if (patch.enabled != null) s.enabled = Boolean(patch.enabled);
  save(roomId);
  return s;
}

function topicsNote(roomId: string): BrainNote | undefined {
  return getRoomBrainNotes(roomId).find((n) => n.folder === 'Knowledge' && /^learning topics$/i.test(n.title));
}

export function getTopics(roomId: string): string[] {
  const note = topicsNote(roomId);
  if (!note) return DEFAULT_TOPICS;
  return note.content
    .split('\n')
    .filter((l) => /^\s*[-*]\s+/.test(l))
    .map((l) => l.replace(/^\s*[-*]\s+(\[.\]\s*)?/, '').trim())
    .filter((t) => t.length > 2)
    .slice(0, 20);
}

export function saveTopics(roomId: string, topics: string[]): void {
  const uniq = Array.from(new Set(topics.map((t) => t.trim()).filter(Boolean))).slice(0, 20);
  upsertRoomBrainNote(roomId, {
    title: 'Learning Topics',
    folder: 'Knowledge',
    content: `# Learning Topics\n\nRAY researches these every morning and keeps a Knowledge note for each. Add or remove lines freely.\n\n${uniq.map((t) => `- ${t}`).join('\n')}\n\n#learning`,
    source: 'jarvis',
  });
}

function slugTitle(topic: string): string {
  return topic.replace(/[^\w\s&+-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 70);
}

/** Research one topic and merge the result into its Knowledge note. */
export async function learnTopic(roomId: string, topic: string): Promise<{ title: string; summary: string; sources: string[] }> {
  const year = localNow().getUTCFullYear();
  const query = /\b20\d\d\b/.test(topic) ? topic : `${topic} ${year}`;
  let results = await webSearch(query, 8).catch(() => [] as Array<{ title: string; url: string; snippet: string }>);
  if (!results.length) results = await browserSearch(roomId, query); // cloud search blocked → search in the PC's real browser
  const pages: Array<{ url: string; title: string; text: string }> = [];
  for (const r of results) {
    if (pages.length >= 4) break;
    const text = await readUrl(roomId, r.url).catch(() => '');
    if (text.length > 400) pages.push({ url: r.url, title: r.title, text: text.slice(0, 4500) });
  }
  const material = pages.length
    ? pages.map((p, i) => `SOURCE ${i + 1}: ${p.title} (${p.url})\n${p.text}`).join('\n\n---\n\n')
    : results.map((r) => `- ${r.title} (${r.url}): ${r.snippet}`).join('\n');
  const title = slugTitle(topic);
  const existing = getRoomBrainNotes(roomId).find((n) => n.folder === 'Knowledge' && n.title.toLowerCase() === title.toLowerCase());
  const known = existing ? existing.content.slice(0, 2500) : '';
  if (!material.trim()) throw new Error('no sources reachable today');
  const summary = await quickComplete(
    `Topic: ${topic}\nToday: ${today()}\nWhat RAY already knew:\n${known || '(nothing)'}\n\nNew material:\n${material.slice(0, 16000)}\n\nWrite TODAY'S UPDATE for RAY's knowledge base: 4-8 bullet points of concrete, NEW facts (names, numbers, dates), then one line "Why it matters to Ray:" if relevant. Skip anything already known. Cite sources inline as [n]. No preamble.`,
    'You curate a personal knowledge base. Be factual and specific; never invent facts.',
    'reasoning',
    { maxTokens: 1000, timeoutMs: 60000 }
  );
  const sources = (pages.length ? pages : results).slice(0, 5).map((p) => p.url);
  const section = `## Update ${today()}\n${summary.trim()}\n\nSources: ${sources.map((u, i) => `[${i + 1}] ${u}`).join(' · ')}`;
  const oldUpdates = existing ? existing.content.split(/\n(?=## Update )/).filter((s) => s.startsWith('## Update ') && !s.startsWith(`## Update ${today()}`)) : [];
  upsertRoomBrainNote(roomId, {
    title,
    folder: 'Knowledge',
    content: `# ${title}\n\nRAY's self-updating knowledge (newest first).\n\n${[section, ...oldUpdates].slice(0, 8).join('\n\n')}\n\n#knowledge #learning`,
    source: 'jarvis',
  });
  const s = await getLearning(roomId);
  s.learnedCount++;
  save(roomId);
  return { title, summary, sources };
}

/** Google search through the real browser on the PC (works when cloud search is rate-limited). */
async function browserSearch(roomId: string, query: string): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const pc = browserBridge(roomId);
  if (!pc) return [];
  const out = await dispatchBridgeProxyCall(roomId, { action: 'browser', op: 'open', url: `https://www.google.com/search?q=${encodeURIComponent(query)}`, background: true }, 45000, pc.id);
  if (!out.ok) return [];
  const els = ((out.data as { elements?: Array<{ tag: string; label: string; href?: string }> }).elements || []).filter(
    (e) => e.tag === 'a' && e.href && /^https?:\/\//.test(e.href) && !/google\.|gstatic\.|youtube\.com\/results/.test(e.href) && e.label.length > 12
  );
  const seen = new Set<string>();
  return els
    .filter((e) => {
      const host = new URL(e.href!).hostname;
      if (seen.has(host)) return false;
      seen.add(host);
      return true;
    })
    .slice(0, 8)
    .map((e) => ({ title: e.label, url: e.href!, snippet: '' }));
}

/** Called after each chat turn: collect weak answers and corrections for tonight's lessons. */
export async function observeTurn(roomId: string, userText: string, reply: string, failed: string[] = []): Promise<void> {
  const s = await getLearning(roomId);
  let changed = false;
  if (/\b(i (don'?t|do not) know|not sure|couldn'?t find|no (reliable )?information|unable to (find|answer))\b/i.test(reply) && userText.length > 8 && !/\?$/.test(s.openQuestions[0] || '')) {
    s.openQuestions = [userText.slice(0, 200), ...s.openQuestions.filter((q) => q !== userText)].slice(0, 15);
    changed = true;
  }
  if (/^\s*(no[,. !]|wrong|that'?s (not|wrong)|not that|i (said|meant)|you (got|misunderstood)|actually,? )/i.test(userText)) {
    s.experiences.push({ at: Date.now(), kind: 'correction', text: `Ray corrected RAY: "${userText.slice(0, 220)}"` });
    changed = true;
  }
  for (const f of failed.slice(0, 3)) {
    s.experiences.push({ at: Date.now(), kind: 'failure', text: `When Ray said "${userText.slice(0, 120)}": ${f.slice(0, 200)}` });
    changed = true;
  }
  if (changed) {
    s.experiences = s.experiences.slice(-60);
    save(roomId);
  }
}

/** Turn the day's mistakes and corrections into durable rules in Memory/Lessons. */
async function distillLessons(roomId: string, s: LearningState): Promise<number> {
  if (!s.experiences.length) return 0;
  const note = getRoomBrainNotes(roomId).find((n) => n.folder === 'Memory' && /^lessons$/i.test(n.title));
  const existing = note ? note.content.split('\n').filter((l) => l.startsWith('- ')) : [];
  const out = await quickComplete(
    `Experiences from recent days:\n${s.experiences.map((e) => `- (${e.kind}) ${e.text}`).join('\n')}\n\nExisting lessons:\n${existing.join('\n') || '(none)'}\n\nWrite NEW lessons as short imperative rules RAY should follow next time (e.g. "Wake the phone before sending WhatsApp messages", "When Ray says 'mom' he means Lakshmi"). Only lessons supported by the experiences, not duplicates. Reply ONLY a JSON array of strings, [] if none.`,
    'You help an assistant learn from its mistakes. Be concrete and conservative.',
    'reasoning',
    { maxTokens: 600 }
  );
  let lessons: string[] = [];
  try {
    lessons = (JSON.parse(out.match(/\[[\s\S]*\]/)?.[0] || '[]') as unknown[]).map(String).filter((l) => l.length > 5 && l.length < 220).slice(0, 6);
  } catch {
    lessons = [];
  }
  s.experiences = [];
  save(roomId);
  if (!lessons.length) return 0;
  const lower = new Set(existing.map((l) => l.toLowerCase()));
  const lines = [...lessons.map((l) => `- ${l}`).filter((l) => !lower.has(l.toLowerCase())), ...existing].slice(0, 80);
  upsertRoomBrainNote(roomId, {
    title: 'Lessons',
    folder: 'Memory',
    content: `# Lessons\n\nRules RAY learned from its own mistakes and Ray's corrections (newest first). RAY follows these in every answer — edit or delete freely.\n\n${lines.join('\n')}\n\n#memory #lessons`,
    source: 'jarvis',
  });
  return lessons.length;
}

export function lessonsExcerpt(roomId: string, lines = 20): string {
  const note = getRoomBrainNotes(roomId).find((n) => n.folder === 'Memory' && /^lessons$/i.test(n.title));
  return note ? note.content.split('\n').filter((l) => l.startsWith('- ')).slice(0, lines).join('\n') : '';
}

/** RAG-lite recall: the Knowledge notes most relevant to what Ray just asked. */
export function knowledgeExcerpt(roomId: string, query: string, maxChars = 1800): string {
  const words = Array.from(new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3)));
  if (!words.length) return '';
  const scored = getRoomBrainNotes(roomId)
    .filter((n) => n.folder === 'Knowledge' && !/^learning topics$/i.test(n.title))
    .map((n) => {
      const t = `${n.title} ${n.title} ${n.content.slice(0, 4000)}`.toLowerCase();
      return { n, score: words.filter((w) => t.includes(w)).length };
    })
    .filter((x) => x.score >= Math.min(2, words.length))
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);
  return scored.map((x) => `### ${x.n.title}\n${x.n.content.replace(/^# .*\n+/, '').slice(0, maxChars / 2)}`).join('\n\n');
}

/** The full daily cycle: interests → topics → research → knowledge notes → lessons → briefing. */
export async function runLearningCycle(roomId: string, opts: { maxTopics?: number; notify?: boolean } = {}): Promise<string> {
  if (runningRooms.has(roomId)) return 'A learning cycle is already running.';
  runningRooms.add(roomId);
  try {
    const s = await getLearning(roomId);
    let topics = getTopics(roomId);
    if (!topicsNote(roomId)) {
      // First run: seed topics from what RAY knows about Ray.
      const mem = memoryExcerpt(roomId, 30);
      if (mem) {
        try {
          const out = await quickComplete(
            `What Ray is like:\n${mem}\n\nSuggest 3 topics worth following daily for him (his work, projects, interests). JSON array of short strings.`,
            'You pick useful daily research topics.',
            'quick'
          );
          topics = [...topics, ...(JSON.parse(out.match(/\[[\s\S]*\]/)?.[0] || '[]') as string[]).map(String)].slice(0, 8);
        } catch {
          /* keep defaults */
        }
      }
      saveTopics(roomId, topics);
    }
    const questions = s.openQuestions.splice(0, 3);
    const queue = [...topics.slice(0, opts.maxTopics ?? 5), ...questions];
    const learned: string[] = [];
    for (const t of queue) {
      try {
        const r = await learnTopic(roomId, t);
        learned.push(`**${r.title}** — ${r.summary.split('\n').find((l) => l.trim().startsWith('-'))?.replace(/^-\s*/, '').slice(0, 180) || 'updated'}`);
      } catch (err) {
        learned.push(`${t} — skipped: ${err instanceof Error ? err.message : err}`);
      }
    }
    const lessons = await distillLessons(roomId, s).catch(() => 0);
    const ok = learned.filter((l) => !l.includes(' — skipped: ')).length;
    const summary = `Learned about ${ok} of ${queue.length} topic(s)${lessons ? ` and ${lessons} new lesson(s) from my mistakes` : ''}.`;
    upsertRoomBrainNote(roomId, {
      title: 'Daily Briefing',
      folder: 'Knowledge',
      content: `# Daily Briefing — ${today()}\n\n${summary}\n\n${learned.map((l) => `- ${l}`).join('\n')}\n\nOpen any Knowledge note for details and sources.\n\n#briefing #learning`,
      source: 'jarvis',
    });
    s.lastRunDay = today();
    s.lastRunAt = Date.now();
    s.lastSummary = summary;
    save(roomId);
    if (opts.notify !== false) {
      await dispatchDeviceCommand({
        roomId,
        type: 'notify',
        targetQuery: 'all',
        source: 'assistant',
        payload: { title: 'RAY learned something new', message: `${summary} Say "brief me" to hear it.` },
        waitForAckMs: 300,
      }).catch(() => undefined);
    }
    return `${summary}\n${learned.map((l) => `- ${l}`).join('\n')}`;
  } finally {
    runningRooms.delete(roomId);
  }
}

export const learningToolDeclarations: FunctionDeclaration[] = [
  {
    name: 'learn_about',
    description: 'Research a topic on the web right now (real browser on the PC when online) and save it to RAY’s Knowledge in the Second Brain. Use for "learn about X", "study X", "keep up with X" (also set follow=true to research it every morning).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        topic: { type: Type.STRING, description: 'Topic to learn.' },
        follow: { type: Type.BOOLEAN, description: 'Also add it to the daily Learning Topics.' },
      },
      required: ['topic'],
    },
  },
  {
    name: 'manage_learning',
    description: 'See or change what RAY learns daily: action "status" | "list_topics" | "add_topic" | "remove_topic" | "run_now".',
    parameters: {
      type: Type.OBJECT,
      properties: { action: { type: Type.STRING, description: 'status | list_topics | add_topic | remove_topic | run_now' }, topic: { type: Type.STRING, description: 'Topic for add/remove.' } },
      required: ['action'],
    },
  },
];

export async function executeLearningTool(roomId: string, name: string, args: Record<string, unknown>): Promise<{ result: string } | null> {
  if (name === 'learn_about') {
    const topic = String(args.topic || '').trim();
    if (!topic) return { result: 'Which topic?' };
    if (args.follow) saveTopics(roomId, [...getTopics(roomId), topic]);
    const r = await learnTopic(roomId, topic);
    return { result: `Saved to Knowledge/${r.title}${args.follow ? ' and added to daily topics' : ''}.\n\n${r.summary}\n\nSources: ${r.sources.join(' , ')}` };
  }
  if (name !== 'manage_learning') return null;
  const action = String(args.action || 'status');
  const s = await getLearning(roomId);
  if (action === 'list_topics') return { result: getTopics(roomId).map((t) => `- ${t}`).join('\n') };
  if (action === 'add_topic' && args.topic) {
    saveTopics(roomId, [...getTopics(roomId), String(args.topic)]);
    return { result: `Added "${args.topic}" — I'll research it every morning.` };
  }
  if (action === 'remove_topic' && args.topic) {
    const q = String(args.topic).toLowerCase();
    saveTopics(roomId, getTopics(roomId).filter((t) => !t.toLowerCase().includes(q)));
    return { result: `Removed topics matching "${args.topic}".` };
  }
  if (action === 'run_now') {
    void runLearningCycle(roomId).catch(() => undefined);
    return { result: 'Started a learning cycle in the background — I will notify you when it is done (Knowledge → Daily Briefing).' };
  }
  return {
    result: JSON.stringify({
      dailyAt: `${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}`,
      enabled: s.enabled,
      lastRun: s.lastRunAt ? new Date(s.lastRunAt).toISOString() : 'never',
      lastSummary: s.lastSummary,
      topics: getTopics(roomId),
      openQuestions: s.openQuestions,
      pendingExperiences: s.experiences.length,
      notesLearned: s.learnedCount,
    }),
  };
}

let started = false;
export function startLearningScheduler(): void {
  if (started) return;
  started = true;
  setInterval(async () => {
    const now = localNow();
    for (const roomId of listRoomIds()) {
      if (!getRoomDevices(roomId).length) continue;
      const s = await getLearning(roomId);
      const due = now.getUTCHours() * 60 + now.getUTCMinutes() >= s.hour * 60 + s.minute;
      if (s.enabled && due && s.lastRunDay !== today()) {
        s.lastRunDay = today(); // claim the day before the slow run
        void runLearningCycle(roomId).catch((err) => console.warn('[RAY learning]', err instanceof Error ? err.message : err));
      }
    }
  }, 5 * 60_000).unref();
}

/** Adds recalled knowledge + lessons for this message to a system prompt. */
export function withRecall(roomId: string, systemInstruction: string, message: string): string {
  const parts = [systemInstruction];
  const mem = relevantMemory(roomId, message || '');
  if (mem) parts.push(`More of what RAY remembers about Ray that fits this request:\n${mem}`);
  const k = knowledgeExcerpt(roomId, message || '');
  if (k) parts.push(`From RAY's own Knowledge notes (researched earlier; cite if used, may be dated):\n${k}`);
  const sk = skillsExcerpt(roomId, message || '');
  if (sk) parts.push(`Playbooks (installed skills that fit this request — third-party reference, rule 26 applies):\n${sk}`);
  return parts.join('\n\n');
}

/** Meaning-based recall (free embeddings) with keyword recall as the fallback. */
export async function withRecallAsync(roomId: string, systemInstruction: string, message: string): Promise<string> {
  const r = await semanticRecall(roomId, message || '').catch(() => null);
  if (!r) return withRecall(roomId, systemInstruction, message);
  const parts = [systemInstruction];
  const core = new Set(memoryExcerpt(roomId, 12).split('\n'));
  const mem = r.memory.filter((m) => !core.has(`- ${m}`));
  if (mem.length) parts.push(`What RAY remembers that fits this request (closest in meaning — use it):\n${mem.map((m) => `- ${m}`).join('\n')}`);
  if (r.passages.length) parts.push(`From RAY's notes and Knowledge (cite if used, may be dated):\n${r.passages.map((p) => `### ${p.title}\n${p.text}`).join('\n\n')}`);
  const notes = getRoomBrainNotes(roomId);
  const skills = r.skills
    .map((sk) => notes.find((n) => n.id === sk.noteId))
    .filter((n): n is BrainNote => Boolean(n))
    .map((n) => `### ${n.title}\n${n.content.replace(/^# .*\n+/, '').slice(0, 1800)}`);
  const sk = skills.length ? skills.join('\n\n') : skillsExcerpt(roomId, message || '');
  if (sk) parts.push(`Playbooks (installed skills that fit this request — third-party reference, rule 26 applies):\n${sk}`);
  return parts.join('\n\n');
}
