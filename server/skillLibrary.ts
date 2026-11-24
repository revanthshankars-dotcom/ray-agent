/**
 * SKILL LIBRARY — ready-made playbooks from Orbit (orbitskills.app), credited to their creators.
 *
 * skill_search  → search Orbit's public catalog (llms.txt) and the skills RAY already has
 * skill_install → fetch one skill's markdown and keep it as a Second Brain note (Skills/Orbit: …)
 * skill_list / skill_remove
 * skillsExcerpt → on every turn, the 1–2 installed playbooks that match the request are added to
 *                 RAY's instructions as reference material (third-party text: never overrides Ray,
 *                 the safety rules or the approval flow).
 *
 * Only orbitskills.app is fetched (fixed host). Skills Orbit marks "use with care" need Ray's approval.
 */
import type { Express } from 'express';
import { Type } from '@google/genai';
import type { FunctionDeclaration } from '@google/genai';
import { createConfirmationRequest } from './capabilities.ts';
import { deleteRoomBrainNote, getRoomBrainNotes, normalizeRoomId, upsertRoomBrainNote } from './hub.ts';
import type { BrainNote, ConfirmationRequest } from '../src/types/relay.ts';

const ORBIT = 'https://orbitskills.app';
const SLUG = /^[a-z0-9][a-z0-9-]{2,150}$/;

export interface CatalogSkill {
  slug: string;
  title: string;
  summary: string;
  creator: string;
}

/** Hand-picked for RAY (all rated “nothing risky” by Orbit): each strengthens something RAY already does. */
export const RECOMMENDED_SKILLS: Array<{ slug: string; why: string }> = [
  { slug: 'skill-to-capture-and-organize-new-knowledge', why: 'Self-learning: turns every finished job into durable lessons' },
  { slug: 'caveman-prompts-for-verification', why: 'Missions: proves the work meets the goal before saying “done”' },
  { slug: 'investigate', why: 'Self-repair: find the real cause of a bug before fixing it' },
  { slug: 'caveman-prompts-for-agent-review', why: 'Coding agents: line-by-line review of what helpers changed' },
  { slug: 'writing-for-agents', why: 'Clear briefs when RAY delegates to its sub-agents' },
  { slug: 'make-claude-audit-itself-about-you', why: 'Memory: audit and correct what RAY believes about you' },
  { slug: 'karpathy-llm-wiki-prompts', why: 'Second Brain: turn saved notes and sources into a wiki' },
  { slug: 'customer-response-draft-prompt', why: 'Inbox routine: polished reply drafts, even for bad news' },
  { slug: 'guide-to-make-ai-sound-like-you', why: 'Drafts in your own writing voice' },
  { slug: 'humanizer-skill-for-ai-text', why: 'Drafts and replies that sound like you, not a bot' },
  { slug: 'discernment-nudge-for-critical-thinking', why: 'Adds fact-check questions to advice you might act on' },
  { slug: 'new-loop-setup', why: 'Autopilot: set up a recurring task and prove it with a test run' },
  { slug: 'caveman-prompts-for-agent-management-itsmariahbrunner', why: 'Autopilot guard: no risky start/stop actions without approval' },
  { slug: 'instagram-automation-prompt-pack', why: 'Instagram auto-replies and DMs after you approve' },
  { slug: 'lecture-to-study-guide', why: 'Course videos and notes → a complete study guide' },
];

let catalog: { at: number; items: CatalogSkill[] } | null = null;

async function orbitText(path: string): Promise<string> {
  const r = await fetch(`${ORBIT}${path}`, { redirect: 'error', signal: AbortSignal.timeout(20000), headers: { Accept: 'text/plain, text/markdown' } });
  if (!r.ok) throw new Error(`Orbit answered ${r.status}`);
  return (await r.text()).slice(0, 400_000);
}

export async function getCatalog(): Promise<CatalogSkill[]> {
  if (catalog && Date.now() - catalog.at < 12 * 3600_000) return catalog.items;
  const text = await orbitText('/llms.txt');
  const items: CatalogSkill[] = [];
  for (const m of text.matchAll(/^- \[([^\]]+)\]\(https:\/\/orbitskills\.app\/s\/([a-z0-9-]+)\.md\): (.+)$/gm)) {
    const creator = /By @([\w.]+)\.?\s*$/.exec(m[3])?.[1] || '';
    items.push({ slug: m[2], title: m[1], summary: m[3].replace(/\s*By @[\w.]+\.?\s*$/, ''), creator });
  }
  if (items.length) catalog = { at: Date.now(), items };
  return items;
}

const STOP = new Set('the and for with your you that this from into what when have will about make help want need some them then they their just like more most also using use get can'.split(' '));
const words = (s: string) => Array.from(new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w))));

