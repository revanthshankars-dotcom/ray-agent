/**
 * RAY in Ray's REAL browser (RAY Tabs extension 1.2): read the page he is on, click, type and
 * scroll with his logins, and search his history/bookmarks. Reading is free; clicking/typing follow
 * the command policy; passwords and pay/order buttons wait for his approval (secret typed in the
 * approval card, used once).
 */
import { Type } from '@google/genai';
import type { FunctionDeclaration } from '@google/genai';
import { createConfirmationRequest, newSecretSlot, takeSecret } from './capabilities.ts';
import { broadcastHudSound, dispatchDeviceCommand, getBrowserTabs, getRoomDevices } from './hub.ts';
import type { ConfirmationRequest, DeviceInfo } from '../src/types/relay.ts';

interface PageData {
  title?: string;
  url?: string;
  selection?: string;
  text?: string;
  elements?: Array<{ i: number; tag: string; type?: string; label: string; href?: string; inView?: boolean }>;
  scrollY?: number;
  scrollMax?: number;
}

function extensionDevice(roomId: string, target?: string): DeviceInfo | null {
  const list = getRoomDevices(roomId).filter((d) => d.online && d.capabilities?.includes('browser-tabs'));
  const q = String(target || '').toLowerCase();
  return (q && list.find((d) => d.name.toLowerCase().includes(q))) || list.find((d) => d.capabilities?.includes('page-hands')) || list[0] || null;
}

export function describePageData(p: PageData, maxText = 6000): string {
  const els = (p.elements || [])
    .slice(0, 120)
    .map((e) => `[${e.i}] ${e.tag}${e.type ? `:${e.type}` : ''} "${e.label}"${e.href && e.tag === 'a' ? ` → ${e.href.slice(0, 70)}` : ''}${e.inView === false ? ' (below)' : ''}`)
    .join('\n');
  return `URL: ${p.url}\nTitle: ${p.title}${p.selection ? `\nSelected text: ${p.selection}` : ''}\nScroll: ${p.scrollY ?? 0}/${p.scrollMax ?? 0}\n\nPage text:\n${String(p.text || '').slice(0, maxText)}\n\nElements (use i to click/type):\n${els}`;
}

