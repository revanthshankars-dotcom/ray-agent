/**
 * Small per-room display preferences shared by every device, e.g. keep RAY's PC pop-ups pinned
 * above other windows ("display over other apps" on PCs).
 */
import type { Express } from 'express';
import { normalizeRoomId } from './hub.ts';
import { loadJson, scheduleSave } from './persistence.ts';

export interface UiPrefs {
  pinPopups: boolean;
  /** Browser RAY opens links in when Ray doesn't name one: '' = the system default. */
  defaultBrowser: string;
}
const BROWSERS = ['', 'chrome', 'brave', 'edge', 'firefox', 'opera', 'vivaldi'];
const prefs = new Map<string, UiPrefs>();

export async function getUiPrefs(roomId: string): Promise<UiPrefs> {
  if (!prefs.has(roomId)) {
    const s = (await loadJson<Record<string, unknown>>(`ui-prefs-${roomId}`).catch(() => null)) as Partial<UiPrefs> | null;
    prefs.set(roomId, { pinPopups: Boolean(s?.pinPopups), defaultBrowser: BROWSERS.includes(String(s?.defaultBrowser || '')) ? String(s?.defaultBrowser || '') : '' });
  }
  return prefs.get(roomId)!;
}

export function registerUiPrefRoutes(app: Express, requireRoomAuth: Parameters<Express['get']>[1]) {
  app.get('/api/ui-prefs', requireRoomAuth, async (req, res) => {
    res.json(await getUiPrefs(normalizeRoomId(String(req.query.room || 'RLY-HOME'))));
  });
  app.post('/api/ui-prefs', requireRoomAuth, async (req, res) => {
    const b = req.body as { roomId?: string; pinPopups?: boolean; defaultBrowser?: string };
    const roomId = normalizeRoomId(String(b.roomId || ''));
    const p = await getUiPrefs(roomId);
    if (typeof b.pinPopups === 'boolean') p.pinPopups = b.pinPopups;
    if (typeof b.defaultBrowser === 'string' && BROWSERS.includes(b.defaultBrowser)) p.defaultBrowser = b.defaultBrowser;
    scheduleSave(`ui-prefs-${roomId}`, () => ({ ...p }), 200);
    res.json(p);
  });
}
