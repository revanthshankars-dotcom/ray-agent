/**
 * CONTACT FINDER — turns "Arun", "priya s", "amma" into the right person for WhatsApp, Instagram and
 * calls, instead of treating the name as a search keyword or asking for a number.
 *
 * Looks in (best first): people Ray already confirmed (remembered), the linked WhatsApp's contacts and
 * chats, and his Android phone's contacts (Termux bridge, cached). Names match fuzzily (first name,
 * initials, small typos / voice mis-hearings). When two people match about equally it asks Ray which
 * one (ask_user: a card in RAY, a dialog on his phone…) instead of guessing, and remembers the answer.
 */
import { seal, unseal } from './accounts.ts';
import { dispatchBridgeProxyCall, getRoomDevices } from './hub.ts';
import { loadJson, scheduleSave } from './persistence.ts';
import { normName, scoreName } from './nameMatch.ts';
import { whatsappContactList } from './whatsappLink.ts';
import { startAsk, waitForAnswer } from './askUser.ts';

export type ContactApp = 'whatsapp' | 'instagram' | 'phone';
export interface ContactHit {
  name: string;
  source: 'remembered' | 'whatsapp' | 'phone contacts';
  digits?: string; // phone number, digits only (WhatsApp / calls)
  jid?: string; // linked-WhatsApp chat id (works even when WhatsApp hides the number)
  instagram?: string; // username
  score: number;
  lastAt?: number;
}
interface Saved {
  name: string;
  aliases: string[];
  digits?: string;
  instagram?: string;
  at: number;
}

// --- remembered people (sealed: phone numbers are personal) ------------------------------------------
const saved = new Map<string, Saved[]>();
async function savedFor(roomId: string): Promise<Saved[]> {
  if (!saved.has(roomId)) {
    const raw = (await loadJson<{ blob?: string }>(`contacts-${roomId}`).catch(() => null)) as { blob?: string } | null;
    let list: Saved[] = [];
    try {
      const plain = raw?.blob ? unseal(raw.blob) : null;
      if (plain) list = JSON.parse(plain) as Saved[];
    } catch {
      list = [];
    }
    saved.set(roomId, Array.isArray(list) ? list : []);
  }
  return saved.get(roomId)!;
}

/** Remember who Ray meant ("Arun" = Arun Kumar, +91…, @arun.k) so next time there is no question. */
export async function rememberContact(roomId: string, said: string, c: { name: string; digits?: string; instagram?: string }) {
  const list = await savedFor(roomId);
  const key = normName(c.name);
  let e = list.find((x) => normName(x.name) === key || (c.digits && x.digits === c.digits) || (c.instagram && x.instagram === c.instagram));
  if (!e) {
    e = { name: c.name, aliases: [], at: Date.now() };
    list.push(e);
  }
  if (c.digits) e.digits = c.digits;
  if (c.instagram) e.instagram = c.instagram.replace(/^@/, '');
  const alias = normName(said);
  if (alias && alias !== key && !e.aliases.includes(alias)) e.aliases = [...e.aliases, alias].slice(-8);
  e.at = Date.now();
  if (list.length > 500) list.splice(0, list.length - 500);
  scheduleSave(`contacts-${roomId}`, () => ({ blob: seal(JSON.stringify(list)) }), 500);
}

// --- phone contacts (Android bridge, memory only) ------------------------------------------------------
const phoneCache = new Map<string, { at: number; list: Array<{ name: string; number: string }> }>();
async function phoneContacts(roomId: string): Promise<Array<{ name: string; number: string }>> {
  const c = phoneCache.get(roomId);
  // A full list is good for 6 h; an empty one (permission just granted, contacts just synced) only for a minute.
  if (c && Date.now() - c.at < (c.list.length ? 6 * 3600_000 : 60_000)) return c.list;
  const phone = getRoomDevices(roomId).find((d) => d.online && d.type === 'bridge' && /android/i.test(d.os || ''));
  if (!phone) return c?.list || [];
  const out = await dispatchBridgeProxyCall(roomId, { action: 'list_contacts' }, 15000, phone.id).catch(() => ({ ok: false, data: undefined }));
  const list = out.ok && Array.isArray(out.data) ? (out.data as Array<{ name: string; number: string }>) : null;
  if (list) phoneCache.set(roomId, { at: Date.now(), list });
  return list || c?.list || [];
}

const digitsOf = (s?: string) => String(s || '').replace(/[^\d]/g, '');
const looksLikeNumber = (s: string) => /^[+\d\s()-]{8,}$/.test(s.trim()) && digitsOf(s).length >= 8;
const looksLikeHandle = (s: string) => /^@?[a-z0-9._]{3,30}$/i.test(s.trim()) && (/^@/.test(s.trim()) || /[._\d]/.test(s));