export async function searchCatalog(query: string, limit = 8): Promise<CatalogSkill[]> {
  const q = words(query);
  if (!q.length) return [];
  const items = await getCatalog();
  return items
    .map((s) => {
      const hay = `${s.title} ${s.title} ${s.summary} ${s.slug}`.toLowerCase();
      return { s, score: q.reduce((n, w) => n + (hay.includes(w) ? (s.title.toLowerCase().includes(w) ? 2 : 1) : 0), 0) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.s);
}

interface ParsedSkill {
  title: string;
  summary: string;
  creator: string;
  safety: string;
  careful: boolean;
  body: string;
}

function parseSkill(md: string): ParsedSkill {
  const title = /^# (.+)$/m.exec(md)?.[1]?.trim() || 'Skill';
  const summary = /^> (.+)$/m.exec(md)?.[1]?.trim() || '';
  const creator = /\*\*Creator:\*\* (.+)$/m.exec(md)?.[1]?.trim() || '';
  const safety = /\*\*Safety:\*\* (.+)$/m.exec(md)?.[1]?.trim() || 'not rated';
  const idx = md.indexOf('\n## Skill');
  const body = (idx >= 0 ? md.slice(idx + 9) : md).trim();
  return { title, summary, creator, safety, careful: !/nothing risky/i.test(safety), body };
}

const isOrbitNote = (n: BrainNote) => n.folder === 'Skills' && n.tags.includes('orbit');
const slugOf = (n: BrainNote) => /orbitskills\.app\/s\/([a-z0-9-]+)/.exec(n.content)?.[1] || '';

export function installedSkills(roomId: string) {
  return getRoomBrainNotes(roomId)
    .filter(isOrbitNote)
    .map((n) => ({ id: n.id, slug: slugOf(n), title: n.title.replace(/^Orbit: /, ''), summary: /^> (.+)$/m.exec(n.content)?.[1] || '', updatedAt: n.updatedAt }));
}

export async function installSkill(roomId: string, slug: string, confirmed: boolean): Promise<{ ok: boolean; message: string; needsApproval?: ParsedSkill }> {
  if (!SLUG.test(slug)) return { ok: false, message: 'Not a valid skill id.' };
  let md: string;
  try {
    md = await orbitText(`/s/${slug}.md`);
  } catch (err) {
    return { ok: false, message: `Could not fetch that skill: ${err instanceof Error ? err.message : err}` };
  }
  if (!/^# /m.test(md)) return { ok: false, message: 'Orbit has no skill with that id.' };
  const p = parseSkill(md);
  if (p.careful && !confirmed) return { ok: false, message: `Orbit's safety check says: “${p.safety}”.`, needsApproval: p };
  upsertRoomBrainNote(roomId, {
    title: `Orbit: ${p.title}`.slice(0, 140),
    folder: 'Skills',
    source: 'jarvis',
    tags: ['skill', 'orbit'],
    content: `# ${p.title}\n\n> ${p.summary}\n\nSource: ${ORBIT}/s/${slug} · ${p.creator ? `by ${p.creator} · ` : ''}Orbit safety: ${p.safety} · installed ${new Date().toISOString().slice(0, 10)}\n\n${p.body.slice(0, 30000)}\n\n#skill #orbit`,
  });
  return { ok: true, message: `Installed “${p.title}”${p.creator ? ` (credit: ${p.creator})` : ''}.` };
}

export function removeSkill(roomId: string, idOrSlug: string): boolean {
  const n = getRoomBrainNotes(roomId).find((x) => isOrbitNote(x) && (x.id === idOrSlug || slugOf(x) === idOrSlug));
  return n ? deleteRoomBrainNote(roomId, n.id) : false;
}

/** The 1–2 installed playbooks that fit this request, for the system prompt. */
export function skillsExcerpt(roomId: string, message: string, maxChars = 3500): string {
  const q = words(message);
  if (q.length < 2) return '';
  const scored = getRoomBrainNotes(roomId)
    .filter(isOrbitNote)
    .map((n) => {
      const head = `${n.title} ${n.title} ${n.content.slice(0, 1200)}`.toLowerCase();
      return { n, score: q.filter((w) => head.includes(w)).length };
    })
    .filter((x) => x.score >= Math.min(3, q.length))
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);
  return scored.map((x) => `### ${x.n.title}\n${x.n.content.replace(/^# .*\n+/, '').slice(0, maxChars / scored.length)}`).join('\n\n');
}

// --- routes ---------------------------------------------------------------------

export function registerSkillRoutes(app: Express, requireRoomAuth: Parameters<Express['get']>[1]) {
  app.get('/api/skills', requireRoomAuth, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const roomId = normalizeRoomId(String(req.query.room || 'RLY-HOME'));
    const q = String(req.query.q || '').trim();
    let results: CatalogSkill[] = [];
    let recommended: Array<CatalogSkill & { why: string }> = [];
    let catalogError: string | null = null;
    try {
      const all = await getCatalog();
      const bySlug = new Map(all.map((s) => [s.slug, s]));
      recommended = RECOMMENDED_SKILLS.flatMap((r) => (bySlug.has(r.slug) ? [{ ...bySlug.get(r.slug)!, why: r.why }] : []));
      if (q) results = await searchCatalog(q, 12);
    } catch (err) {
      catalogError = err instanceof Error ? err.message : String(err);
    }
    res.json({ installed: installedSkills(roomId), recommended, results, catalogError });
  });
  app.post('/api/skills/install', requireRoomAuth, async (req, res) => {
    const b = req.body as { roomId?: string; slug?: string; slugs?: string[]; confirmed?: boolean };
    const roomId = normalizeRoomId(String(b.roomId || ''));
    const slugs = (b.slugs || [b.slug || '']).map(String).slice(0, 30);
    const out = [];
    for (const s of slugs) {
      const r = await installSkill(roomId, s, Boolean(b.confirmed));
      out.push({ slug: s, ok: r.ok, message: r.message, careful: Boolean(r.needsApproval) });
    }
    res.json({ results: out });
  });
  app.post('/api/skills/remove', requireRoomAuth, (req, res) => {
    const b = req.body as { roomId?: string; id?: string };
    res.json({ ok: removeSkill(normalizeRoomId(String(b.roomId || '')), String(b.id || '')) });
  });
}

// --- tools ----------------------------------------------------------------------

export const skillToolDeclarations: FunctionDeclaration[] = [
  {
    name: 'skill_search',
    description:
      'Search Orbit’s library of ready-made agent skills (playbooks from AI creators) and RAY’s installed ones. Use when Ray asks for a skill / a better way to do something, or before a new kind of job when no installed playbook fits. Read-only.',
    parameters: { type: Type.OBJECT, properties: { query: { type: Type.STRING, description: 'What the skill should do, e.g. "sort my inbox", "debug a crash".' } }, required: ['query'] },
  },
  {
    name: 'skill_install',
    description: 'Install an Orbit skill (by slug from skill_search) into RAY’s Skills so RAY follows it from now on. Do it when Ray asks or agrees.',
    parameters: { type: Type.OBJECT, properties: { slug: { type: Type.STRING } }, required: ['slug'] },
  },
  {
    name: 'skill_list',
    description: 'List the Orbit skills RAY has installed. Read-only.',
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: 'skill_remove',
    description: 'Remove an installed Orbit skill (slug or id).',
    parameters: { type: Type.OBJECT, properties: { slug: { type: Type.STRING } }, required: ['slug'] },
  },
];

export async function executeSkillTool(
  roomId: string,
  name: string,
  args: Record<string, unknown>,
  opts: { confirmed: boolean }
): Promise<{ result: string; confirmation?: ConfirmationRequest } | null> {
  switch (name) {
    case 'skill_search': {
      const q = String(args.query || '');
      const installed = installedSkills(roomId).filter((s) => words(q).some((w) => `${s.title} ${s.summary}`.toLowerCase().includes(w)));
      try {
        const found = await searchCatalog(q, 8);
        return { result: JSON.stringify({ installed, orbit: found.map((s) => ({ slug: s.slug, title: s.title, does: s.summary, by: s.creator })) }) };
      } catch (err) {
        return { result: JSON.stringify({ installed, orbit: [], error: `Orbit unreachable: ${err instanceof Error ? err.message : err}` }) };
      }
    }
    case 'skill_install': {
      const slug = String(args.slug || '').trim();
      const r = await installSkill(roomId, slug, opts.confirmed);
      if (r.needsApproval) {
        const req = createConfirmationRequest({
          roomId,
          toolName: name,
          safetyLevel: 'sensitive',
          summary: `Install Orbit skill “${r.needsApproval.title}” — Orbit safety: ${r.needsApproval.safety}`,
          targetDevice: 'RAY skills',
          args,
        });
        return { result: `REQUIRES_CONFIRMATION: ${r.message} Waiting for Ray's Approve (confirmationId=${req.id}).`, confirmation: req };
      }
      return { result: r.message };
    }
    case 'skill_list':
      return { result: JSON.stringify(installedSkills(roomId)) };
    case 'skill_remove':
      return { result: removeSkill(roomId, String(args.slug || '')) ? 'Removed.' : 'No installed skill with that id.' };
    default:
      return null;
  }
}
