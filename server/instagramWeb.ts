/**
 * INSTAGRAM (free, personal accounts) — Meta offers no API for personal accounts, so RAY uses
 * instagram.com itself in RAY's browser on Ray's PC (he logs in once, like any browser): read DMs,
 * read a conversation, the feed and stories, profiles; send DMs; post photos/reels from a file on the
 * PC (the bridge drops the file into Instagram's upload dialog); comment and like.
 * Reading needs no approval. Sending, posting, commenting and liking ask Ray first. Business/creator
 * accounts can also use the official Graph API (meta_api_request).
 */
import { Type } from '@google/genai';
import type { FunctionDeclaration } from '@google/genai';
import { browserBridge, executeBrowserTool } from './browserAgent.ts';
import { findContacts, rememberContact } from './contactFinder.ts';
import { startAsk, waitForAnswer } from './askUser.ts';
import { createConfirmationRequest } from './capabilities.ts';
import { broadcastHudSound } from './hub.ts';
import type { ConfirmationRequest } from '../src/types/relay.ts';

const IG = 'https://www.instagram.com';

export const instagramToolDeclarations: FunctionDeclaration[] = [
  {
    name: 'instagram',
    description:
      'Ray’s personal Instagram through instagram.com in RAY’s browser on his PC (free; he logs in there once). action: dms (unread / recent conversations) | read_dm (one conversation; to=username or name) | send_dm (to, text) | feed (what’s new) | stories (whose stories are up, what they show) | profile (user) | post (path = photo/video file on the PC, caption) | reel (path, caption) | comment (url, text) | like (url). Reading is free; sending, posting, commenting and liking ask Ray first.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        action: { type: Type.STRING },
        to: { type: Type.STRING, description: 'Username or name for DMs.' },
        user: { type: Type.STRING, description: 'Username for profile.' },
        text: { type: Type.STRING, description: 'DM or comment text.' },
        path: { type: Type.STRING, description: 'File on Ray’s PC to post, e.g. "Pictures/beach.jpg" or a full path.' },
        caption: { type: Type.STRING },
        url: { type: Type.STRING, description: 'Post/reel URL for comment or like.' },
      },
      required: ['action'],
    },
  },
];

const isHandle = (s: string) => /^@?[a-z0-9._]{3,30}$/i.test(s.trim()) && (/^@/.test(s.trim()) || /[._\d]/.test(s));

/**
 * How the browser agent should reach a person's DM: by @username when known (typed or remembered),
 * otherwise by their display name inside the DM inbox / "New message" box — never the main search.
 */
export async function instagramTarget(roomId: string, to: string): Promise<{ open: string; startUrl: string; handle?: string } | { error: string }> {
  const t = to.trim();
  if (!t) return { error: 'Who? Give the name or @username.' };
  let handle = isHandle(t) ? t.replace(/^@/, '') : '';
  if (!handle) {
    const known = (await findContacts(roomId, t, 'instagram').catch(() => [])).filter((c) => c.instagram && c.score >= 0.9);
    if (known.length === 1 || (known[0] && known[0].score - (known[1]?.score || 0) >= 0.08)) handle = known[0].instagram!;
  }
  const startUrl = `${IG}/direct/inbox/`;
  if (handle) {
    return {
      handle,
      startUrl,
      open: `On Instagram, open the direct-message conversation with the account @${handle}: find it in the conversation list of the DM inbox; if it isn't there, click the New message (pencil) icon at the top of the inbox, type ${handle} in that dialog's search box, choose the account whose username is exactly ${handle}, and click Chat. Do not use the main Search in the left sidebar.`,
    };
  }
  return {
    startUrl,
    open: `On Instagram, open the direct-message conversation with the person named "${t}". Do NOT use the main Search in the left sidebar or the Explore page, and do not search "${t}" as a keyword. First look through the conversation list in the DM inbox for a chat whose display name matches "${t}" (a first name is enough: "Arun" matches "Arun Kumar"; ignore emojis). If it isn't listed, click the New message (pencil) icon at the top of the inbox, type "${t}" in that dialog's search box and look at the people suggested (they show display name and @username). If exactly one person clearly matches, choose them and click Chat. If several people match about equally, do NOT pick one: stop and answer exactly "SEVERAL_MATCHES: " followed by each as Display Name (@username), separated by "; ". If nobody matches, stop and answer "NO_MATCH". Never ask for a phone number. Once the conversation is open, include "OPENED: @username" in your answer.`,
  };
}