/** Everyone who could be meant, best first (same person from several sources merged). */
export async function findContacts(roomId: string, query: string, app: ContactApp): Promise<ContactHit[]> {
  const q = query.trim().replace(/^@/, '');
  const hits: ContactHit[] = [];
  for (const e of await savedFor(roomId)) {
    const score = Math.max(scoreName(q, e.name), ...e.aliases.map((a) => (a === normName(q) ? 1 : scoreName(q, a) * 0.95)), e.instagram ? scoreName(q, e.instagram) : 0);
    if (score >= 0.6) hits.push({ name: e.name, source: 'remembered', digits: e.digits, instagram: e.instagram, score: Math.min(1, score + 0.03), lastAt: e.at });
  }
  if (app !== 'instagram') {
    for (const c of await whatsappContactList(roomId).catch(() => [])) {
      const score = scoreName(q, c.name);
      if (score >= 0.6) hits.push({ name: c.name, source: 'whatsapp', digits: c.digits, jid: c.jid, score, lastAt: c.lastAt });
    }
    for (const c of await phoneContacts(roomId)) {
      const score = scoreName(q, c.name);
      if (score >= 0.6) hits.push({ name: c.name, source: 'phone contacts', digits: digitsOf(c.number), score });
    }
  }
  // Merge the same person (same number, or same name) and keep the best score.
  const merged: ContactHit[] = [];
  for (const h of hits.sort((a, b) => b.score - a.score || (b.lastAt || 0) - (a.lastAt || 0))) {
    const same = merged.find((m) => (h.digits && m.digits && h.digits.slice(-9) === m.digits.slice(-9)) || normName(m.name) === normName(h.name));
    if (same) {
      same.digits ||= h.digits;
      same.instagram ||= h.instagram;
      same.jid ||= h.jid;
      continue;
    }
    merged.push({ ...h });
  }
  return app === 'instagram' ? merged : merged.filter((m) => m.digits || m.jid || m.source === 'remembered');
}

export type Resolution =
  | { status: 'found'; hit: ContactHit; note: string }
  | { status: 'ambiguous'; candidates: ContactHit[]; note: string; askId?: string }
  | { status: 'none'; note: string };

const label = (h: ContactHit) => `${h.name}${h.digits ? ` (…${h.digits.slice(-4)})` : h.instagram ? ` (@${h.instagram})` : ''}`;

/**
 * The one person Ray means. Numbers and @handles pass straight through. When several people fit about
 * equally, asks Ray (waits up to waitMs) and remembers his answer.
 */
export async function resolveContact(roomId: string, said: string, app: ContactApp, opts: { ask?: boolean; waitMs?: number; why?: string } = {}): Promise<Resolution> {
  const q = said.trim();
  if (!q) return { status: 'none', note: 'No name given.' };
  if (looksLikeNumber(q)) return { status: 'found', hit: { name: q, source: 'remembered', digits: digitsOf(q), score: 1 }, note: '' };
  if (app === 'instagram' && looksLikeHandle(q)) return { status: 'found', hit: { name: q.replace(/^@/, ''), source: 'remembered', instagram: q.replace(/^@/, ''), score: 1 }, note: '' };

  const list = await findContacts(roomId, q, app);
  if (!list.length) return { status: 'none', note: `No contact matches "${q}"` };
  const [top, second] = list;
  const clear = top.score >= 0.9 && (!second || top.score - second.score >= 0.08 || (top.source === 'remembered' && normName(q) !== normName(second.name)));
  const exactOnlyOne = normName(top.name) === normName(q) && (!second || normName(second.name) !== normName(q));
  if (clear || exactOnlyOne || (top.score >= 0.75 && !second)) return { status: 'found', hit: top, note: top.score < 0.9 ? `(closest match for "${q}")` : '' };

  const candidates = list.slice(0, 5);
  if (!opts.ask) return { status: 'ambiguous', candidates, note: `Several people match "${q}": ${candidates.map(label).join(', ')}` };
  const options = [...candidates.map(label), 'None of these'];
  const a = startAsk(roomId, { question: `Which "${q}" did you mean${app === 'phone' ? '' : ` on ${app === 'whatsapp' ? 'WhatsApp' : 'Instagram'}`}?`, options, why: opts.why || '' });
  const done = await waitForAnswer(a, opts.waitMs ?? 180_000);
  if (!done?.answer) return { status: 'ambiguous', candidates, askId: a.id, note: `Asked Ray which "${q}" (askId=${a.id}); no answer yet` };
  const ans = done.answer.trim();
  const pick = candidates.find((c, i) => ans === label(c) || ans === String(i + 1) || scoreName(ans, c.name) >= 0.9 || (c.digits && digitsOf(ans).length >= 4 && c.digits.endsWith(digitsOf(ans))));
  if (!pick) {
    if (looksLikeNumber(ans)) return { status: 'found', hit: { name: q, source: 'remembered', digits: digitsOf(ans), score: 1 }, note: '' };
    return { status: 'none', note: `Ray said "${ans}" — none of the matches` };
  }
  await rememberContact(roomId, q, pick);
  return { status: 'found', hit: pick, note: '(Ray picked)' };
}
