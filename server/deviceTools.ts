/**
 * Extended device tools + RAY's access policy.
 *
 * POLICY (what Ray asked for):
 *  - READ on its own: RAY may list/read/search files, apps, tabs, screens and incoming
 *    messages on every connected device whenever that helps — and it tells Ray it did so.
 *  - ACT/WRITE only on command: writing files, sending messages, closing apps/tabs, typing,
 *    clicking, changing volume… only run when Ray's own current command asks for that kind
 *    of action. Destructive ones additionally need a tap on "Approve".
 */
import { Type } from '@google/genai';
import type { FunctionDeclaration } from '@google/genai';
import { createConfirmationRequest } from './capabilities.ts';
import {
  broadcastHudSound,
  dispatchBridgeProxyCall,
  dispatchDeviceCommand,
  getBrowserTabs,
  getIncomingMessages,
  getRoomDevices,
  markMessagesRead,
  pickExecutorDevice,
} from './hub.ts';
import { buildComposeLink, metaStatus, sendInstagramDm, sendWhatsAppCloud } from './meta.ts';
import type { ConfirmationRequest, DeviceInfo } from '../src/types/relay.ts';

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/** Tools that change something. Value = verbs that must appear in Ray's command. */
const ACTION_TOOLS: Record<string, RegExp> = {
  write_system_file: /\b(write|save|create|make|edit|update|append|modify|overwrite|put|store)\b/i,
  send_chat_message: /\b(send|message|msg|reply|text|tell|dm|whatsapp|ping|inform)\b/i,
  close_application: /\b(close|quit|exit|kill|stop|shut)\b/i,
  kill_process: /\b(kill|end|terminate|stop|close)\b/i,
  control_screen_input: /\b(click|type|press|scroll|move|tap|select|enter|hit|focus|switch)\b/i,
  adjust_volume: /\b(volume|mute|unmute|louder|quieter|sound)\b/i,
  optimize_system: /\b(optimi[sz]e|clean|speed up|free up)\b/i,
  browser_tab_action: /\b(close|open|switch|go to|focus|reload|refresh|mute|show|read|bring)\b/i,
  execute_protocol: /\b(protocol|run|activate|engage|initiate|start)\b/i,
};

/** Read-type actions inside an action tool that are always allowed. */
function isReadOnlyVariant(name: string, args: Record<string, unknown>): boolean {
  return name === 'browser_tab_action' && String(args.action || '').toLowerCase() === 'read';
}

export function checkActionPolicy(
  name: string,
  args: Record<string, unknown>,
  userCommand: string | undefined,
  confirmed: boolean
): string | null {
  const verbs = ACTION_TOOLS[name];
  if (!verbs || confirmed || isReadOnlyVariant(name, args)) return null;
  // No user command available (e.g. routine runner / approved confirmation) -> allowed.
  if (userCommand === undefined) return null;
  // Questions ("did mom message me?", "which apps are open?") never authorize actions,
  // unless they're polite imperatives ("can you send mom a message?").
  const cmd = userCommand.trim();
  const isQuestion =
    /\?\s*$/.test(cmd) || /^(did|does|do|is|are|was|were|has|have|what|which|who|whom|whose|when|where|why|how|any)\b/i.test(cmd);
  const politeImperative = /^(can|could|would|will)\s+you\b|^please\b/i.test(cmd);
  if (isQuestion && !politeImperative) {
    return `BLOCKED_BY_POLICY: Ray asked a question, so RAY only reads. "${name}" would change something — answer him and offer to do it.`;
  }
  if (verbs.test(cmd)) return null;
  return `BLOCKED_BY_POLICY: "${name}" changes something on Ray's devices, and RAY only reads on its own. Ray did not ask for this action in his command, so it was not executed. Tell Ray what you found and offer to do it if he says so.`;
}

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

