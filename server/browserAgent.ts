/**
 * Browser hands — RAY drives a real Chrome/Edge on Ray's PC (like Claude in Chrome).
 *
 * The PC bridge starts the browser with remote control on a dedicated "RAY" profile (Ray signs in
 * there once; it remembers). RAY reads each page as text + numbered buttons/fields, a free model
 * picks ONE next step (open, click, type, scroll, back, note, done), the bridge does it, repeat.
 *  - mode "research": read-only browsing in a hidden background browser; RAY collects notes and
 *    answers with sources. Used by daily self-learning too. No approval needed.
 *  - mode "do": visible browser, completes a task on websites (forms, bookings, settings). Needs
 *    one Approve. Never types passwords/OTPs/card numbers, never pays or posts without asking.
 * If no PC bridge is online, research falls back to server-side search + page fetching.
 */
import crypto from 'crypto';
import { Type } from '@google/genai';
import type { FunctionDeclaration } from '@google/genai';
import { createConfirmationRequest, newSecretSlot, putSecret, takeSecret } from './capabilities.ts';
import { broadcastHudSound, broadcastRoomEvent, dispatchBridgeProxyCall, getRoomDevices, isRoomInterrupted, setRoomInterrupted } from './hub.ts';
import { quickComplete } from './engines/router.ts';
import { webSearch } from './deviceTools.ts';
import type { ConfirmationRequest, DeviceInfo } from '../src/types/relay.ts';

interface PageView {
  title: string;
  url: string;
  text: string;
  elements: Array<{ i: number; tag: string; type?: string; label: string; href?: string; inView?: boolean }>;
  screenshot?: string;
  scrollY?: number;
  scrollMax?: number;
}

interface BrowseStep {
  thought?: string;
  action: 'open' | 'search' | 'click' | 'type' | 'key' | 'scroll' | 'back' | 'note' | 'done' | 'ask_user' | 'upload';
  path?: string;
  url?: string;
  query?: string;
  i?: number;
  text?: string;
  submit?: boolean;
  key?: string;
  dy?: number;
  note?: string;
  answer?: string;
}

export function browserBridge(roomId: string): DeviceInfo | undefined {
  return getRoomDevices(roomId).find((d) => d.online && d.type === 'bridge' && d.capabilities?.includes('browser-agent'));
}

const running = new Map<string, string>();

const SYSTEM = `You are RAY's browser hands. You see a web page as text plus numbered interactive elements [i].
Reply with ONLY JSON: {"thought":"<short reasoning>","action":"...", ...fields}
Actions:
 {"action":"open","url":"https://..."}            {"action":"search","query":"..."} (Google search)
 {"action":"click","i":12}                        {"action":"type","i":5,"text":"...","submit":true}
 {"action":"key","key":"enter|tab|escape|pagedown"} {"action":"scroll","dy":800}   {"action":"back"}
 {"action":"upload","path":"<file path on the PC, exactly as in the goal>"} (after opening the site's upload / "Select from computer" step)
 {"action":"note","note":"<facts worth keeping, with the page URL>"}
 {"action":"done","answer":"<final answer / what was done, cite URLs>"}   {"action":"ask_user","text":"<question>"}
Rules: one action per reply. Prefer opening a precise URL when you know it. Use "note" to save facts as you research,
then "done" with a complete answer. When the next step is a password / OTP field or a Pay / Place order button, still
choose that action ("type" with empty text, or "click") — RAY pauses and asks Ray before it happens. Never make up a
password or code. Don't post or send messages unless the goal says so. Dismiss cookie banners. If stuck, go back or search differently.`;

function parseStep(text: string): BrowseStep | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as BrowseStep;
    return j && typeof j.action === 'string' ? j : null;
  } catch {
    return null;
  }
}

