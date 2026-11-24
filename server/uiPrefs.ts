/**
 * Small per-room display preferences shared by every device, e.g. keep RAY's PC pop-ups pinned
 * above other windows ("display over other apps" on PCs).
 */
import type { Express } from 'express';
import { broadcastRoomEvent, normalizeRoomId } from './hub.ts';

const NOTCH_KEYS: Record<string, (v: unknown) => boolean> = {
  style: (v) => ['eyes', 'ring', 'bars'].includes(String(v)),
  color: (v) => ['cyan', 'white', 'blue', 'green', 'yellow', 'orange', 'pink', 'purple'].includes(String(v)),
  wakeEnabled: (v) => typeof v === 'boolean',
  wakePhrases: (v) => Array.isArray(v) && v.length <= 5 && v.every((x) => typeof x === 'string' && x.length <= 40),
  stt: (v) => ['stt-fast', 'stt-accurate', 'stt-multilingual'].includes(String(v)),
  voice: (v) => ['voice-alan', 'voice-jenny', 'voice-amy'].includes(String(v)),
  speakAnswers: (v) => typeof v === 'boolean',
  hotkeyCommand: (v) => ['RightCtrl', 'RightAlt', 'RightShift', 'F8', 'F9'].includes(String(v)),
  hotkeyDictate: (v) => ['RightCtrl', 'RightAlt', 'RightShift', 'F8', 'F9'].includes(String(v)),
  apps: (v) => Array.isArray(v) && v.length <= 8 && v.every((x) => typeof x === 'string' && x.length <= 40),
  waterEveryMin: (v) => [0, 45, 60, 90].includes(Number(v)),
  focusMin: (v) => [15, 25, 45, 50].includes(Number(v)),
  breakMin: (v) => [5, 10, 15].includes(Number(v)),
  startWithPc: (v) => typeof v === 'boolean',
};
/** Keep only known notch settings with valid values. */
function sanitizeNotch(n: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(n).filter(([k, v]) => NOTCH_KEYS[k]?.(v)));
}
import { loadJson, scheduleSave } from './persistence.ts';

export interface UiPrefs {
  pinPopups: boolean;
  /** Browser RAY opens links in when Ray doesn't name one: '' = the system default. */
  defaultBrowser: string;
  /** RAY Notch look, wake phrase, voice… (shared by the notch app and RAY's settings page). */
  notch?: Record<string, unknown>;
}
const BROWSERS = ['', 'chrome', 'brave', 'edge', 'firefox', 'opera', 'vivaldi'];
const prefs = new Map<string, UiPrefs>();

export async function getUiPrefs(roomId: string): Promise<UiPrefs> {
  if (!prefs.has(roomId)) {
    const s = (await loadJson<Record<string, unknown>>(`ui-prefs-${roomId}`).catch(() => null)) as Partial<UiPrefs> | null;
    prefs.set(roomId, {
      pinPopups: Boolean(s?.pinPopups),
      defaultBrowser: BROWSERS.includes(String(s?.defaultBrowser || '')) ? String(s?.defaultBrowser || '') : '',
      notch: s?.notch && typeof s.notch === 'object' ? (s.notch as Record<string, unknown>) : undefined,
    });
  }
  return prefs.get(roomId)!;
}

export function registerUiPrefRoutes(app: Express, requireRoomAuth: Parameters<Express['get']>[1]) {
  app.get('/api/ui-prefs', requireRoomAuth, async (req, res) => {
    res.json(await getUiPrefs(normalizeRoomId(String(req.query.room || 'RLY-HOME'))));
  });
  app.post('/api/ui-prefs', requireRoomAuth, async (req, res) => {
    const b = req.body as { roomId?: string; pinPopups?: boolean; defaultBrowser?: string; notch?: Record<string, unknown> };
    const roomId = normalizeRoomId(String(b.roomId || ''));
    const p = await getUiPrefs(roomId);
    if (typeof b.pinPopups === 'boolean') p.pinPopups = b.pinPopups;
    if (typeof b.defaultBrowser === 'string' && BROWSERS.includes(b.defaultBrowser)) p.defaultBrowser = b.defaultBrowser;
    if (b.notch && typeof b.notch === 'object') p.notch = sanitizeNotch({ ...(p.notch || {}), ...b.notch });
    // The notch app (and other open RAY windows) pick the change up live.
    broadcastRoomEvent(roomId, 'ui-prefs:updated', { ...p });
    scheduleSave(`ui-prefs-${roomId}`, () => ({ ...p }), 200);
    res.json(p);
  });
}
