/**
 * WATCH VIDEO — RAY watches a video (picture + sound) and answers with timestamps.
 * Inspired by Orbit's "Let Claude watch any video" skill. YouTube links go straight to Gemini's
 * video understanding; other pages fall back to reading the page text / transcript.
 */
import { GoogleGenAI, Type } from '@google/genai';
import type { FunctionDeclaration } from '@google/genai';
import { readUrl } from './browserAgent.ts';

const YT = /^https:\/\/(www\.|m\.)?(youtube\.com\/(watch\?v=|shorts\/|live\/)|youtu\.be\/)[\w-]{6,}/i;
const MODEL = process.env.RAY_VIDEO_MODEL || 'gemini-4-hydrogen';

export const videoToolDeclarations: FunctionDeclaration[] = [
  {
    name: 'watch_video',
    description:
      'Watch a video and answer about it with timestamps: summaries, steps shown, what is said, key moments, how-to notes. YouTube links are watched fully (picture and sound); other links fall back to the page text/transcript. Use for "watch this", "summarise this video", "what does he do at 3:20", or to learn a course video into Knowledge.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        url: { type: Type.STRING, description: 'Video link (YouTube works best).' },
        question: { type: Type.STRING, description: 'What to find out. Default: timestamped summary + key steps.' },
      },
      required: ['url'],
    },
  },
];

export async function executeVideoTool(roomId: string, name: string, args: Record<string, unknown>): Promise<{ result: string } | null> {
  if (name !== 'watch_video') return null;
  const url = String(args.url || '').trim();
  const question = String(args.question || '').trim() || 'Give a timestamped summary, the key steps or ideas shown, and any tools, links or prompts mentioned.';
  if (!/^https:\/\//i.test(url)) return { result: 'Give me an https:// video link.' };
  if (YT.test(url)) {
    try {
      if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY missing');
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const r = await ai.models.generateContent({
        model: MODEL,
        contents: [{ role: 'user', parts: [{ fileData: { fileUri: url, mimeType: 'video/*' } }, { text: `${question}\nUse [mm:ss] timestamps. Be concrete and concise.` }] }],
      });
      const text = (r.text || '').trim();
      if (text) return { result: text.slice(0, 12000) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/GEMINI_API_KEY/.test(msg)) return { result: 'Watching videos needs GEMINI_API_KEY in Render (free at aistudio.google.com).' };
      return { result: `Could not watch it: ${msg.slice(0, 200)}` };
    }
  }
  const page = await readUrl(roomId, url).catch(() => '');
  if (!page) return { result: 'That video host could not be read. YouTube links work fully; for Instagram/Wistia/Loom paste a YouTube copy or the transcript.' };
  return { result: `Could not watch the video itself on this host — here is the page text/transcript instead:\n${page.slice(0, 8000)}` };
}