function describePage(p: PageView): string {
  const els = p.elements
    .slice(0, 90)
    .map((e) => `[${e.i}] ${e.tag}${e.type ? `:${e.type}` : ''} "${e.label}"${e.href && e.tag === 'a' ? ` → ${e.href.slice(0, 70)}` : ''}${e.inView ? '' : ' (below)'}`)
    .join('\n');
  return `URL: ${p.url}\nTitle: ${p.title}\nScroll: ${p.scrollY ?? 0}/${p.scrollMax ?? 0}\n\nPage text (start):\n${p.text.slice(0, 4500)}\n\nElements:\n${els}`;
}

interface HardStop {
  kind: 'secret' | 'pay';
  i: number;
  label: string;
  url: string;
  amount?: string;
}
const SECRET_FIELD = /\b(password|passcode|otp|one[- ]time|verification code|security code|pin|cvv|cvc|2fa|auth(entication)? code)\b/i;
const PAY_BUTTON = /\b(pay( now)?|place (your )?order|buy now|confirm (purchase|payment|order|booking)|complete (purchase|payment|order|booking)|submit payment|proceed to pay|make payment|book now|subscribe)\b/i;
const CAPTCHA = /captcha|i'?m not a robot|verify (that )?you are (a )?human|are you a robot|press (and|&) hold|unusual traffic|security check to continue/i;
const host = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return u.slice(0, 40);
  }
};
function findAmount(text: string): string | undefined {
  const re = /(₹|rs\.?|inr|\$|usd|€|eur|£|gbp)\s?[\d,]+(\.\d{1,2})?/gi;
  const t = text.slice(0, 12000);
  const totalIdx = t.search(/\b(order total|grand total|total amount|amount payable|total|you pay)\b/i);
  if (totalIdx >= 0) {
    const m = t.slice(totalIdx, totalIdx + 160).match(re);
    if (m) return m[0];
  }
  return t.match(re)?.[0];
}
const isCaptcha = (p: PageView) => CAPTCHA.test(`${p.title} ${p.text.slice(0, 4000)} ${p.elements.map((e) => e.label).join(' ')}`);

