/**
 * INBOX ROUTINE + "LEARN ME" — from Luke Cutting's 3-Day AI Agent Build (Day 1).
 *
 *  - learn_me_from_email: reads Ray's recent SENT mail (who he writes to, how he writes), adds the
 *    durable facts to Memory/About Ray, writes Memory/Email Style, and returns clarifying questions.
 *  - Inbox routine: at set times (default 08:00 and 16:00 local, never more than 4×/day) RAY checks
 *    new inbox mail, writes reply DRAFTS in Gmail in Ray's style, and messages him a short summary.
 *    Nothing is sent until Ray says "send it" (google_api_request → drafts/send asks once).
 *    His corrections become Lessons, so the drafts get closer to his voice over time.
 */
import { Type } from '@google/genai';
import type { FunctionDeclaration } from '@google/genai';
import { getServerGoogleToken } from './accounts.ts';
import { addMemoryFacts, memoryExcerpt } from './autopilot.ts';
import { dispatchDeviceCommand, getRoomBrainNotes, listRoomIds, normalizeRoomId, upsertRoomBrainNote } from './hub.ts';
import { lessonsExcerpt } from './learning.ts';
import { loadJson, scheduleSave } from './persistence.ts';
import { quickComplete } from './engines/router.ts';
import type { Express } from 'express';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const TZ_MIN = Number(process.env.RAY_TZ_OFFSET_MINUTES || 330);

interface RoutineState {
  enabled: boolean;
  times: string[]; // "HH:MM" local
  lastSlot: string; // "YYYY-MM-DD HH:MM" of the last run
  seen: string[]; // message ids already handled
  lastRunAt: number | null;
  lastSummary: string;
}
const states = new Map<string, RoutineState>();

async function getState(roomId: string): Promise<RoutineState> {
  if (!states.has(roomId)) {
    const s = (await loadJson<Partial<RoutineState>>(`inbox-routine-${roomId}`)) || {};
    states.set(roomId, { enabled: false, times: ['08:00', '16:00'], lastSlot: '', seen: [], lastRunAt: null, lastSummary: '', ...s });
  }
  return states.get(roomId)!;
}
function save(roomId: string) {
  scheduleSave(`inbox-routine-${roomId}`, () => ({ ...(states.get(roomId) as RoutineState) } as unknown as Record<string, unknown>), 500);
}

function localNow(): Date {
  return new Date(Date.now() + TZ_MIN * 60_000);
}