export const extendedToolDeclarations: FunctionDeclaration[] = [
  {
    name: 'search_and_open',
    description:
      'Search the web / a site and OPEN the result in a real browser tab or app on Ray’s device (PC, phone). Use whenever Ray says "open/play/search/show/pull up X". Prefer this over returning links. Set openTopResult=true to open the best result directly (e.g. play the top YouTube video).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: 'What to search for.' },
        site: {
          type: Type.STRING,
          description: 'google | youtube | youtube_music | spotify | maps | amazon | flipkart | wikipedia | github | reddit | x | instagram | linkedin | news | images | web',
        },
        openTopResult: { type: Type.BOOLEAN, description: 'Open the first result directly instead of the results page.' },
        targetDevice: { type: Type.STRING, description: 'Device name/type (pc, phone, laptop, chrome) or "auto".' },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_search',
    description: 'Search the web and return the top results (title, url, snippet) WITHOUT opening anything. Read-only research.',
    parameters: {
      type: Type.OBJECT,
      properties: { query: { type: Type.STRING, description: 'Search query.' } },
      required: ['query'],
    },
  },
  {
    name: 'list_installed_apps',
    description: 'List the apps installed on a connected PC or Android phone (read-only). Use to find the exact app name before opening it.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        targetDevice: { type: Type.STRING, description: 'Device name/type, e.g. "pc" or "phone".' },
        filter: { type: Type.STRING, description: 'Optional text filter.' },
      },
    },
  },
  {
    name: 'list_browser_tabs',
    description: 'List the open browser tabs on Ray’s computers (via the RAY Tabs browser extension). Read-only.',
    parameters: {
      type: Type.OBJECT,
      properties: { filter: { type: Type.STRING, description: 'Optional text filter on title/url.' } },
    },
  },
  {
    name: 'browser_tab_action',
    description:
      'Control browser tabs through the RAY Tabs extension: open (new tab with url), focus (switch to a tab), close, reload, mute, read (get the visible text of a tab).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        action: { type: Type.STRING, description: 'open | focus | close | reload | mute | read' },
        tabId: { type: Type.NUMBER, description: 'Tab id from list_browser_tabs.' },
        match: { type: Type.STRING, description: 'Text to match against tab title/url if tabId is unknown.' },
        url: { type: Type.STRING, description: 'URL for action=open.' },
        targetDevice: { type: Type.STRING, description: 'Which browser/computer.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'read_incoming_messages',
    description: 'Read recent incoming WhatsApp / Instagram / Messenger / SMS / Telegram messages relayed from Ray’s phone or the Meta APIs. Read-only.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        app: { type: Type.STRING, description: 'Optional: whatsapp | instagram | messenger | sms | telegram' },
        unreadOnly: { type: Type.BOOLEAN, description: 'Only unread messages.' },
        limit: { type: Type.NUMBER, description: 'Max messages (default 15).' },
      },
    },
  },
  {
    name: 'send_chat_message',
    description:
      'Send (or prepare) a WhatsApp / Instagram / Messenger / Telegram / SMS message on Ray’s behalf. ONLY when Ray explicitly commands it. Uses the official API if configured, otherwise opens the chat with the text pre-filled on his phone/PC.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        app: { type: Type.STRING, description: 'whatsapp | instagram | messenger | telegram | sms' },
        to: { type: Type.STRING, description: 'Phone number with country code, or username/contact name.' },
        text: { type: Type.STRING, description: 'Message text.' },
        targetDevice: { type: Type.STRING, description: 'Device to compose on (default: phone, else PC).' },
      },
      required: ['app', 'text'],
    },
  },
  {
    name: 'wake_device',
    description: 'Wake an offline/sleeping device (web push to the RAY app, Wake-on-LAN for PCs) so it reconnects.',
    parameters: {
      type: Type.OBJECT,
      properties: { targetDevice: { type: Type.STRING, description: 'Device name or type.' } },
      required: ['targetDevice'],
    },
  },
];

export const EXTENDED_TOOL_NAMES = new Set(extendedToolDeclarations.map((d) => d.name || ''));

// ---------------------------------------------------------------------------
// Search helpers (no API key needed)
// ---------------------------------------------------------------------------

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

export async function webSearch(query: string, max = 6): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const r = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { 'User-Agent': UA, Accept: 'text/html' },
    signal: AbortSignal.timeout(9000),
  });
  const html = await r.text();
  const out: Array<{ title: string; url: string; snippet: string }> = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < max) {
    let url = m[1].replace(/&amp;/g, '&');
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    if (url.startsWith('//')) url = 'https:' + url;
    if (!/^https?:\/\//.test(url) || /duckduckgo\.com\/y\.js/.test(url)) continue;
    const strip = (t?: string) => (t || '').replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();
    out.push({ title: strip(m[2]), url, snippet: strip(m[3]).slice(0, 240) });
  }
  return out;
}