/** Runs an Instagram DM task; if several people match the name, asks Ray which one and retries once. */
export async function runInstagramDmTask(
  roomId: string,
  to: string,
  task: (open: string) => string,
  mode: 'do' | 'research',
  opts: { confirmed: boolean }
): Promise<{ result: string; confirmation?: ConfirmationRequest }> {
  const first = await instagramTarget(roomId, to);
  if ('error' in first) return { result: first.error };
  const run = async (open: string, startUrl: string) =>
    (await executeBrowserTool(roomId, 'browse_web', { goal: task(open) + LOGIN_HINT, mode, startUrl, useLogin: true }, opts)) || { result: 'RAY’s browser did not respond.' };
  let out = await run(first.open, first.startUrl);
  if (out.confirmation) return out;
  const several = /SEVERAL_MATCHES:\s*([^\n]+)/.exec(out.result || '');
  if (several && !first.handle) {
    const people = several[1].split(/\s*;\s*/).map((x) => x.trim()).filter(Boolean).slice(0, 5);
    const a = startAsk(roomId, { question: `Which "${to}" on Instagram?`, options: [...people, 'None of these'], why: 'Instagram message / call' });
    const done = await waitForAnswer(a, 180_000);
    const handle = /@([a-z0-9._]{2,30})/i.exec(done?.answer || '')?.[1];
    if (!handle) return { result: done?.answer ? `Ray said "${done.answer}", so I stopped.` : `Several Instagram accounts match "${to}": ${people.join('; ')}. I asked Ray which one (askId=${a.id}).` };
    const disp = (done!.answer || '').replace(/\s*\(@[^)]*\)\s*/, '').trim() || to;
    await rememberContact(roomId, to, { name: disp, instagram: handle });
    const again = await instagramTarget(roomId, `@${handle}`);
    if ('error' in again) return { result: again.error };
    out = await run(again.open, again.startUrl);
  } else if (!first.handle) {
    // Learn the username for next time.
    const opened = /OPENED:\s*@([a-z0-9._]{2,30})/i.exec(out.result || '')?.[1];
    if (opened && !/NO_MATCH/.test(out.result || '')) await rememberContact(roomId, to, { name: to, instagram: opened });
  }
  if (/NO_MATCH/.test(out.result || '')) return { result: `No one called "${to}" in your Instagram DMs or the New-message search. Give their @username and I'll remember it.` };
  return out;
}

const OFFLINE =
  'Instagram runs in RAY’s browser on Ray’s PC, and the PC bridge is offline. Turn the PC on (RAY starts with it), or use the phone: read_incoming_messages shows Instagram DMs from phone notifications.';
const LOGIN_HINT =
  ' If Instagram shows a login page, stop and answer exactly: "Ray needs to log into Instagram once in RAY’s browser window on his PC (JARVIS Core → Accounts → Instagram → Log in)."';

