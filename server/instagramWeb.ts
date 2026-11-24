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
      goal = `On Instagram, open the direct message conversation with "${to}" and report the latest messages (who said what, when). Do not send anything.`;
      startUrl = `${IG}/direct/inbox/`;
      break;
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
      write = true;
      goal = `On Instagram, open the direct message conversation with "${to}" (search it in the inbox or with the new-message button) and send exactly this message: "${text}". Then confirm it appears as sent.`;
      startUrl = `${IG}/direct/inbox/`;
      break;
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
  if (!browserBridge(roomId)) return { result: 'Instagram runs in RAY’s browser on Ray’s PC, and the PC bridge is offline. Turn the PC on (RAY starts with it), or use the phone: read_incoming_messages shows Instagram DMs from phone notifications.' };
  return executeBrowserTool(
    roomId,
    'browse_web',
    { goal: goal + LOGIN_HINT, mode: write ? 'do' : 'research', startUrl, useLogin: true },
    opts
  );
}