export const browserTabsToolDeclarations: FunctionDeclaration[] = [
  {
    name: 'browser_page',
    description:
      'Work in Ray’s OWN browser (his logins, the tab he is looking at) through the RAY Tabs extension. action: read (page text + numbered elements; default = the tab he is on), click (i or text), type (i or text, value, submit), scroll (dy). Use for "summarise this page", "reply to this", "fill this form", "click sign in". tabId/match pick another tab (see list_browser_tabs). Passwords and pay buttons ask Ray first.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        action: { type: Type.STRING, description: 'read | click | type | scroll' },
        tabId: { type: Type.NUMBER },
        match: { type: Type.STRING, description: 'Text to find the tab by title/url.' },
        i: { type: Type.NUMBER, description: 'Element number from read.' },
        text: { type: Type.STRING, description: 'Visible text of the element when i is unknown.' },
        value: { type: Type.STRING, description: 'Text to type.' },
        submit: { type: Type.BOOLEAN },
        dy: { type: Type.NUMBER, description: 'Pixels to scroll (negative = up).' },
        targetDevice: { type: Type.STRING, description: 'Which browser, if Ray has several.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browser_history',
    description: 'Search Ray’s browser history or bookmarks ("that article I read yesterday about…", "my bookmarked recipe"). kind: history (default) | bookmarks. Read-only.',
    parameters: {
      type: Type.OBJECT,
      properties: { query: { type: Type.STRING }, kind: { type: Type.STRING }, days: { type: Type.NUMBER } },
      required: ['query'],
    },
  },
];

async function send(roomId: string, dev: DeviceInfo, payload: Record<string, unknown>) {
  const { command, summary } = await dispatchDeviceCommand({ roomId, type: 'bridge_command', targetQuery: dev.id, source: 'assistant', payload, waitForAckMs: 20000 });
  const r = command.results[0] as { status?: string; message?: string; data?: unknown } | undefined;
  return { ok: r?.status === 'completed', message: String(r?.message || summary), data: r?.data as PageData | { items?: unknown[] } | undefined };
}

export async function executeBrowserTabsTool(
  roomId: string,
  name: string,
  args: Record<string, unknown>,
  opts: { confirmed: boolean }
): Promise<{ result: string; confirmation?: ConfirmationRequest } | null> {
  if (name !== 'browser_page' && name !== 'browser_history') return null;
  const dev = extensionDevice(roomId, String(args.targetDevice || ''));
  if (!dev) return { result: 'The RAY Tabs extension is not connected. Install it from Connections → Browser extension (pairs automatically when RAY is open in that browser).' };
  if (!dev.capabilities?.includes('page-hands')) return { result: `${dev.name} runs an older RAY Tabs extension. Update it once (Connections → Browser extension → download, unzip over the old folder, Reload in chrome://extensions) to let RAY read and work in your pages.` };

  if (name === 'browser_history') {
    const out = await send(roomId, dev, { action: String(args.kind || '').toLowerCase().startsWith('book') ? 'bookmarks_search' : 'history_search', query: String(args.query || ''), days: Number(args.days || 30) });
    const items = ((out.data as { items?: Array<Record<string, unknown>> })?.items || []).map((x) => `- ${x.title || '(untitled)'} — ${x.url}${x.lastVisit ? ` (${new Date(Number(x.lastVisit)).toISOString().slice(0, 10)})` : ''}`);
    return { result: out.ok ? items.join('\n') || 'Nothing found.' : out.message };
  }

  const action = String(args.action || 'read').toLowerCase();
  let tabId = Number(args.tabId || 0) || undefined;
  const match = String(args.match || '').toLowerCase();
  if (!tabId && match) {
    const tabs = getBrowserTabs(roomId).find((b) => b.deviceId === dev.id)?.tabs || [];
    tabId = tabs.find((t) => t.title.toLowerCase().includes(match) || t.url.toLowerCase().includes(match))?.id;
    if (!tabId) return { result: `No open tab matches "${args.match}".` };
  }
  const base = { tabId, i: args.i, text: args.text, value: args.value, submit: args.submit, dy: args.dy };

  // Approved hard stops: type the secret / press the pay button, once.
  if (opts.confirmed && args.hardStop === 'secret') {
    const value = takeSecret(String(args.secretSlot || ''));
    if (!value) return { result: 'No password was entered, so I stopped.' };
    const out = await send(roomId, dev, { action: 'page_type', ...base, value, allowSecret: true });
    return { result: out.ok ? `Entered it. ${out.data ? describePageData(out.data as PageData, 2500) : ''}` : out.message };
  }
  const payload = { action: `page_${['read', 'click', 'type', 'scroll'].includes(action) ? action : 'read'}`, ...base, allowPay: opts.confirmed && args.hardStop === 'pay' };
  const out = await send(roomId, dev, payload);
  if (!out.ok && /^PASSWORD_FIELD/.test(out.message)) {
    const slot = newSecretSlot();
    const req = createConfirmationRequest({
      roomId,
      toolName: name,
      safetyLevel: 'sensitive',
      summary: `Type your password into this page in ${dev.name}. It is used once and never saved or shown to the AI.`,
      targetDevice: dev.name,
      args: { ...args, action: 'type', hardStop: 'secret', secretSlot: slot },
      secretPrompt: 'Your password for this site',
    });
    broadcastHudSound(roomId, 'alert');
    return { result: `REQUIRES_CONFIRMATION: needs Ray's password (confirmationId=${req.id}).`, confirmation: req };
  }
  if (!out.ok && /^NEEDS_APPROVAL_PAY/.test(out.message)) {
    const label = out.message.replace(/^NEEDS_APPROVAL_PAY:\s*/, '');
    const req = createConfirmationRequest({
      roomId,
      toolName: name,
      safetyLevel: 'sensitive',
      summary: `Press “${label}” in ${dev.name}.`,
      targetDevice: dev.name,
      args: { ...args, action: 'click', hardStop: 'pay' },
    });
    broadcastHudSound(roomId, 'alert');
    return { result: `REQUIRES_CONFIRMATION: “${label}” pays or places an order — waiting for Ray (confirmationId=${req.id}).`, confirmation: req };
  }
  if (!out.ok) return { result: out.message };
  return { result: `${out.message}\n\n${out.data ? describePageData(out.data as PageData) : ''}`.trim() };
}

/** Awareness: the page Ray is looking at in each browser (title + site). */
export function activeBrowserPages(roomId: string): Array<{ device: string; title: string; url: string }> {
  return getBrowserTabs(roomId)
    .map((b) => {
      const t = [...b.tabs].filter((x) => x.active).sort((x, y) => (y.lastAccessed || 0) - (x.lastAccessed || 0))[0];
      return t ? { device: b.deviceName, title: t.title, url: t.url } : null;
    })
    .filter((x): x is { device: string; title: string; url: string } => Boolean(x));
}