export async function executeInstagramTool(
  roomId: string,
  name: string,
  args: Record<string, unknown>,
  opts: { confirmed: boolean }
): Promise<{ result: string; confirmation?: ConfirmationRequest } | null> {
  if (name !== 'instagram') return null;
  const a = String(args.action || 'dms').toLowerCase();
  const to = String(args.to || '').trim();
  const user = String(args.user || to).trim().replace(/^@/, '');
  const text = String(args.text || '').trim();
  const caption = String(args.caption || text).trim();
  const path = String(args.path || '').trim();
  const url = String(args.url || '').trim();

  const WRITE_SUMMARY: Record<string, string> = {
    send_dm: `Instagram: send “${text.slice(0, 160)}” to ${to}`,
    post: `Instagram: post ${path} with caption “${caption.slice(0, 120)}”`,
    reel: `Instagram: post reel ${path} with caption “${caption.slice(0, 120)}”`,
    comment: `Instagram: comment “${text.slice(0, 120)}” on ${url}`,
    like: `Instagram: like ${url}`,
  };
  if (WRITE_SUMMARY[a] && !opts.confirmed && (to || path || url)) {
    if (!browserBridge(roomId)) return { result: OFFLINE };
    // Ray approves once here, in plain words; the approved run then finds the person and does it.
    const req = createConfirmationRequest({ roomId, toolName: 'instagram', safetyLevel: 'sensitive', summary: WRITE_SUMMARY[a], targetDevice: 'RAY’s browser on the PC', args });
    broadcastHudSound(roomId, 'alert');
    return { result: `REQUIRES_CONFIRMATION: ${WRITE_SUMMARY[a]} — waiting for Ray (confirmationId=${req.id}).`, confirmation: req };
  }
  let goal = '';
  let startUrl = IG;
  let write = false;
  switch (a) {
    case 'dms':
      goal = 'On Instagram, read the direct message inbox: list the recent conversations (who, last message, unread or not, how long ago). Do not open message requests unless asked. Do not send anything.';
      startUrl = `${IG}/direct/inbox/`;
      break;
    case 'read_dm':
      if (!to) return { result: 'Who? Give the username or name (to).' };
      if (!browserBridge(roomId)) return { result: OFFLINE };
      return runInstagramDmTask(roomId, to, (open) => `${open} Then report the latest messages (who said what, when). Do not send anything.`, 'research', opts);
    case 'feed':
      goal = 'On Instagram, read the home feed: summarise the newest posts (who posted, what it shows/says, likes). Do not like or comment.';
      break;
    case 'stories':
      goal = 'On Instagram, look at the stories bar on the home page: list whose stories are up. Open up to 5 and describe briefly what each shows. Do not reply or react.';
      break;
    case 'profile':
      if (!user) return { result: 'Which profile? Give the username.' };
      goal = `On Instagram, read the profile of @${user}: name, bio, followers/following, latest posts (what they show, when). Do not follow or message.`;
      startUrl = `${IG}/${encodeURIComponent(user)}/`;
      break;
    case 'send_dm':
      if (!to || !text) return { result: 'send_dm needs "to" and "text".' };
      if (!browserBridge(roomId)) return { result: OFFLINE };
      return runInstagramDmTask(roomId, to, (open) => `${open} Then send exactly this message: "${text}" and confirm it appears as sent.`, 'do', opts);
    case 'post':
    case 'reel':
      if (!path) return { result: `${a} needs "path": the photo/video file on Ray's PC.` };
      write = true;
      goal = `On Instagram, create a new ${a === 'reel' ? 'reel' : 'post'}: click "Create" (the + / New post button), choose "${a === 'reel' ? 'Reel' : 'Post'}" if asked, then upload the file ${path} (use the upload action with exactly that path when the "Select from computer" dialog is open), go Next through crop/filters, write this caption: "${caption}", then click Share and confirm it was shared.`;
      break;
    case 'comment':
      if (!url || !text) return { result: 'comment needs "url" and "text".' };
      write = true;
      goal = `On Instagram, open ${url} and post this comment: "${text}". Confirm it appears.`;
      startUrl = url;
      break;
    case 'like':
      if (!url) return { result: 'like needs "url".' };
      write = true;
      goal = `On Instagram, open ${url} and like the post (only if it isn't liked yet). Confirm.`;
      startUrl = url;
      break;
    default:
      return { result: `Unknown Instagram action "${a}".` };
  }
  if (!/^https:\/\/(www\.)?instagram\.com\//i.test(startUrl)) return { result: 'Only instagram.com links are allowed here.' };
  if (!browserBridge(roomId)) return { result: OFFLINE };
  return executeBrowserTool(
    roomId,
    'browse_web',
    { goal: goal + LOGIN_HINT, mode: write ? 'do' : 'research', startUrl, useLogin: true },
    opts
  );
}