/** Server-side fallback: fetch a page and strip it to text. */
export async function fetchPageText(url: string, max = 7000): Promise<string> {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', Accept: 'text/html,*/*' },
      signal: AbortSignal.timeout(12000),
      redirect: 'follow',
    });
    if (!r.ok || !/text|html|json/.test(r.headers.get('content-type') || '')) return '';
    const html = (await r.text()).slice(0, 800_000);
    return html
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>|<svg[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<(br|p|div|li|h\d|tr)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&#39;|&#x27;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n+/g, '\n')
      .trim()
      .slice(0, max);
  } catch {
    return '';
  }
}

/** Read one URL with the real browser when possible (JS pages), else server fetch. */
export async function readUrl(roomId: string, url: string): Promise<string> {
  const text = await fetchPageText(url);
  if (text.length > 600) return text;
  const pc = browserBridge(roomId);
  if (!pc) return text;
  const out = await dispatchBridgeProxyCall(roomId, { action: 'browser', op: 'open', url, background: true }, 45000, pc.id);
  return out.ok ? String((out.data as PageView).text || '').slice(0, 7000) : text;
}

/** Research without a browser on the PC: search + fetch + summarize. */
export async function serverResearch(goal: string, maxPages = 4): Promise<{ answer: string; sources: string[] }> {
  const results = await webSearch(goal, 8).catch(() => []);
  const pages: Array<{ url: string; title: string; text: string }> = [];
  for (const r of results) {
    if (pages.length >= maxPages) break;
    const text = await fetchPageText(r.url, 5000);
    if (text.length > 400) pages.push({ url: r.url, title: r.title, text });
  }
  if (!pages.length && !results.length) return { answer: 'I could not reach any search results right now.', sources: [] };
  const material = pages.length
    ? pages.map((p, n) => `SOURCE ${n + 1}: ${p.title} (${p.url})\n${p.text}`).join('\n\n---\n\n')
    : results.map((r) => `- ${r.title} (${r.url}): ${r.snippet}`).join('\n');
  const answer = await quickComplete(
    `Goal: ${goal}\n\nMaterial:\n${material.slice(0, 18000)}\n\nWrite a clear, factual answer (markdown, key points first, dates where relevant). Cite sources as [n] with URLs at the end. If the material is thin, say what is uncertain.`,
    'You are a careful research analyst for a personal assistant.',
    'reasoning',
    { maxTokens: 1400, timeoutMs: 60000 }
  );
  return { answer, sources: (pages.length ? pages : results).map((p) => p.url) };
}

async function runBrowse(roomId: string, taskId: string, goal: string, mode: 'do' | 'research', bridgeId: string, startUrl?: string, resume = false, useLogin = false): Promise<string | HardStop> {
  const emit = (data: Record<string, unknown>) => broadcastRoomEvent(roomId, 'agent:update', { taskId, task: goal, target: 'browser', mode, ...data });
  // Research runs in a hidden browser — unless it needs Ray's logins (Instagram inbox, web mail…).
  const background = mode === 'research' && !useLogin;
  const history: string[] = [];
  const notes: string[] = [];
  const maxSteps = mode === 'research' ? 14 : 25;
  setRoomInterrupted(roomId, false);
  emit({ status: 'running', step: 0 });
  let page: PageView | null = null;
  const first = await dispatchBridgeProxyCall(
    roomId,
    resume
      ? { action: 'browser', op: 'read', background, screenshot: !background }
      : { action: 'browser', op: 'open', newTab: true, url: startUrl || `https://www.google.com/search?q=${encodeURIComponent(goal)}`, background, screenshot: !background },
    45000,
    bridgeId
  );
  if (!first.ok) throw new Error(first.error || 'Browser did not open');
  page = first.data as PageView;
  let final = '';
  for (let step = 1; step <= maxSteps; step++) {
    if (isRoomInterrupted(roomId)) {
      final = 'Stopped by Ray.';
      break;
    }
    const prompt = `Goal: ${goal}\nMode: ${mode}\nStep ${step}/${maxSteps}${step >= maxSteps - 2 ? ' — finish now with "done"' : ''}\nNotes so far:\n${notes.join('\n') || '(none)'}\nPrevious steps:\n${history.slice(-8).join('\n') || '(none)'}\n\nCURRENT PAGE\n${describePage(page)}`;
    let plan: BrowseStep | null = null;
    try {
      plan = parseStep(await quickComplete(prompt, SYSTEM, 'tools', { maxTokens: 700, timeoutMs: 40000 }));
    } catch (err) {
      final = `Engine error: ${err instanceof Error ? err.message : err}`;
      break;
    }
    if (!plan) {
      history.push(`${step}. (unreadable reply)`);
      continue;
    }
    // HARD STOPS — passwords/OTPs and Pay buttons pause for Ray's approval (handled by the caller).
    if (mode === 'do' && (plan.action === 'type' || plan.action === 'click') && plan.i != null) {
      const el = page.elements.find((e) => e.i === Number(plan!.i));
      if (el && plan.action === 'type' && (el.type === 'password' || SECRET_FIELD.test(el.label))) {
        emit({ status: 'waiting', step, say: `Needs your ${el.type === 'password' ? 'password' : el.label || 'code'}` });
        return { kind: 'secret', i: el.i, label: el.type === 'password' ? 'password' : el.label || 'code', url: page.url };
      }
      if (el && plan.action === 'click' && PAY_BUTTON.test(el.label)) {
        emit({ status: 'waiting', step, say: `Waiting for your OK to press “${el.label}”` });
        return { kind: 'pay', i: el.i, label: el.label.slice(0, 80), url: page.url, amount: findAmount(page.text) };
      }
    }
    emit({ status: 'running', step, thought: plan.thought, action: { action: plan.action, x: undefined, text: plan.text || plan.url || plan.query }, screenshot: page.screenshot, say: `${page.title}` });
    if (plan.action === 'done') {
      final = plan.answer || 'Done.';
      break;
    }
    if (plan.action === 'ask_user') {
      final = `I need you: ${plan.text || 'please take over in the browser.'}`;
      break;
    }
    if (plan.action === 'note') {
      if (plan.note) notes.push(`- ${plan.note.slice(0, 600)}`);
      history.push(`${step}. noted`);
      continue;
    }
    const req: Record<string, unknown> = { action: 'browser', background, screenshot: !background };
    if (plan.action === 'open') Object.assign(req, { op: 'open', url: plan.url });
    else if (plan.action === 'search') Object.assign(req, { op: 'open', url: `https://www.google.com/search?q=${encodeURIComponent(plan.query || goal)}` });
    else if (plan.action === 'click') Object.assign(req, { op: 'click', i: plan.i, text: plan.text });
    else if (plan.action === 'type') Object.assign(req, { op: 'type', i: plan.i, value: plan.text, submit: plan.submit });
    else if (plan.action === 'key') Object.assign(req, { op: 'key', key: plan.key });
    else if (plan.action === 'scroll') Object.assign(req, { op: 'scroll', dy: plan.dy || 800 });
    else if (plan.action === 'back') Object.assign(req, { op: 'back' });
    else if (plan.action === 'upload') {
      // Only files Ray named in the goal can be uploaded.
      const p = String(plan.path || '').trim();
      if (!p || !goal.includes(p)) {
        history.push(`${step}. upload refused — use the exact file path from the goal`);
        continue;
      }
      Object.assign(req, { op: 'upload', path: p, i: plan.i });
    }
    else Object.assign(req, { op: 'read' });
    const out = await dispatchBridgeProxyCall(roomId, req, 45000, bridgeId);
    if (!out.ok && /PASSWORD_FIELD/.test(out.error || '') && plan.i != null) {
      return { kind: 'secret', i: Number(plan.i), label: 'password', url: page.url };
    }
    history.push(`${step}. ${plan.action} ${plan.i ?? ''} ${plan.url || plan.query || plan.text || ''}`.trim().slice(0, 160) + ` → ${out.ok ? 'ok' : `failed: ${out.error}`}`);
    if (out.ok) page = out.data as PageView;
    // CAPTCHA: RAY never solves it — it brings the browser in front of Ray and waits, then carries on.
    if (out.ok && page && isCaptcha(page)) {
      if (mode !== 'do') {
        history.push(`${step}. CAPTCHA on ${host(page.url)} — skipped this site`);
        const back = await dispatchBridgeProxyCall(roomId, { action: 'browser', op: 'back', background }, 20000, bridgeId);
        if (back.ok) page = back.data as PageView;
        continue;
      }
      await dispatchBridgeProxyCall(roomId, { action: 'browser', op: 'front' }, 15000, bridgeId);
      broadcastHudSound(roomId, 'alert');
      emit({ status: 'waiting', step, say: 'Please solve the CAPTCHA in the browser — I’ll continue right after.', screenshot: page.screenshot });
      const until = Date.now() + 4 * 60_000;
      let solved = false;
      while (Date.now() < until && !isRoomInterrupted(roomId)) {
        await new Promise((r) => setTimeout(r, 4000));
        const chk = await dispatchBridgeProxyCall(roomId, { action: 'browser', op: 'read', screenshot: true }, 20000, bridgeId);
        if (chk.ok && !isCaptcha(chk.data as PageView)) {
          page = chk.data as PageView;
          solved = true;
          break;
        }
      }
      if (!solved) {
        final = 'I need you: the CAPTCHA was not solved within 4 minutes. Solve it in the browser and tell me to continue.';
        break;
      }
      history.push(`${step}. Ray solved the CAPTCHA`);
    }
  }
  if (!final) {
    final = notes.length
      ? await quickComplete(`Goal: ${goal}\nNotes:\n${notes.join('\n')}\nWrite the final answer with URLs.`, 'Concise research writer.', 'chat', { maxTokens: 900 })
      : `Stopped after ${maxSteps} steps. Last page: ${page?.title} (${page?.url}).`;
  }
  emit({ status: /^Stopped|^I need|^Engine error/.test(final) ? 'stopped' : 'done', result: final.slice(0, 1500), steps: history });
  broadcastHudSound(roomId, 'affirmative');
  return notes.length && mode === 'research' ? `${final}\n\nNotes:\n${notes.join('\n')}` : final;
}

export const browserToolDeclarations: FunctionDeclaration[] = [
  {
    name: 'browse_web',
    description:
      'RAY uses a REAL browser on Ray’s PC (like Claude in Chrome): reads pages, clicks, types, follows links. mode "research" (default) = read-only deep research in a hidden browser, returns an answer with sources. mode "do" = complete a task on a website (fill a form, change a setting, find and add to cart) in a visible browser — needs Ray’s approval; never pays or submits payments/passwords.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        goal: { type: Type.STRING, description: 'What to find out or do, in plain words.' },
        mode: { type: Type.STRING, description: '"research" (default) or "do".' },
        startUrl: { type: Type.STRING, description: 'Optional page to start on.' },
      },
      required: ['goal'],
    },
  },
  {
    name: 'read_web_page',
    description: 'Read the text of one web page (uses the real browser for JavaScript pages). Read-only.',
    parameters: { type: Type.OBJECT, properties: { url: { type: Type.STRING, description: 'https URL' } }, required: ['url'] },
  },
];

