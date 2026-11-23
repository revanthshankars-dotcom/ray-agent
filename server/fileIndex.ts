/**
 * FILE MAP CLAUSE
 * ---------------
 * RAY keeps a map of the files on every connected device (PC bridges and the Android bridge):
 * names, folders, sizes and dates — never file contents, never credential files. The map
 * refreshes automatically when a device connects and every 30 minutes, is stored with RAY's
 * other durable state, and is shown in the 3D Brain together with cloud files (Google Drive)
 * and Second Brain notes. RAY may search it on its own ("where is my passport scan?") and
 * tells Ray what it looked at; opening or changing files still follows the access policy.
 * Disable with RAY_FILE_INDEX=off.
 */
import { Type } from '@google/genai';
import type { FunctionDeclaration } from '@google/genai';
import { dispatchBridgeProxyCall, getRoomDevices, listRoomIds } from './hub.ts';
import { loadJson, scheduleSave } from './persistence.ts';

interface IndexedFile {
  p: string;
  s: number;
  m: number;
}
interface DeviceIndex {
  deviceId: string;
  deviceName: string;
  platform: string;
  sep: string;
  indexedAt: number;
  count: number;
  truncated: boolean;
  files: IndexedFile[];
}

const rooms = new Map<string, Record<string, DeviceIndex>>();
const loaded = new Set<string>();
const REFRESH_MS = 30 * 60_000;

function enabled(): boolean {
  return !/^(0|false|off|no)$/i.test(process.env.RAY_FILE_INDEX || '');
}

async function roomIndex(roomId: string): Promise<Record<string, DeviceIndex>> {
  if (!loaded.has(roomId)) {
    loaded.add(roomId);
    const stored = await loadJson<{ devices?: Record<string, DeviceIndex> }>(`files-${roomId}`);
    rooms.set(roomId, stored?.devices || {});
  }
  if (!rooms.has(roomId)) rooms.set(roomId, {});
  return rooms.get(roomId)!;
}

export async function refreshDeviceIndex(roomId: string, deviceId: string): Promise<{ ok: boolean; count?: number; error?: string }> {
  const device = getRoomDevices(roomId).find((d) => d.id === deviceId);
  if (!device?.online) return { ok: false, error: 'Device offline' };
  const out = await dispatchBridgeProxyCall(roomId, { action: 'file_index', maxEntries: 6000 }, 90_000, deviceId);
  if (!out.ok) return { ok: false, error: out.error };
  const data = out.data as { platform?: string; sep?: string; count?: number; truncated?: boolean; files?: IndexedFile[] };
  const idx = await roomIndex(roomId);
  idx[deviceId] = {
    deviceId,
    deviceName: device.name,
    platform: String(data.platform || ''),
    sep: String(data.sep || '/'),
    indexedAt: Date.now(),
    count: Number(data.count || 0),
    truncated: Boolean(data.truncated),
    files: (data.files || []).slice(0, 15000),
  };
  scheduleSave(`files-${roomId}`, () => ({ devices: rooms.get(roomId) || {} }), 5000);
  return { ok: true, count: idx[deviceId].count };
}

let schedulerStarted = false;
export function startFileIndexScheduler(): void {
  if (schedulerStarted || !enabled()) return;
  schedulerStarted = true;
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      for (const roomId of listRoomIds()) {
        const idx = await roomIndex(roomId);
        for (const d of getRoomDevices(roomId)) {
          const canIndex = d.online && (d.type === 'bridge' || d.capabilities?.includes('fs-sandbox'));
          if (!canIndex) continue;
          if (Date.now() - (idx[d.id]?.indexedAt || 0) < REFRESH_MS) continue;
          await refreshDeviceIndex(roomId, d.id).catch(() => null);
        }
      }
    } finally {
      busy = false;
    }
  }, 60_000).unref();
}

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

export async function searchFileIndex(roomId: string, query: string, limit = 30) {
  const idx = await roomIndex(roomId);
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  const online = new Set(getRoomDevices(roomId).filter((d) => d.online).map((d) => d.id));
  const hits: Array<{ device: string; online: boolean; path: string; name: string; sizeKb: number; modified: string; score: number }> = [];
  for (const dev of Object.values(idx)) {
    for (const f of dev.files) {
      const name = baseName(f.p).toLowerCase();
      const full = f.p.toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (name.includes(t)) score += 3;
        else if (full.includes(t)) score += 1;
        else {
          score = -1;
          break;
        }
      }
      if (score > 0) {
        hits.push({ device: dev.deviceName, online: online.has(dev.deviceId), path: f.p, name: baseName(f.p), sizeKb: Math.round(f.s / 1024), modified: new Date(f.m).toISOString().slice(0, 10), score });
      }
    }
  }
  return hits.sort((a, b) => b.score - a.score || b.modified.localeCompare(a.modified)).slice(0, limit);
}

/** Compact data for the 3D brain (newest files per device). */
export async function getFileMap(roomId: string, perDevice = 1500) {
  const idx = await roomIndex(roomId);
  const online = new Set(getRoomDevices(roomId).filter((d) => d.online).map((d) => d.id));
  return Object.values(idx).map((d) => ({
    deviceId: d.deviceId,
    deviceName: d.deviceName,
    platform: d.platform,
    sep: d.sep,
    online: online.has(d.deviceId),
    indexedAt: d.indexedAt,
    count: d.count,
    truncated: d.truncated,
    files: d.files.slice(0, perDevice),
  }));
}

export const fileIndexToolDeclarations: FunctionDeclaration[] = [
  {
    name: 'search_file_index',
    description:
      'Find files by name across ALL of Ray’s devices (PC and phone) using RAY’s file map — works even if a device is offline right now. Read-only. Use before read_system_file / opening a file.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: 'Words from the file name or folder, e.g. "passport scan", "resume pdf".' },
        refresh: { type: Type.BOOLEAN, description: 'Re-scan online devices first (slower).' },
      },
      required: ['query'],
    },
  },
];

export async function executeFileIndexTool(roomId: string, name: string, args: Record<string, unknown>): Promise<{ result: string } | null> {
  if (name !== 'search_file_index') return null;
  if (!enabled()) return { result: 'The file map is turned off (RAY_FILE_INDEX=off).' };
  if (args.refresh) {
    for (const d of getRoomDevices(roomId).filter((x) => x.online && x.type === 'bridge')) await refreshDeviceIndex(roomId, d.id).catch(() => null);
  }
  const hits = await searchFileIndex(roomId, String(args.query || ''));
  if (!hits.length) {
    const idx = await roomIndex(roomId);
    const devs = Object.values(idx);
    return {
      result: devs.length
        ? `No files matching "${args.query}" in the file map of ${devs.map((d) => `${d.deviceName} (${d.count} files)`).join(', ')}.`
        : 'No device has been indexed yet — the PC/Android bridge must be online once.',
    };
  }
  return { result: JSON.stringify(hits.map(({ score: _s, ...h }) => h)) };
}
