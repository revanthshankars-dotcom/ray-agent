/**
 * AWARENESS (opt-in, off by default) — RAY knows what Ray is doing right now: the active app/window
 * on each online PC (already reported by the bridge) and the last couple of hours of apps, so
 * "summarise this", "fix this error", "what was I working on?" just work. Window history is kept in
 * memory only (never saved) and is cleared when awareness is turned off.
 */
import type { Express } from 'express';
import { Type } from '@google/genai';
import type { FunctionDeclaration } from '@google/genai';
import { getRoomDevices, listRoomIds, normalizeRoomId } from './hub.ts';
import { activeBrowserPages } from './browserTabsAgent.ts';
import { loadJson, scheduleSave } from './persistence.ts';

const enabled = new Map<string, boolean>();
const history = new Map<string, Array<{ at: number; device: string; title: string }>>();

export async function isAware(roomId: string): Promise<boolean> {
  if (!enabled.has(roomId)) enabled.set(roomId, Boolean((await loadJson<{ on?: boolean }>(`awareness-${roomId}`))?.on));
  return enabled.get(roomId)!;
}
export async function setAware(roomId: string, on: boolean) {
  enabled.set(roomId, on);
  if (!on) history.delete(roomId);
  scheduleSave(`awareness-${roomId}`, () => ({ on }), 200);
}

function sample(roomId: string) {
  const list = history.get(roomId) || [];
  for (const d of getRoomDevices(roomId)) {
    const title = String((d.telemetry as { activeWindow?: string } | undefined)?.activeWindow || '').trim();
    if (!d.online || !title || /^desktop \/ unknown$/i.test(title)) continue;
    const last = [...list].reverse().find((x) => x.device === d.name);
    if (!last || last.title !== title) list.push({ at: Date.now(), device: d.name, title: title.slice(0, 140) });
  }
  for (const pg of activeBrowserPages(roomId)) {
    const title = `${pg.title || 'page'} — ${(() => {
      try {
        return new URL(pg.url).hostname.replace(/^www\./, '');
      } catch {
        return pg.url.slice(0, 40);
      }
    })()}`.slice(0, 140);
    const dev = `${pg.device} (browser)`;
    const last = [...list].reverse().find((x) => x.device === dev);
    if (!last || last.title !== title) list.push({ at: Date.now(), device: dev, title });
  }
  const cutoff = Date.now() - 2 * 3600_000;
  history.set(roomId, list.filter((x) => x.at >= cutoff).slice(-80));
}

let started = false;
export function startAwareness() {
  if (started) return;
  started = true;
  setInterval(async () => {
    for (const roomId of listRoomIds()) if (await isAware(roomId).catch(() => false)) sample(roomId);
  }, 60_000).unref();
}

/** Prompt lines (empty when awareness is off). Sync: uses the cached setting. */
export function awarenessExcerpt(roomId: string): string {
  if (!enabled.get(roomId)) {
    if (!enabled.has(roomId)) void isAware(roomId);
    return '';
  }
  sample(roomId);
  const now = getRoomDevices(roomId)
    .filter((d) => d.online && (d.telemetry as { activeWindow?: string } | undefined)?.activeWindow)
    .map((d) => `- ${d.name}: ${String((d.telemetry as { activeWindow?: string }).activeWindow).slice(0, 140)}`);
  const recent = (history.get(roomId) || [])
    .slice(-8)
    .reverse()
    .map((x) => `- ${Math.max(0, Math.round((Date.now() - x.at) / 60000))} min ago · ${x.device}: ${x.title}`);
  for (const pg of activeBrowserPages(roomId)) now.push(`- ${pg.device} (browser tab): ${pg.title} — ${pg.url.slice(0, 120)}`);
  if (!now.length && !recent.length) return '';
  return `AWARENESS (Ray turned this on): what Ray is doing right now — use it for "this", "here", "what I'm working on"; never read titles out unless asked.\nNow:\n${now.join('\n') || '- (no PC online)'}\nRecent windows:\n${recent.join('\n') || '- (none yet)'}`;
}

export function registerAwarenessRoutes(app: Express, requireRoomAuth: Parameters<Express['get']>[1]) {
  app.get('/api/awareness', requireRoomAuth, async (req, res) => {
    res.json({ on: await isAware(normalizeRoomId(String(req.query.room || 'RLY-HOME'))) });
  });
  app.post('/api/awareness', requireRoomAuth, async (req, res) => {
    const b = req.body as { roomId?: string; on?: boolean };
    const roomId = normalizeRoomId(String(b.roomId || ''));
    await setAware(roomId, Boolean(b.on));
    res.json({ on: Boolean(b.on) });
  });
}

export const awarenessToolDeclarations: FunctionDeclaration[] = [
  {
    name: 'awareness',
    description:
      'Turn RAY’s awareness of Ray’s current app/window on or off, or check it. When on, RAY knows what he is working on (window titles, kept in memory only). action: "on" | "off" | "status".',
    parameters: { type: Type.OBJECT, properties: { action: { type: Type.STRING } }, required: ['action'] },
  },
];

export async function executeAwarenessTool(roomId: string, name: string, args: Record<string, unknown>): Promise<{ result: string } | null> {
  if (name !== 'awareness') return null;
  const a = String(args.action || 'status').toLowerCase();
  if (a === 'on' || a === 'off') {
    await setAware(roomId, a === 'on');
    return { result: a === 'on' ? 'Awareness on — I can see which app and window you are in (not saved anywhere).' : 'Awareness off — window history cleared.' };
  }
  return { result: (await isAware(roomId)) ? 'Awareness is on.' : 'Awareness is off.' };
}