async function gmail<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${GMAIL}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init?.headers || {}) },
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`Gmail ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return (await r.json()) as T;
}

interface MsgMeta {
  id: string;
  threadId: string;
  snippet: string;
  headers: Record<string, string>;
}
async function listMessages(token: string, q: string, max: number): Promise<MsgMeta[]> {
  const list = await gmail<{ messages?: Array<{ id: string }> }>(token, `/messages?maxResults=${max}&q=${encodeURIComponent(q)}`);
  const out: MsgMeta[] = [];
  for (const m of list.messages || []) {
    const full = await gmail<{ id: string; threadId: string; snippet: string; payload?: { headers?: Array<{ name: string; value: string }> } }>(
      token,
      `/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=Message-ID`
    );
    const headers: Record<string, string> = {};
    for (const h of full.payload?.headers || []) headers[h.name.toLowerCase()] = String(h.value || '').replace(/[\r\n]+/g, ' ').trim();
    out.push({ id: full.id, threadId: full.threadId, snippet: full.snippet || '', headers });
  }
  return out;
}

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text.match(/[[{][\s\S]*[\]}]/)?.[0] || '') as T;
  } catch {
    return fallback;
  }
}

function styleNote(roomId: string): string {
  return getRoomBrainNotes(roomId).find((n) => n.folder === 'Memory' && /email style/i.test(n.title))?.content.slice(0, 1500) || '';
}

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const headerSafe = (s: string) => s.replace(/[\r\n]+/g, ' ').slice(0, 300);

// --- learn me -------------------------------------------------------------------

export async function learnMeFromEmail(roomId: string): Promise<string> {
  const token = await getServerGoogleToken(roomId);
  if (!token) return 'Google is not connected yet. JARVIS Core → Accounts → Connect Google, then ask again.';
  const sent = await listMessages(token, 'in:sent newer_than:180d', 40);
  if (!sent.length) return 'I found no sent emails in the last 6 months to learn from.';
  const sample = sent.map((m) => `To: ${m.headers.to || '?'} | Subject: ${m.headers.subject || ''} | ${m.snippet}`).join('\n').slice(0, 14000);
  const out = await quickComplete(
    `These are snippets of emails Ray SENT recently:\n${sample}\n\nAlready known about Ray:\n${memoryExcerpt(roomId, 40) || '(nothing)'}\n\nReply ONLY JSON:\n{"facts":["durable facts about Ray: work, role, company, projects, key people and how he relates to them (max 15, no email addresses, no secrets)"],"style":["how Ray writes emails: greeting, sign-off, length, tone, language mix, habits (max 8)"],"questions":["3-5 short clarifying questions RAY should ask Ray to fill the gaps"]}`,
    'You build a careful profile of a person from their own sent emails so their assistant can help them. Never include passwords, codes, bank or ID numbers.',
    'reasoning',
    { maxTokens: 1200, timeoutMs: 60000 }
  );
  const j = parseJson<{ facts?: string[]; style?: string[]; questions?: string[] }>(out, {});
  const facts = (j.facts || []).map(String).filter((f) => f.length > 3 && f.length < 220 && !/@|password|otp|\b\d{6,}\b/i.test(f)).slice(0, 15);
  const added = addMemoryFacts(roomId, facts);
  const style = (j.style || []).map(String).slice(0, 8);
  if (style.length) {
    upsertRoomBrainNote(roomId, {
      title: 'Email Style',
      folder: 'Memory',
      source: 'jarvis',
      content: `# Email Style\n\nHow Ray writes email (learned from ${sent.length} sent emails on ${new Date().toISOString().slice(0, 10)}). RAY drafts in this style. Edit freely.\n\n${style.map((s) => `- ${s}`).join('\n')}\n\n#memory #email`,
    });
  }
  const qs = (j.questions || []).map(String).slice(0, 5);
  return `Read ${sent.length} sent emails. Added ${added} new facts to Memory/About Ray${style.length ? ' and wrote Memory/Email Style' : ''}.${qs.length ? `\nQuestions to ask Ray (one at a time):\n${qs.map((q, i) => `${i + 1}. ${q}`).join('\n')}` : ''}`;
}

// --- routine --------------------------------------------------------------------

const running = new Set<string>();