export async function executeBrowserTool(
  roomId: string,
  name: string,
  args: Record<string, unknown>,
  opts: { confirmed: boolean }
): Promise<{ result: string; confirmation?: ConfirmationRequest } | null> {
  if (name === 'read_web_page') {
    const url = String(args.url || '');
    if (!/^https?:\/\//i.test(url)) return { result: 'Give a full https:// URL.' };
    const text = await readUrl(roomId, url);
    return { result: text ? text.slice(0, 9000) : `Could not read ${url}.` };
  }
  if (name !== 'browse_web') return null;
  const goal = String(args.goal || '').trim();
  if (!goal) return { result: 'What should I look up or do in the browser?' };
  const mode = /do|act|complete|fill/i.test(String(args.mode || '')) ? 'do' : 'research';
  const startUrl = /^https?:\/\//i.test(String(args.startUrl || '')) ? String(args.startUrl) : undefined;
  const pc = browserBridge(roomId);
  if (!pc) {
    if (args.useLogin) return { result: 'This needs RAY’s browser on Ray’s PC (his logins), and the PC bridge is offline.' };
    if (mode === 'do') return { result: 'The PC bridge (v3.1+) must be online to use the browser for tasks. Update the bridge from Connect → Install, or ask me to research instead.' };
    const r = await serverResearch(goal);
    return { result: `${r.answer}\n\n(Researched from the cloud — the PC browser is offline.)` };
  }
  if (running.has(roomId)) return { result: `Browser is busy with: ${running.get(roomId)}. Say "stop" to cancel.` };
  // Approved hard stop: type the secret / press Pay, then carry on with the same goal.
  let resume = Boolean(args.resume);
  if (opts.confirmed && (args.hardStop === 'secret' || args.hardStop === 'pay')) {
    const i = Number(args.i);
    if (args.hardStop === 'secret') {
      const value = takeSecret(String(args.secretSlot || ''));
      if (!value) return { result: `No ${args.label || 'password'} was entered, so I stopped. Ask me again when you're ready.` };
      const typed = await dispatchBridgeProxyCall(roomId, { action: 'browser', op: 'type', i, value, allowSecret: true }, 30000, pc.id);
      if (!typed.ok) return { result: `Could not type into that field: ${typed.error}` };
    } else {
      const clicked = await dispatchBridgeProxyCall(roomId, { action: 'browser', op: 'click', i }, 45000, pc.id);
      if (!clicked.ok) return { result: `Could not press “${args.label}”: ${clicked.error}` };
    }
    resume = true;
  }
  if (mode === 'do' && !opts.confirmed) {
    const req = createConfirmationRequest({
      roomId,
      toolName: 'browse_web',
      safetyLevel: 'sensitive',
      summary: `Use the browser on ${pc.name} to: "${goal}". It can click and type on websites (never passwords or payments). Stop any time.`,
      targetDevice: pc.name,
      args: { goal, mode, startUrl },
    });
    broadcastHudSound(roomId, 'alert');
    return { result: `REQUIRES_CONFIRMATION: Ready to do this in the browser on ${pc.name}. Tap Approve (confirmationId=${req.id}).`, confirmation: req };
  }
  const taskId = crypto.randomUUID().slice(0, 8);
  running.set(roomId, goal);
  try {
    const answer = await runBrowse(roomId, taskId, goal, mode, pc.id, startUrl, resume, Boolean(args.useLogin));
    if (typeof answer === 'string') return { result: answer };
    return await hardStopConfirmation(roomId, pc, goal, answer);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    broadcastRoomEvent(roomId, 'agent:update', { taskId, task: goal, target: 'browser', status: 'stopped', result: msg });
    if (mode === 'research' && !args.useLogin) {
      const r = await serverResearch(goal);
      return { result: `${r.answer}\n\n(PC browser failed: ${msg}; researched from the cloud instead.)` };
    }
    return { result: `Browser task failed: ${msg}` };
  } finally {
    running.delete(roomId);
  }
}

/** Turns a hard stop into Ray's approval card (with a secure input for passwords / codes). */
async function hardStopConfirmation(roomId: string, pc: DeviceInfo, goal: string, hs: HardStop): Promise<{ result: string; confirmation: ConfirmationRequest }> {
  const site = host(hs.url);
  let req: ConfirmationRequest;
  if (hs.kind === 'secret') {
    const slot = newSecretSlot();
    let found = '';
    if (!/password/i.test(hs.label)) found = await otpFromPhone(roomId).catch(() => '');
    if (found) putSecret(slot, found);
    req = createConfirmationRequest({
      roomId,
      toolName: 'browse_web',
      safetyLevel: 'sensitive',
      summary: found
        ? `Enter the code from your phone (${found.slice(0, 2)}••••) into “${hs.label}” on ${site}, then continue: "${goal}". Type a different code below to override.`
        : `Type your ${hs.label} into ${site} so I can continue: "${goal}". It is used once and never saved or shown to the AI.`,
      targetDevice: pc.name,
      args: { goal, mode: 'do', hardStop: 'secret', i: hs.i, label: hs.label, secretSlot: slot, site },
      secretPrompt: `Your ${hs.label} for ${site}`,
    });
  } else {
    req = createConfirmationRequest({
      roomId,
      toolName: 'browse_web',
      safetyLevel: 'sensitive',
      summary: `Press “${hs.label}” on ${site}${hs.amount ? ` — amount on the page: ${hs.amount}` : ''}, then finish: "${goal}".`,
      targetDevice: pc.name,
      args: { goal, mode: 'do', hardStop: 'pay', i: hs.i, label: hs.label, site },
    });
  }
  broadcastHudSound(roomId, 'alert');
  return {
    result: `REQUIRES_CONFIRMATION: paused at ${hs.kind === 'secret' ? `the ${hs.label} field` : `“${hs.label}”`} on ${site} — waiting for Ray (confirmationId=${req.id}).`,
    confirmation: req,
  };
}

/** Looks for a fresh one-time code in the phone's notifications (SMS / authenticator apps). */
async function otpFromPhone(roomId: string): Promise<string> {
  const phone = getRoomDevices(roomId).find((d) => d.online && d.type === 'bridge' && /android/i.test(d.os || ''));
  if (!phone) return '';
  const out = await dispatchBridgeProxyCall(roomId, { action: 'read_notifications' }, 10000, phone.id);
  if (!out.ok) return '';
  const items = (Array.isArray(out.data) ? out.data : (out.data as { notifications?: unknown[] })?.notifications || []) as Array<Record<string, unknown>>;
  for (const n of items.slice(0, 15)) {
    const text = `${n.title || ''} ${n.content || n.text || ''}`;
    if (!/\b(otp|code|verification|one[- ]time|passcode|login)\b/i.test(text)) continue;
    const m = text.match(/\b(\d{4,8})\b/);
    if (m) return m[1];
  }
  return '';
}
