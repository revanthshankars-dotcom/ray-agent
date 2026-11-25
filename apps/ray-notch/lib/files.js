// Files, folders and apps on this PC, handled inside the notch: no internet, no model, no bridge.
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const P = process.platform;
const HOME = os.homedir();

const FOLDER_ALIASES = {
  desktop: ['Desktop'],
  documents: ['Documents'],
  docs: ['Documents'],
  'my documents': ['Documents'],
  downloads: ['Downloads'],
  download: ['Downloads'],
  pictures: ['Pictures'],
  photos: ['Pictures'],
  images: ['Pictures'],
  screenshots: ['Pictures/Screenshots', 'Desktop'],
  music: ['Music'],
  songs: ['Music'],
  videos: ['Videos', 'Movies'],
  movies: ['Videos', 'Movies'],
  onedrive: ['OneDrive'],
  home: [''],
  'user folder': [''],
};

/** "downloads" -> C:\Users\me\Downloads (OneDrive-backed Desktop/Documents too), or null. */
function knownFolder(name) {
  const key = String(name || '').toLowerCase().replace(/^(my|the)\s+/, '').replace(/\s+folder$/, '').trim();
  const subs = FOLDER_ALIASES[key];
  if (!subs) return null;
  for (const sub of subs) {
    for (const base of [HOME, path.join(HOME, 'OneDrive')]) {
      const p = path.join(base, sub);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

const SKIP = new Set(['node_modules', 'AppData', 'Library', 'Application Data', '$Recycle.Bin', 'System Volume Information', 'Windows', 'Program Files', 'Program Files (x86)', 'ProgramData', '__pycache__', 'site-packages', 'venv', '.venv', 'dist', 'build', 'target', 'Cache', 'cache', 'Temp', 'tmp']);
const MAX_ITEMS = 250_000;
const MAX_DEPTH = 8;

function searchRoots() {
  const roots = [];
  const add = (p) => p && fs.existsSync(p) && !roots.includes(p) && roots.push(p);
  for (const k of ['desktop', 'downloads', 'documents', 'pictures', 'music', 'videos']) add(knownFolder(k));
  add(path.join(HOME, 'OneDrive'));
  add(HOME);
  if (P === 'win32') for (const d of 'DEFGH') add(`${d}:\\`);
  return roots;
}

/** Background index of file and folder names, so "find X" answers instantly. */
class FileIndex {
  constructor() {
    this.items = [];
    this.seen = new Set();
    this.ready = false;
    this.building = false;
  }
  start() {
    void this.build();
    setInterval(() => void this.build(), 20 * 60_000).unref?.();
  }
  async build() {
    if (this.building) return;
    this.building = true;
    const items = [];
    const seen = new Set();
    let dirs = 0;
    for (const root of searchRoots()) {
      const stack = [[root, 0]];
      while (stack.length && items.length < MAX_ITEMS) {
        const [dir, depth] = stack.pop();
        if (seen.has(dir)) continue;
        seen.add(dir);
        let entries;
        try {
          entries = await fsp.readdir(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of entries) {
          if (e.name.startsWith('.') || e.name.startsWith('~$') || SKIP.has(e.name)) continue;
          const full = path.join(dir, e.name);
          const isDir = e.isDirectory();
          items.push({ n: e.name.toLowerCase(), p: full, d: isDir });
          if (isDir && depth < MAX_DEPTH) stack.push([full, depth + 1]);
        }
        // Stay out of the way of the UI while indexing.
        if (++dirs % 150 === 0) {
          this.items = items.slice();
          await new Promise((r) => setImmediate(r));
        }
      }
    }
    this.items = items;
    this.ready = true;
    this.building = false;
  }
  /** Best matches for "q" by name. kind: 'file' | 'folder' | undefined. */
  async search(q, { kind, limit = 8 } = {}) {
    const words = String(q || '').toLowerCase().replace(/[^\p{L}\p{N}.\-_ ]+/gu, ' ').split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const whole = words.join(' ');
    const hits = [];
    for (const it of this.items) {
      if (kind === 'file' && it.d) continue;
      if (kind === 'folder' && !it.d) continue;
      if (!words.every((w) => it.n.includes(w))) continue;
      const base = it.n.replace(/\.[^.]+$/, '');
      let score = 0;
      if (base === whole || it.n === whole) score += 100;
      else if (base.startsWith(whole)) score += 50;
      score -= it.p.length / 40; // shallower paths first
      hits.push({ it, score });
    }
    hits.sort((a, b) => b.score - a.score);
    const top = hits.slice(0, limit * 3);
    const out = [];
    for (const { it, score } of top) {
      try {
        const st = await fsp.stat(it.p);
        out.push({ name: path.basename(it.p), path: it.p, dir: it.d, mtime: st.mtimeMs, score });
      } catch {
        // deleted since indexing
      }
    }
    // Among equally good names, the one touched most recently wins.
    out.sort((a, b) => b.score + b.mtime / 1e12 - (a.score + a.mtime / 1e12));
    return out.slice(0, limit);
  }
}

/** Newest files in a folder (default Downloads). */
async function recentFiles(folder, limit = 8) {
  const dir = folder || knownFolder('downloads') || HOME;
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    if (n.startsWith('.') || n === 'desktop.ini') continue;
    try {
      const st = await fsp.stat(path.join(dir, n));
      out.push({ name: n, path: path.join(dir, n), dir: st.isDirectory(), mtime: st.mtimeMs });
    } catch {
      // unreadable
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

async function makeFolder(name, where) {
  const base = (where && (knownFolder(where) || (path.isAbsolute(where) && where))) || knownFolder('desktop') || HOME;
  const clean = String(name).replace(/[<>:"/\\|?*]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error('That folder needs a name.');
  const p = path.join(base, clean);
  await fsp.mkdir(p, { recursive: true });
  return p;
}

// --- apps --------------------------------------------------------------------------------------------
const WIN_BUILTIN = {
  calculator: 'calc.exe',
  calc: 'calc.exe',
  notepad: 'notepad.exe',
  paint: 'mspaint.exe',
  'file explorer': 'explorer.exe',
  explorer: 'explorer.exe',
  'this pc': 'explorer.exe',
  'task manager': 'taskmgr.exe',
  'command prompt': 'cmd.exe',
  cmd: 'cmd.exe',
  terminal: 'wt.exe',
  powershell: 'powershell.exe',
  'control panel': 'control.exe',
  settings: 'ms-settings:',
  'snipping tool': 'ms-screenclip:',
};

let startApps = null; // [{name, id}] from Windows' own Start menu list (Store apps included)
async function loadStartApps(ps) {
  if (P !== 'win32' || !ps) return [];
  if (startApps) return startApps;
  const r = await ps('Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress', 15000);
  try {
    const j = JSON.parse(r.out || '[]');
    startApps = (Array.isArray(j) ? j : [j]).filter((x) => x && x.Name).map((x) => ({ name: String(x.Name), id: String(x.AppID) }));
  } catch {
    startApps = [];
  }
  return startApps;
}

function findStartApp(apps, name) {
  const q = name.toLowerCase();
  const words = q.split(/\s+/);
  let best = null;
  let bestScore = -1;
  for (const a of apps) {
    const n = a.name.toLowerCase();
    if (/uninstall|readme|help|documentation|release notes/.test(n)) continue;
    let s = -1;
    if (n === q) s = 100;
    else if (n.startsWith(q)) s = 60 - n.length / 10;
    else if (words.every((w) => n.includes(w))) s = 30 - n.length / 10;
    if (s > bestScore) {
      bestScore = s;
      best = a;
    }
  }
  return best;
}

const launch = (cmd, args = []) => spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false }).on('error', () => {}).unref();

/** Opens an installed app without the bridge or the internet. Returns its display name, or null. */
async function openApp(name, { ps, openExternal } = {}) {
  const q = String(name || '').toLowerCase().trim();
  if (!q) return null;
  if (P === 'win32') {
    const builtin = WIN_BUILTIN[q];
    if (builtin) {
      if (builtin.endsWith(':')) await openExternal(builtin);
      else launch(builtin);
      return name;
    }
    const app = findStartApp(await loadStartApps(ps), q);
    if (!app) return null;
    launch('explorer.exe', [`shell:AppsFolder\\${app.id}`]);
    return app.name;
  }
  if (P === 'darwin') {
    const ok = await new Promise((res) => spawn('open', ['-a', name]).on('exit', (c) => res(c === 0)).on('error', () => res(false)));
    return ok ? name : null;
  }
  try {
    launch(q.replace(/\s+/g, '-'));
    return name;
  } catch {
    return null;
  }
}

const FOLDER_NAMES = Object.keys(FOLDER_ALIASES);

module.exports = { FOLDER_NAMES, knownFolder, FileIndex, recentFiles, makeFolder, openApp, loadStartApps };