export async function runInboxCheck(roomId: string, opts: { notify?: boolean } = {}): Promise<string> {
  if (running.has(roomId)) return 'An inbox check is already running.';
  running.add(roomId);
  try {
    const st = await getState(roomId);
    const token = await getServerGoogleToken(roomId);
    if (!token) return 'Google is not connected. JARVIS Core → Accounts → Connect Google.';
    const msgs = (await listMessages(token, 'in:inbox is:unread newer_than:3d -category:promotions -category:social -category:updates', 15)).filter((m) => !st.seen.includes(m.id));
    const items: Array<{ from: string; subject: string; summary: string; urgent: boolean; drafted: boolean }> = [];
    const style = styleNote(roomId);
    const lessons = lessonsExcerpt(roomId, 12);
    for (const m of msgs.slice(0, 8)) {
      const from = m.headers.from || '';
      const subject = m.headers.subject || '(no subject)';
      const out = await quickComplete(
        `New email for Ray.\nFrom: ${from}\nSubject: ${subject}\nPreview: ${m.snippet}\n\nAbout Ray:\n${memoryExcerpt(roomId, 15) || '-'}\nRay's email style:\n${style || '-'}\nLessons from Ray's feedback:\n${lessons || '-'}\n\nReply ONLY JSON: {"summary":"one line","urgent":true|false,"needsReply":true|false,"draft":"reply body in Ray's style, or empty"}\nNo reply for newsletters, receipts, notifications or no-reply senders. Never promise money, dates or commitments Ray has not made — ask in the draft instead.`,
        'You triage email for a busy person and draft replies they can send with one word. Plain text drafts, no markdown.',
        'quick',
        { maxTokens: 500, timeoutMs: 30000 }
      ).catch(() => '');
      const j = parseJson<{ summary?: string; urgent?: boolean; needsReply?: boolean; draft?: string }>(out, {});
      let drafted = false;
      if (j.needsReply && j.draft && !/no-?reply/i.test(from)) {
        const subj = /^re:/i.test(subject) ? subject : `Re: ${subject}`;
        const mid = m.headers['message-id'] ? headerSafe(m.headers['message-id']) : '';
        const head = [`To: ${headerSafe(from)}`, `Subject: ${headerSafe(subj)}`, ...(mid ? [`In-Reply-To: ${mid}`, `References: ${mid}`] : []), 'Content-Type: text/plain; charset="UTF-8"'];
        const raw = `${head.join('\r\n')}\r\n\r\n${String(j.draft).slice(0, 4000)}`;
        try {
          await gmail(token, '/drafts', { method: 'POST', body: JSON.stringify({ message: { raw: b64url(raw), threadId: m.threadId } }) });
          drafted = true;
        } catch {
          /* draft failed; still report */
        }
      }
      items.push({ from: from.replace(/<.*>/, '').trim() || from, subject, summary: String(j.summary || m.snippet).slice(0, 160), urgent: Boolean(j.urgent), drafted });
      st.seen.push(m.id);
    }
    st.seen = st.seen.slice(-300);
    st.lastRunAt = Date.now();
    const drafts = items.filter((i) => i.drafted).length;
    const urgent = items.filter((i) => i.urgent).length;
    st.lastSummary = items.length
      ? `${items.length} new · ${urgent} urgent · ${drafts} draft${drafts === 1 ? '' : 's'} ready`
      : 'No new email that needs you.';
    save(roomId);
    if (items.length) {
      upsertRoomBrainNote(roomId, {
        title: 'Inbox Briefing',
        folder: 'Inbox',
        source: 'jarvis',
        content: `# Inbox Briefing\n\n${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC — ${st.lastSummary}\n\n${items
          .map((i) => `- ${i.urgent ? '**URGENT** ' : ''}${i.from} — ${i.subject}: ${i.summary}${i.drafted ? ' _(draft ready in Gmail)_' : ''}`)
          .join('\n')}\n\nSay "send the draft to <name>" to send one, or tell RAY what to change.\n\n#inbox`,
      });
      if (opts.notify !== false) {
        const top = items.sort((a, b) => Number(b.urgent) - Number(a.urgent)).slice(0, 3).map((i) => `${i.urgent ? '! ' : ''}${i.from}: ${i.summary}`).join('\n');
        await dispatchDeviceCommand({ roomId, type: 'notify', targetQuery: 'all', source: 'assistant', payload: { title: `Inbox: ${st.lastSummary}`, message: `${top}\nOpen RAY → say "send it" or what to change.` } }).catch(() => undefined);
      }
    }
    return `${st.lastSummary}${items.length ? `\n${items.map((i) => `- ${i.urgent ? 'URGENT ' : ''}${i.from} — ${i.subject}: ${i.summary}${i.drafted ? ' (draft ready)' : ''}`).join('\n')}` : ''}`;
  } catch (err) {
    return `Inbox check failed: ${err instanceof Error ? err.message : err}`;
  } finally {
    running.delete(roomId);
  }
}

let started = false;
export function startInboxScheduler(): void {
  if (started) return;
  started = true;
  setInterval(async () => {
    const now = localNow();
    const day = now.toISOString().slice(0, 10);
    const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
    for (const roomId of listRoomIds()) {
      const st = await getState(roomId);
      if (!st.enabled) continue;
      for (const t of st.times) {
        const [h, m] = t.split(':').map(Number);
        const slot = `${day} ${t}`;
        if (mins >= h * 60 + m && mins < h * 60 + m + 30 && st.lastSlot < slot) {
          st.lastSlot = slot;
          save(roomId);
          void runInboxCheck(roomId);
          break;
        }
      }
    }
  }, 5 * 60_000).unref();
}