async function topYouTubeVideo(query: string): Promise<string | null> {
  try {
    const r = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=en`, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(9000),
    });
    const html = await r.text();
    const m = html.match(/"videoRenderer":\{"videoId":"([\w-]{11})"/) || html.match(/"videoId":"([\w-]{11})"/);
    return m ? `https://www.youtube.com/watch?v=${m[1]}` : null;
  } catch {
    return null;
  }
}

function siteSearchUrl(site: string, q: string, android: boolean): string {
  const e = encodeURIComponent(q);
  switch (site) {
    case 'youtube':
      return `https://www.youtube.com/results?search_query=${e}`;
    case 'youtube_music':
      return `https://music.youtube.com/search?q=${e}`;
    case 'spotify':
      return android ? `spotify:search:${e}` : `https://open.spotify.com/search/${e}`;
    case 'maps':
      return `https://www.google.com/maps/search/${e}`;
    case 'amazon':
      return `https://www.amazon.in/s?k=${e}`;
    case 'flipkart':
      return `https://www.flipkart.com/search?q=${e}`;
    case 'wikipedia':
      return `https://en.wikipedia.org/w/index.php?search=${e}`;
    case 'github':
      return `https://github.com/search?q=${e}`;
    case 'reddit':
      return `https://www.reddit.com/search/?q=${e}`;
    case 'x':
      return `https://x.com/search?q=${e}`;
    case 'instagram':
      return `https://www.instagram.com/explore/search/keyword/?q=${e}`;
    case 'linkedin':
      return `https://www.linkedin.com/search/results/all/?keywords=${e}`;
    case 'news':
      return `https://news.google.com/search?q=${e}`;
    case 'images':
      return `https://www.google.com/search?tbm=isch&q=${e}`;
    default:
      return `https://www.google.com/search?q=${e}`;
  }
}

function isAndroid(d: DeviceInfo | null): boolean {
  return Boolean(d && /android/i.test(d.os));
}