export async function inboxRoutineStatus(roomId: string) {
  const st = await getState(roomId);
  return { enabled: st.enabled, times: st.times, lastRunAt: st.lastRunAt, lastSummary: st.lastSummary };
}

function cleanTimes(input: unknown): string[] | null {
  const arr = (Array.isArray(input) ? input : String(input || '').split(/[,\s]+/)).map(String).filter(Boolean);
  const out = arr
    .map((t) => /^(\d{1,2})(?::(\d{2}))?$/.exec(t.trim()))
    .filter((m): m is RegExpExecArray => Boolean(m) && Number(m![1]) < 24 && Number(m![2] || 0) < 60)
    .map((m) => `${m[1].padStart(2, '0')}:${(m[2] || '00').padStart(2, '0')}`);
  return out.length ? Array.from(new Set(out)).sort().slice(0, 4) : null;
}

export async function setInboxRoutine(roomId: string, patch: { enabled?: boolean; times?: unknown }) {
  const st = await getState(roomId);
  if (typeof patch.enabled === 'boolean') st.enabled = patch.enabled;
  const t = patch.times != null ? cleanTimes(patch.times) : null;
  if (t) st.times = t;
  save(roomId);
  return inboxRoutineStatus(roomId);
}

export function registerInboxRoutes(app: Express, requireRoomAuth: Parameters<Express['get']>[1]) {
  app.get('/api/inbox-routine', requireRoomAuth, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await inboxRoutineStatus(normalizeRoomId(String(req.query.room || 'RLY-HOME'))));
  });
  app.post('/api/inbox-routine', requireRoomAuth, async (req, res) => {
    const b = req.body as { roomId?: string; enabled?: boolean; times?: unknown; action?: string };
    const roomId = normalizeRoomId(String(b.roomId || ''));
    if (b.action === 'run') return res.json({ result: await runInboxCheck(roomId, { notify: false }), status: await inboxRoutineStatus(roomId) });
    if (b.action === 'learn') return res.json({ result: await learnMeFromEmail(roomId).catch((e) => `Failed: ${e instanceof Error ? e.message : e}`) });
    res.json(await setInboxRoutine(roomId, b));
  });
}

export const inboxToolDeclarations: FunctionDeclaration[] = [
  {
    name: 'learn_me_from_email',
    description:
      'Teach RAY who Ray is from his own SENT Gmail (work, people, projects, how he writes). Saves facts to Memory/About Ray and his writing style to Memory/Email Style, and returns clarifying questions — ask them one at a time. Use for "learn about me from my email", "get to know me", onboarding.',
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: 'inbox_routine',
    description:
      'Ray’s email routine: RAY checks new inbox mail at set times, drafts replies in Gmail in his style and messages him a summary — nothing is sent until he says so. action: "status" | "enable" | "disable" | "run_now" | "set_times" (times like "08:00,16:00", at most 4 a day).',
    parameters: {
      type: Type.OBJECT,
      properties: { action: { type: Type.STRING }, times: { type: Type.STRING, description: 'e.g. "08:00,16:00"' } },
      required: ['action'],
    },
  },
];

export async function executeInboxTool(roomId: string, name: string, args: Record<string, unknown>): Promise<{ result: string } | null> {
  if (name === 'learn_me_from_email') {
    try {
      return { result: await learnMeFromEmail(roomId) };
    } catch (err) {
      return { result: `Could not read the email: ${err instanceof Error ? err.message : err}` };
    }
  }
  if (name !== 'inbox_routine') return null;
  const action = String(args.action || 'status').toLowerCase();
  if (action === 'run_now' || action === 'run') return { result: await runInboxCheck(roomId, { notify: false }) };
  if (action === 'enable') return { result: JSON.stringify(await setInboxRoutine(roomId, { enabled: true, times: args.times })) };
  if (action === 'disable') return { result: JSON.stringify(await setInboxRoutine(roomId, { enabled: false })) };
  if (action === 'set_times') return { result: JSON.stringify(await setInboxRoutine(roomId, { times: args.times })) };
  return { result: JSON.stringify(await inboxRoutineStatus(roomId)) };
}