/** Open a URL for real on the best device that can execute it. */
export async function openUrlOnBestDevice(
  roomId: string,
  url: string,
  title: string,
  targetQuery: string
): Promise<{ summary: string; device?: string }> {
  const exec = pickExecutorDevice(roomId, targetQuery, 'url');
  const { summary } = await dispatchDeviceCommand({
    roomId,
    type: 'open_url',
    // Executor (bridge / tabs extension) opens a real tab; otherwise RAY browser clients try window.open.
    targetQuery: exec ? exec.id : targetQuery || 'all',
    source: 'assistant',
    payload: { url, title },
    waitForAckMs: 6000,
  });
  return { summary, device: exec?.name };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export async function executeExtendedTool(
  roomId: string,
  name: string,
  args: Record<string, unknown>,
  opts: { confirmed: boolean }
): Promise<{ result: string; confirmation?: ConfirmationRequest } | null> {
  switch (name) {
    case 'open_url_on_device': {
      const url = String(args.url || '');
      if (!/^(https?|whatsapp|spotify|tg|mailto|tel|sms|instagram):/i.test(url)) return { result: `Refused to open unsupported URL: ${url}` };
      const out = await openUrlOnBestDevice(roomId, url, String(args.title || url), String(args.targetDevice || 'auto'));
      return { result: `${out.summary}${out.device ? ` (executed by ${out.device})` : ''}` };
    }

    case 'search_and_open': {
      const query = String(args.query || '').trim();
      if (!query) return { result: 'No search query given.' };
      const site = String(args.site || 'google').toLowerCase();
      const target = String(args.targetDevice || 'auto');
      const exec = pickExecutorDevice(roomId, target, 'url');
      const android = isAndroid(exec);
      let url = siteSearchUrl(site, query, android);
      let label = `${site} search: ${query}`;
      if (args.openTopResult) {
        if (site === 'youtube' || site === 'youtube_music') {
          const v = await topYouTubeVideo(query);
          if (v) {
            url = site === 'youtube_music' ? v.replace('www.youtube.com', 'music.youtube.com') : v;
            label = `Top YouTube result for "${query}"`;
          }
        } else if (!['spotify', 'maps', 'amazon', 'flipkart'].includes(site)) {
          const hits = await webSearch(site === 'google' || site === 'web' ? query : `${query} site:${site}.com`, 3).catch(() => []);
          if (hits[0]) {
            url = hits[0].url;
            label = hits[0].title || label;
          }
        }
      }
      const out = await openUrlOnBestDevice(roomId, url, label, target);
      return { result: `Opened ${label} → ${url}. ${out.summary}` };
    }

    case 'web_search': {
      const hits = await webSearch(String(args.query || ''), 6).catch((e) => {
        throw new Error(`Web search failed: ${e instanceof Error ? e.message : e}`);
      });
      return { result: hits.length ? JSON.stringify(hits) : 'No results.' };
    }

    case 'open_application': {
      const appName = String(args.app_name || args.target || '').trim();
      const exec = pickExecutorDevice(roomId, String(args.targetDevice || 'auto'), 'app');
      if (!exec) {
        return {
          result: `No device that can launch apps is online. Ray needs the RAY bridge running on his PC (or Termux bridge on Android). Online devices: ${
            getRoomDevices(roomId).filter((d) => d.online).map((d) => d.name).join(', ') || 'none'
          }.`,
        };
      }
      const out = await dispatchBridgeProxyCall(roomId, { action: 'open_app', target: appName }, 15000, exec.id);
      return { result: out.ok ? `${(out.data as { message?: string })?.message || `Launched ${appName}`} on ${out.deviceName}.` : `Could not open ${appName} on ${exec.name}: ${out.error}` };
    }

    case 'list_installed_apps': {
      const exec = pickExecutorDevice(roomId, String(args.targetDevice || 'auto'), 'app');
      if (!exec) return { result: 'No PC/phone bridge online to list apps from.' };
      const out = await dispatchBridgeProxyCall(roomId, { action: 'list_apps', filter: args.filter || '' }, 20000, exec.id);
      if (!out.ok) return { result: `Could not list apps: ${out.error}` };
      const data = out.data as { total?: number; apps?: Array<{ name: string }> };
      return { result: `${out.deviceName} has ${data.total} apps. ${(data.apps || []).map((a) => a.name).slice(0, 150).join(', ')}` };
    }

    case 'list_browser_tabs': {
      const f = String(args.filter || '').toLowerCase();
      const all = getBrowserTabs(roomId);
      if (all.length === 0) {
        return { result: 'No browser is sharing tabs yet. Ray can install the RAY Tabs extension (Devices → Browser extension) for full tab control.' };
      }
      return {
        result: JSON.stringify(
          all.map((b) => ({
            browser: b.deviceName,
            tabs: b.tabs.filter((t) => !f || t.title.toLowerCase().includes(f) || t.url.toLowerCase().includes(f)).map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active })),
          }))
        ).slice(0, 12000),
      };
    }

    case 'browser_tab_action': {
      const action = String(args.action || '').toLowerCase();
      const browsers = getBrowserTabs(roomId);
      const targetQ = String(args.targetDevice || '').toLowerCase();
      let browser = browsers.find((b) => targetQ && b.deviceName.toLowerCase().includes(targetQ)) || browsers[0];
      let tabId = Number(args.tabId || 0) || undefined;
      const match = String(args.match || '').toLowerCase();
      if (!tabId && match) {
        for (const b of browsers) {
          const t = b.tabs.find((x) => x.title.toLowerCase().includes(match) || x.url.toLowerCase().includes(match));
          if (t) {
            tabId = t.id;
            browser = b;
            break;
          }
        }
      }
      if (action === 'open' && !browser) {
        const out = await openUrlOnBestDevice(roomId, String(args.url || ''), String(args.url || ''), String(args.targetDevice || 'auto'));
        return { result: out.summary };
      }
      if (!browser) return { result: 'RAY Tabs extension is not connected on any browser.' };
      if (action !== 'open' && !tabId) return { result: `No tab matched "${match}".` };
      const { command, summary } = await dispatchDeviceCommand({
        roomId,
        type: 'bridge_command',
        targetQuery: browser.deviceId,
        source: 'assistant',
        payload: { action: `tab_${action}`, tabId, url: args.url },
        waitForAckMs: 8000,
      });
      const data = command.results[0]?.data as { text?: string } | undefined;
      return { result: action === 'read' && data?.text ? `Tab text:\n${data.text.slice(0, 10000)}` : summary };
    }

    case 'read_incoming_messages': {
      const msgs = getIncomingMessages(roomId, {
        app: args.app ? String(args.app) : undefined,
        unreadOnly: Boolean(args.unreadOnly),
        limit: Number(args.limit || 15),
      });
      markMessagesRead(roomId, msgs.map((m) => m.id));
      if (msgs.length === 0) {
        const st = metaStatus();
        return {
          result: `No ${args.app || ''} messages received yet. Sources: Android notification relay (Termux bridge) ${
            getRoomDevices(roomId).some((d) => d.capabilities?.includes('notifications-relay') && d.online) ? 'ONLINE' : 'offline'
          }, WhatsApp Cloud API ${st.whatsappCloud ? 'configured' : 'not configured'}, Instagram API ${st.instagramApi ? 'configured' : 'not configured'}.`,
        };
      }
      return {
        result: JSON.stringify(msgs.map((m) => ({ app: m.app, from: m.from, text: m.text, at: new Date(m.receivedAt).toISOString() }))),
      };
    }

    case 'send_chat_message': {
      const app = String(args.app || 'whatsapp').toLowerCase();
      const to = String(args.to || '').trim();
      const text = String(args.text || '').trim();
      if (!text) return { result: 'Message text is empty.' };
      // Ray can opt out of the extra tap with RAY_AUTO_SEND_MESSAGES=true (his command is still required by policy).
      const autoSend = /^(1|true|yes)$/i.test(process.env.RAY_AUTO_SEND_MESSAGES || '');
      if (!opts.confirmed && !autoSend) {
        const req = createConfirmationRequest({
          roomId,
          toolName: 'send_chat_message',
          safetyLevel: 'sensitive',
          summary: `Send ${app} message to ${to || '(pick contact)'}: "${text.slice(0, 160)}"`,
          targetDevice: String(args.targetDevice || 'phone'),
          args,
        });
        broadcastHudSound(roomId, 'alert');
        return {
          result: `REQUIRES_CONFIRMATION: Ready to send the ${app} message to ${to || 'a contact'}. Waiting for Ray to tap Approve (confirmationId=${req.id}).`,
          confirmation: req,
        };
      }
      const st = metaStatus();
      try {
        if (app === 'whatsapp' && st.whatsappCloud && /\d{8,}/.test(to.replace(/\D/g, ''))) return { result: await sendWhatsAppCloud(to, text) };
        if (app === 'instagram' && st.instagramApi && to) return { result: await sendInstagramDm(to, text) };
      } catch (err) {
        // fall back to compose on device
        const msg = err instanceof Error ? err.message : String(err);
        if (!/not configured/i.test(msg)) {
          // continue to compose fallback, but report the API reason
          args.__apiError = msg;
        }
      }
      const exec =
        pickExecutorDevice(roomId, String(args.targetDevice || 'phone'), 'url') || pickExecutorDevice(roomId, 'auto', 'url');
      const link = buildComposeLink(app, to, text, isAndroid(exec) ? 'android' : 'desktop');
      if (!link) return { result: `Unsupported chat app: ${app}` };
      if (exec && app === 'instagram') {
        // Instagram links can't carry text — put it on the clipboard first.
        await dispatchDeviceCommand({ roomId, type: 'clipboard', targetQuery: exec.id, source: 'assistant', payload: { content: text, label: 'Message for Instagram' }, waitForAckMs: 3000 });
      }
      const out = await openUrlOnBestDevice(roomId, link, `${app} chat with ${to || 'contact'}`, exec?.id || 'auto');
      return {
        result: `${args.__apiError ? `API send failed (${String(args.__apiError)}); ` : ''}Opened ${app} on ${out.device || 'Ray’s device'} with the message ${
          app === 'instagram' ? 'copied to the clipboard (paste + send)' : 'pre-filled'
        } — Ray just taps Send. ${out.summary}`,
      };
    }

    case 'wake_device': {
      const target = String(args.targetDevice || '');
      const { summary } = await dispatchDeviceCommand({ roomId, type: 'wake', targetQuery: target, source: 'assistant', payload: {}, waitForAckMs: 3000 });
      return { result: summary };
    }

    default:
      return null;
  }
}
