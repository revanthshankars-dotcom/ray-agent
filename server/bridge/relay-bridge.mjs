#!/usr/bin/env node
// RAY Device Bridge v3 — runs on Windows, macOS, Linux AND Android (Termux).
// Gives RAY real hands on this device: open tabs/URLs, launch installed apps, read files,
// see the screen, guarded mouse/keyboard, local Ollama, notifications, Wake-on-LAN.
//
// First run installs itself as a background service that starts on boot and reconnects
// forever — after that RAY is always connected when you say "Hey Ray".
//
// Usage:
//   npm install ws && node relay-bridge-__RAY_ROOM_ID_LOWER__.mjs      (installs + starts in background)
//   node relay-bridge-__RAY_ROOM_ID_LOWER__.mjs --foreground           (run in this terminal, no install)
//   node relay-bridge-__RAY_ROOM_ID_LOWER__.mjs --install-startup    (Auto-start silently on PC boot!)
//   node relay-bridge-__RAY_ROOM_ID_LOWER__.mjs --set-token <token>  (Update room token without re-downloading)
//   node relay-bridge-__RAY_ROOM_ID_LOWER__.mjs --status             (Check bridge + Ollama + startup status)
// Optional env:
//   RELAY_VAULT_DIR=/path/to/ObsidianVault
//   RELAY_ALLOWED_DIRS=/path/one,/path/two   (comma-separated extra folders for RAY file access)
//   OLLAMA_HOST=http://127.0.0.1:11434
//   RELAY_READ_SCOPE=home|limited             (default home: RAY may READ anything in your home folder)
//
// Android: install Termux + Termux:API + Termux:Boot from F-Droid, then in Termux:
//   pkg install nodejs termux-api && npm install ws && node relay-bridge-__RAY_ROOM_ID_LOWER__.mjs
//   Grant Termux "Display over other apps" so RAY can open apps, and Termux:API notification access
//   so RAY can relay incoming WhatsApp / Instagram messages.

import os from 'os';
import fs from 'fs';
import path from 'path';
import http from 'http';
import dgram from 'dgram';
import { execFile, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';

const BRIDGE_VERSION = '3.0';
const IS_TERMUX = Boolean(process.env.PREFIX && process.env.PREFIX.includes('com.termux')) || fs.existsSync('/data/data/com.termux');
const PLATFORM = IS_TERMUX ? 'android' : os.platform();
const WS_URL = process.env.RELAY_WS_URL || "__RAY_WS_URL__";
const ROOM_ID = process.env.RELAY_ROOM_ID || "__RAY_ROOM_ID__";
const DEFAULT_ROOM_TOKEN = "__RAY_ROOM_TOKEN__";
const OLLAMA_HOST = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace('://localhost', '://127.0.0.1');
const LOCAL_PORT = Number(process.env.RELAY_LOCAL_PORT || 17345);
const VAULT_ROOT_RAW = process.env.RELAY_VAULT_DIR || path.join(os.homedir(), 'Documents', 'RAY-Brain');
const DEVICE_ID = 'bridge-' + os.hostname().toLowerCase().replace(/[^a-z0-9]/g, '');
const DEVICE_NAME = process.env.RELAY_DEVICE_NAME || (IS_TERMUX ? 'Android Phone (RAY Bridge)' : os.hostname() + ' (OS Bridge)');

const CONFIG_DIR = path.join(os.homedir(), '.ray-bridge');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config-' + ROOM_ID.toLowerCase() + '.json');

function loadSavedBridgeConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch {}
  return {};
}

function saveBridgeConfig(patch) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const next = { ...loadSavedBridgeConfig(), ...patch, updatedAt: Date.now() };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

const savedCfg = loadSavedBridgeConfig();
let ROOM_TOKEN = String(process.env.RELAY_ROOM_TOKEN || savedCfg.roomToken || DEFAULT_ROOM_TOKEN).trim();

function getStartupLocations() {
  const plat = PLATFORM;
  if (plat === 'android') {
    const installDir = path.join(os.homedir(), '.ray-bridge', 'app');
    return {
      plat,
      installDir,
      scriptTarget: path.join(installDir, 'relay-bridge.mjs'),
      startupFile: path.join(os.homedir(), '.termux', 'boot', 'ray-bridge-' + ROOM_ID.toLowerCase() + '.sh'),
      logFile: path.join(installDir, 'bridge.log'),
    };
  }
  if (plat === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    const installDir = path.join(appData, 'RAY-Bridge');
    const startupFolder = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    return {
      plat,
      installDir,
      scriptTarget: path.join(installDir, 'relay-bridge.mjs'),
      startupFile: path.join(startupFolder, 'RAY-Bridge-' + ROOM_ID + '.vbs'),
      logFile: path.join(installDir, 'bridge.log'),
    };
  }
  if (plat === 'darwin') {
    const installDir = path.join(os.homedir(), 'Library', 'Application Support', 'RAY-Bridge');
    return {
      plat,
      installDir,
      scriptTarget: path.join(installDir, 'relay-bridge.mjs'),
      startupFile: path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.ray.bridge.' + ROOM_ID.toLowerCase() + '.plist'),
      logFile: path.join(installDir, 'bridge.log'),
    };
  }
  const installDir = path.join(os.homedir(), '.local', 'share', 'ray-bridge');
  return {
    plat,
    installDir,
    scriptTarget: path.join(installDir, 'relay-bridge.mjs'),
    startupFile: path.join(os.homedir(), '.config', 'systemd', 'user', 'ray-bridge-' + ROOM_ID.toLowerCase() + '.service'),
    logFile: path.join(installDir, 'bridge.log'),
  };
}

function isStartupInstalled() {
  try {
    return fs.existsSync(getStartupLocations().startupFile);
  } catch {
    return false;
  }
}

function runSyncExec(cmd, args, cwd) {
  return new Promise((resolve) => {
    // Node >= 18.20 refuses to execFile .cmd/.bat without a shell on Windows.
    const needsShell = os.platform() === 'win32' && /\.(cmd|bat)$/i.test(cmd);
    execFile(cmd, args, { cwd, timeout: 120000, shell: needsShell }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

async function handleCliFlags() {
  const args = process.argv.slice(2);
  const setTokenIdx = args.indexOf('--set-token');
  if (setTokenIdx >= 0) {
    const newToken = String(args[setTokenIdx + 1] || '').trim();
    if (!newToken || newToken.length < 16) {
      console.error('[RAY Bridge] Invalid token. Usage: node relay-bridge.mjs --set-token <room_token>');
      process.exit(1);
    }
    saveBridgeConfig({ roomToken: newToken });
    ROOM_TOKEN = newToken;
    console.log('[RAY Bridge] Saved updated room token for', ROOM_ID, 'in', CONFIG_FILE);
    console.log('[RAY Bridge] Restart any running background bridge (or reboot) to apply immediately.');
    if (!args.includes('--install-startup')) process.exit(0);
  }

  if (args.includes('--uninstall-startup')) {
    const loc = getStartupLocations();
    if (loc.plat === 'darwin' && fs.existsSync(loc.startupFile)) {
      await runSyncExec('launchctl', ['unload', loc.startupFile]);
    } else if (loc.plat === 'linux' && fs.existsSync(loc.startupFile)) {
      await runSyncExec('systemctl', ['--user', 'disable', '--now', path.basename(loc.startupFile)]);
    }
    if (fs.existsSync(loc.startupFile)) {
      fs.unlinkSync(loc.startupFile);
      console.log('[RAY Bridge] Removed auto-start entry:', loc.startupFile);
    } else {
      console.log('[RAY Bridge] No auto-start entry found at:', loc.startupFile);
    }
    process.exit(0);
  }

  if (args.includes('--install-startup')) {
    const loc = getStartupLocations();
    const selfPath = fileURLToPath(import.meta.url);
    fs.mkdirSync(loc.installDir, { recursive: true });
    let srcCode = fs.readFileSync(selfPath, 'utf8');
    // Bake latest ROOM_TOKEN into persistent config so installed script keeps it synced
    saveBridgeConfig({ roomToken: ROOM_TOKEN });
    fs.writeFileSync(loc.scriptTarget, srcCode, 'utf8');

    if (!fs.existsSync(path.join(loc.installDir, 'node_modules', 'ws'))) {
      console.log('[RAY Bridge] Installing ws dependency into', loc.installDir, '...');
      const npmBin = loc.plat === 'win32' ? 'npm.cmd' : 'npm';
      await runSyncExec(npmBin, ['install', '--no-audit', '--no-fund', 'ws'], loc.installDir);
    }

    if (loc.plat === 'android') {
      fs.mkdirSync(path.dirname(loc.startupFile), { recursive: true });
      const sh = '#!/data/data/com.termux/files/usr/bin/sh\n' +
        'termux-wake-lock\n' +
        'while true; do "' + process.execPath + '" "' + loc.scriptTarget + '" --foreground >> "' + loc.logFile + '" 2>&1; sleep 5; done\n';
      fs.writeFileSync(loc.startupFile, sh, { mode: 0o755 });
      spawn('sh', [loc.startupFile], { detached: true, stdio: 'ignore' }).unref();
      console.log('[RAY Bridge] Installed Termux:Boot launcher:', loc.startupFile);
      console.log('[RAY Bridge] Running in background now. Open the Termux:Boot app once so Android allows it to start on boot.');
    } else if (loc.plat === 'win32') {
      fs.mkdirSync(path.dirname(loc.startupFile), { recursive: true });
      const nodeBin = process.execPath;
      const launchCmd = path.join(loc.installDir, 'launch.cmd');
      const cmdContent = '@echo off\r\n:loop\r\n"' + nodeBin + '" "' + loc.scriptTarget + '" --foreground >> "' + loc.logFile + '" 2>&1\r\ntimeout /t 5 /nobreak >nul\r\ngoto loop\r\n';
      fs.writeFileSync(launchCmd, cmdContent, 'utf8');
      const vbs = 'Set WshShell = CreateObject("WScript.Shell")\r\n' +
        'WshShell.Run Chr(34) & "' + launchCmd.replace(/"/g, '""') + '" & Chr(34), 0, False\r\n';
      fs.writeFileSync(loc.startupFile, vbs, 'utf8');
      console.log('[RAY Bridge] Installed silent Windows Startup launcher:', loc.startupFile);
      spawn('wscript.exe', [loc.startupFile], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      console.log('[RAY Bridge] Background bridge started silently! Check log at:', loc.logFile);
    } else if (loc.plat === 'darwin') {
      fs.mkdirSync(path.dirname(loc.startupFile), { recursive: true });
      const label = 'com.ray.bridge.' + ROOM_ID.toLowerCase();
      const plist = '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
        '<plist version="1.0"><dict>\n' +
        '  <key>Label</key><string>' + label + '</string>\n' +
        '  <key>ProgramArguments</key><array><string>' + process.execPath + '</string><string>' + loc.scriptTarget + '</string><string>--foreground</string></array>\n' +
        '  <key>RunAtLoad</key><true/>\n' +
        '  <key>KeepAlive</key><true/>\n' +
        '  <key>StandardOutPath</key><string>' + loc.logFile + '</string>\n' +
        '  <key>StandardErrorPath</key><string>' + loc.logFile + '</string>\n' +
        '</dict></plist>\n';
      fs.writeFileSync(loc.startupFile, plist, 'utf8');
      await runSyncExec('launchctl', ['unload', loc.startupFile]);
      await runSyncExec('launchctl', ['load', '-w', loc.startupFile]);
      console.log('[RAY Bridge] Installed & started macOS LaunchAgent:', loc.startupFile);
    } else {
      fs.mkdirSync(path.dirname(loc.startupFile), { recursive: true });
      const svcName = path.basename(loc.startupFile);
      const unit = '[Unit]\nDescription=RAY Desktop OS Bridge (' + ROOM_ID + ')\nAfter=network-online.target\n\n' +
        '[Service]\nExecStart=' + process.execPath + ' ' + loc.scriptTarget + ' --foreground\nRestart=always\nRestartSec=5\n\n' +
        '[Install]\nWantedBy=default.target\n';
      fs.writeFileSync(loc.startupFile, unit, 'utf8');
      await runSyncExec('systemctl', ['--user', 'daemon-reload']);
      await runSyncExec('systemctl', ['--user', 'enable', '--now', svcName]);
      console.log('[RAY Bridge] Installed & started Linux systemd user service:', loc.startupFile);
    }
    process.exit(0);
  }

  // Zero-touch: a plain first run installs the background service (auto-start on boot,
  // auto-restart on crash) and exits, so RAY is connected every time you wake it.
  const selfPath = fileURLToPath(import.meta.url);
  const loc0 = getStartupLocations();
  const runningInstalledCopy = path.resolve(selfPath) === path.resolve(loc0.scriptTarget);
  if (!args.includes('--foreground') && !args.includes('--status') && !runningInstalledCopy && !process.env.RAY_NO_AUTOSTART) {
    console.log('[RAY Bridge] First run: installing background service so RAY stays connected (use --foreground to skip)...');
    process.argv.push('--install-startup');
    return handleCliFlags();
  }

  if (args.includes('--status')) {
    await ensureOllamaRunning(false);
    console.log(JSON.stringify({
      bridgeVersion: BRIDGE_VERSION,
      roomId: ROOM_ID,
      localPort: LOCAL_PORT,
      startupInstalled: isStartupInstalled(),
      ollamaRunning: ollamaState.running,
      ollamaModels: ollamaState.models,
    }, null, 2));
    process.exit(0);
  }
}

const ollamaState = {
  running: false,
  models: [],
  lastCheck: 0,
  autoStartAttempted: false,
};

function findOllamaBinary() {
  const candidates = [];
  if (os.platform() === 'win32') {
    if (process.env.LOCALAPPDATA) {
      candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe'));
    }
    if (process.env.ProgramFiles) {
      candidates.push(path.join(process.env.ProgramFiles, 'Ollama', 'ollama.exe'));
    }
    candidates.push('ollama.exe', 'ollama');
  } else {
    candidates.push('/opt/homebrew/bin/ollama', '/usr/local/bin/ollama', '/usr/bin/ollama', 'ollama');
  }
  for (const c of candidates) {
    if (!c.includes(path.sep)) return c;
    try {
      if (fs.existsSync(c)) return c;
    } catch {}
  }
  return 'ollama';
}

async function pingOllamaOnce() {
  try {
    const r = await fetch(OLLAMA_HOST.replace(/\/+$/, '') + '/api/tags', { signal: AbortSignal.timeout(2500) });
    if (r.ok) {
      const data = await r.json();
      ollamaState.running = true;
      ollamaState.models = Array.isArray(data?.models) ? data.models.map((m) => m.name).filter(Boolean) : [];
      ollamaState.lastCheck = Date.now();
      return true;
    }
  } catch {}
  ollamaState.running = false;
  ollamaState.models = [];
  ollamaState.lastCheck = Date.now();
  return false;
}

async function ensureOllamaRunning(allowSpawn = true) {
  const alive = await pingOllamaOnce();
  if (alive) return true;
  if (!allowSpawn) return false;
  try {
    const bin = findOllamaBinary();
    const child = spawn(bin, ['serve'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, OLLAMA_ORIGINS: '*' },
    });
    child.on('error', () => {});
    child.unref();
    if (!ollamaState.autoStartAttempted) {
      ollamaState.autoStartAttempted = true;
      console.log('[RAY Bridge] Auto-starting Ollama background daemon (' + bin + ')...');
    }
    await new Promise((r) => setTimeout(r, 1800));
    return await pingOllamaOnce();
  } catch {
    return false;
  }
}

await handleCliFlags();

fs.mkdirSync(VAULT_ROOT_RAW, { recursive: true });
const VAULT_ROOT = fs.realpathSync(VAULT_ROOT_RAW);

// READ scope: by default RAY can read anything under your home folder (and shared storage on
// Android) — but never credential files. WRITE scope stays narrow (Desktop, Documents,
// Downloads, Vault, RELAY_ALLOWED_DIRS) and the cloud additionally requires your explicit command.
const READ_SCOPE = String(process.env.RELAY_READ_SCOPE || 'home').toLowerCase();

function buildReadRoots(writeRoots) {
  if (READ_SCOPE !== 'home') return writeRoots;
  const extra = [{ id: 'home', label: 'Home', dir: os.homedir() }];
  if (IS_TERMUX) {
    extra.push({ id: 'phone-storage', label: 'Phone Storage', dir: '/sdcard' });
    extra.push({ id: 'phone-storage-2', label: 'Phone Storage', dir: path.join(os.homedir(), 'storage', 'shared') });
  }
  if (os.platform() === 'win32') {
    for (const letter of ['D', 'E', 'F']) extra.push({ id: 'drive-' + letter.toLowerCase(), label: letter + ':\\', dir: letter + ':\\' });
  }
  const seen = new Set(writeRoots.map((r) => r.path));
  const out = [...writeRoots];
  for (const c of extra) {
    try {
      if (fs.existsSync(c.dir)) {
        const real = fs.realpathSync(c.dir);
        if (!seen.has(real)) {
          seen.add(real);
          out.push({ id: c.id, label: c.label, path: real, readOnly: true });
        }
      }
    } catch {}
  }
  return out;
}

function buildAllowedFsRoots() {
  const candidates = [
    { id: 'desktop', label: 'Desktop', dir: path.join(os.homedir(), 'Desktop') },
    { id: 'documents', label: 'Documents', dir: path.join(os.homedir(), 'Documents') },
    { id: 'downloads', label: 'Downloads', dir: path.join(os.homedir(), 'Downloads') },
    { id: 'vault', label: 'RAY Brain Vault', dir: VAULT_ROOT },
  ];
  const extraRaw = String(process.env.RELAY_ALLOWED_DIRS || '').trim();
  if (extraRaw) {
    extraRaw.split(',').map((s) => s.trim()).filter(Boolean).forEach((dir, idx) => {
      candidates.push({ id: 'custom-' + (idx + 1), label: path.basename(dir) || dir, dir });
    });
  }
  const seen = new Set();
  const roots = [];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c.dir)) {
        const real = fs.realpathSync(c.dir);
        if (!seen.has(real)) {
          seen.add(real);
          roots.push({ id: c.id, label: c.label, path: real });
        }
      }
    } catch {}
  }
  return roots;
}

const WRITE_FS_ROOTS = buildAllowedFsRoots();
const ALLOWED_FS_ROOTS = buildReadRoots(WRITE_FS_ROOTS);

const PROTECTED_PROCESSES = new Set([
  'system', 'csrss.exe', 'smss.exe', 'svchost.exe', 'services.exe',
  'lsass.exe', 'explorer.exe', 'dwm.exe', 'python.exe', 'python3',
  'jarvis.exe', 'tray.py', 'taskmgr.exe', 'chrome.exe', 'chrome',
  'firefox.exe', 'firefox', 'msedge.exe', 'notepad.exe', 'code.exe',
  'code', 'winword.exe', 'excel.exe', 'powerpnt.exe', 'outlook.exe',
  'node', 'node.exe', 'launchd', 'kernel_task', 'systemd', 'init', 'finder', 'brave'
]);

const BLOCKED_HOTKEYS = new Set([
  'ctrl+alt+del', 'ctrl+alt+delete', 'control+alt+delete',
  'cmd+q', 'command+q', 'alt+f4', 'win+r', 'meta+r', 'cmd+shift+q', 'ctrl+shift+q'
]);

const ALLOWED_APPS = {
  chrome: { darwin: 'Google Chrome', win32: 'chrome.exe', linux: 'google-chrome' },
  brave: { darwin: 'Brave Browser', win32: 'brave.exe', linux: 'brave-browser' },
  firefox: { darwin: 'Firefox', win32: 'firefox.exe', linux: 'firefox' },
  notion: { darwin: 'Notion', win32: 'Notion.exe', linux: 'notion-app' },
  obsidian: { darwin: 'Obsidian', win32: 'Obsidian.exe', linux: 'obsidian' },
  whatsapp: { darwin: 'WhatsApp', win32: 'WhatsApp.exe', linux: 'whatsapp-for-linux' },
  instagram: { darwin: 'https://www.instagram.com', win32: 'https://www.instagram.com', linux: 'https://www.instagram.com' },
  notebooklm: { darwin: 'https://notebooklm.google.com', win32: 'https://notebooklm.google.com', linux: 'https://notebooklm.google.com' },
  vscode: { darwin: 'Visual Studio Code', win32: 'code', linux: 'code' },
  notepad: { darwin: 'TextEdit', win32: 'notepad.exe', linux: 'gedit' },
  calc: { darwin: 'Calculator', win32: 'calc.exe', linux: 'gnome-calculator' },
  explorer: { darwin: 'Finder', win32: 'explorer.exe', linux: 'xdg-open' },
  terminal: { darwin: 'Terminal', win32: 'wt.exe', linux: 'x-terminal-emulator' },
};

function isProtected(name) {
  const clean = String(name || '').trim().toLowerCase();
  if (!clean) return true;
  if (/^\d+$/.test(clean) && Number(clean) <= 1) return true;
  return PROTECTED_PROCESSES.has(clean);
}

function validateSafeUrl(raw, allowDeepLinks = false) {
  const u = new URL(String(raw || '').trim());
  const p = u.protocol.toLowerCase();
  const allowed = allowDeepLinks
    ? ['http:', 'https:', 'whatsapp:', 'notion:', 'obsidian:', 'vscode:', 'spotify:', 'instagram:', 'tg:', 'mailto:', 'tel:', 'sms:', 'ms-settings:', 'zoommtg:', 'msteams:']
    : ['http:', 'https:'];
  if (!allowed.includes(p)) {
    throw new Error('Blocked URL protocol: ' + p);
  }
  return u.toString();
}

function resolveSafeVaultPath(relPath) {
  const cleanRel = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!cleanRel || cleanRel.includes('\0')) {
    throw new Error('Invalid vault note path.');
  }
  const normalizedName = cleanRel.endsWith('.md') ? cleanRel : cleanRel + '.md';
  const candidate = path.resolve(VAULT_ROOT, normalizedName);
  const parentReal = fs.existsSync(path.dirname(candidate))
    ? fs.realpathSync(path.dirname(candidate))
    : VAULT_ROOT;
  if (parentReal !== VAULT_ROOT && !parentReal.startsWith(VAULT_ROOT + path.sep)) {
    throw new Error('Path escapes RELAY_VAULT_DIR sandbox.');
  }
  if (candidate !== VAULT_ROOT && !candidate.startsWith(VAULT_ROOT + path.sep)) {
    throw new Error('Path traversal blocked.');
  }
  return candidate;
}

function resolveSafeFsPath(rawInput, mustExist = true) {
  const raw = String(rawInput || '').trim();
  const alias = raw.toLowerCase();
  let candidate = raw;
  const matchedAlias = ALLOWED_FS_ROOTS.find((r) => r.id === alias || r.label.toLowerCase() === alias);
  if (matchedAlias) {
    candidate = matchedAlias.path;
  } else if (!raw) {
    candidate = (ALLOWED_FS_ROOTS[0] && ALLOWED_FS_ROOTS[0].path) || VAULT_ROOT;
  } else if (!path.isAbsolute(raw)) {
    const base = (ALLOWED_FS_ROOTS[0] && ALLOWED_FS_ROOTS[0].path) || VAULT_ROOT;
    candidate = path.resolve(base, raw);
  } else {
    candidate = path.resolve(raw);
  }

  let realTarget;
  if (mustExist) {
    if (!fs.existsSync(candidate)) throw new Error('Path does not exist: ' + candidate);
    realTarget = fs.realpathSync(candidate);
  } else {
    const parent = path.dirname(candidate);
    if (!fs.existsSync(parent)) {
      const grand = path.dirname(parent);
      if (!fs.existsSync(grand)) throw new Error('Parent directory does not exist.');
    }
    const existingParent = fs.existsSync(parent) ? fs.realpathSync(parent) : fs.realpathSync(path.dirname(parent));
    realTarget = path.join(existingParent, path.basename(candidate));
  }

  const roots = mustExist ? ALLOWED_FS_ROOTS : WRITE_FS_ROOTS;
  const insideRoot = roots.some(
    (r) => realTarget === r.path || realTarget.startsWith(r.path.endsWith(path.sep) ? r.path : r.path + path.sep)
  );
  if (!insideRoot) {
    throw new Error(
      mustExist
        ? 'Blocked: Path is outside the folders RAY may read.'
        : 'Blocked: RAY can only write inside Desktop, Documents, Downloads, the RAY Vault or RELAY_ALLOWED_DIRS.'
    );
  }

  const normalizedCheck = realTarget.replace(/\\/g, '/').toLowerCase();
  const baseName = path.basename(normalizedCheck);
  if (
    baseName === '.env' ||
    baseName.startsWith('.env.') ||
    baseName === 'id_rsa' ||
    baseName === 'id_ed25519' ||
    baseName === '.npmrc' ||
    baseName === '.pypirc' ||
    baseName === '.netrc' ||
    baseName === '.git-credentials' ||
    /\.(pem|key|pfx|p12)$/i.test(baseName) ||
    /(service[-_]?account|credentials|secrets).*\.json$/i.test(baseName) ||
    normalizedCheck.includes('/.ssh/') ||
    normalizedCheck.includes('/.aws/') ||
    normalizedCheck.includes('/.gnupg/')
  ) {
    throw new Error('Blocked by RAY Security Shield: sensitive credential/key file access is prohibited.');
  }

  return realTarget;
}

function listDirectoryEntries(dirPath, limit = 150) {
  const safeDir = resolveSafeFsPath(dirPath, true);
  const rawEntries = fs.readdirSync(safeDir, { withFileTypes: true });
  const items = [];
  for (const entry of rawEntries) {
    if (entry.name === 'node_modules' || entry.name === '$RECYCLE.BIN' || entry.name === 'System Volume Information') continue;
    const full = path.join(safeDir, entry.name);
    try {
      const stat = fs.statSync(full);
      items.push({
        name: entry.name,
        path: full,
        kind: entry.isDirectory() ? 'dir' : 'file',
        sizeBytes: entry.isDirectory() ? 0 : stat.size,
        updatedAt: stat.mtimeMs,
        ext: entry.isDirectory() ? '' : path.extname(entry.name).toLowerCase(),
      });
    } catch {}
    if (items.length >= limit) break;
  }
  items.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
  return { currentPath: safeDir, parentPath: path.dirname(safeDir), items };
}

function readSafeTextFile(filePath, startLine = 1, endLine = 400) {
  const safePath = resolveSafeFsPath(filePath, true);
  const stat = fs.statSync(safePath);
  if (stat.isDirectory()) throw new Error('Target is a directory, not a file.');
  if (stat.size > 300 * 1024) {
    throw new Error('File is too large for inline text read (' + Math.round(stat.size / 1024) + 'KB > 300KB limit).');
  }
  const buf = fs.readFileSync(safePath);
  if (buf.includes(0)) {
    throw new Error('Binary file detected; inline text preview is restricted to UTF-8 text/code files.');
  }
  const allLines = buf.toString('utf8').split(/\r?\n/);
  const s = Math.max(1, Number(startLine || 1));
  const e = Math.min(allLines.length, Math.max(s, Number(endLine || s + 399)));
  return {
    path: safePath,
    name: path.basename(safePath),
    sizeBytes: stat.size,
    totalLines: allLines.length,
    startLine: s,
    endLine: e,
    content: allLines.slice(s - 1, e).join('\n'),
  };
}

function searchSafeFiles(query, dirPath, maxResults = 35) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const startDirs = dirPath ? [resolveSafeFsPath(dirPath, true)] : WRITE_FS_ROOTS.map((r) => r.path);
  const results = [];
  const TEXT_EXTS = new Set(['.txt', '.md', '.json', '.ts', '.tsx', '.js', '.jsx', '.py', '.csv', '.log', '.html', '.css', '.yml', '.yaml', '.toml', '.sql']);

  function walk(dir, depth) {
    if (depth > 4 || results.length >= maxResults) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (results.length >= maxResults) break;
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build' || entry.name === 'AppData' || entry.name === 'Library') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.toLowerCase().includes(q)) {
          results.push({ name: entry.name, path: full, kind: 'dir', matchType: 'name' });
        }
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        try {
          resolveSafeFsPath(full, true);
        } catch {
          continue;
        }
        const nameHit = entry.name.toLowerCase().includes(q);
        let snippet = '';
        const ext = path.extname(entry.name).toLowerCase();
        if (TEXT_EXTS.has(ext)) {
          try {
            const stat = fs.statSync(full);
            if (stat.size <= 160 * 1024) {
              const raw = fs.readFileSync(full, 'utf8');
              const idx = raw.toLowerCase().indexOf(q);
              if (idx >= 0) {
                snippet = raw.slice(Math.max(0, idx - 45), idx + 110).replace(/\s+/g, ' ').trim();
              }
            }
          } catch {}
        }
        if (nameHit || snippet) {
          results.push({ name: entry.name, path: full, kind: 'file', matchType: snippet ? 'content' : 'name', snippet });
        }
      }
    }
  }

  for (const d of startDirs) {
    walk(d, 0);
  }
  return results;
}

function listVaultFiles(dir = VAULT_ROOT, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    const rel = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) {
      out.push(...listVaultFiles(full, rel));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const stat = fs.statSync(full);
      out.push({ path: rel, content: fs.readFileSync(full, 'utf8').slice(0, 100000), updatedAt: stat.mtimeMs });
    }
  }
  return out.slice(0, 120);
}

function runSafeCommand(cmd, args, cb) {
  execFile(cmd, args, { timeout: 7000 }, (err, stdout, stderr) => {
    cb(err ? (stderr || err.message) : (stdout || 'OK'), !err);
  });
}

function launchUrlSafely(urlStr, cb) {
  const plat = PLATFORM;
  if (plat === 'android') {
    runSafeCommand('am', ['start', '-a', 'android.intent.action.VIEW', '-d', urlStr], (out, ok) => {
      if (ok) return cb(out, ok);
      runSafeCommand('termux-open-url', [urlStr], cb);
    });
  } else if (plat === 'darwin') {
    runSafeCommand('open', [urlStr], cb);
  } else if (plat === 'win32') {
    // rundll32 opens the default browser reliably without a visible shell window.
    runSafeCommand('rundll32', ['url.dll,FileProtocolHandler', urlStr], cb);
  } else {
    runSafeCommand('xdg-open', [urlStr], cb);
  }
}

// ---------------------------------------------------------------------------
// Installed apps: discovery + fuzzy launch (Windows, macOS, Linux, Android)
// ---------------------------------------------------------------------------

const ANDROID_KNOWN_PACKAGES = {
  whatsapp: 'com.whatsapp', 'whatsapp business': 'com.whatsapp.w4b', instagram: 'com.instagram.android',
  facebook: 'com.facebook.katana', messenger: 'com.facebook.orca', threads: 'com.instagram.barcelona',
  youtube: 'com.google.android.youtube', 'youtube music': 'com.google.android.apps.youtube.music',
  spotify: 'com.spotify.music', chrome: 'com.android.chrome', gmail: 'com.google.android.gm',
  maps: 'com.google.android.apps.maps', 'google maps': 'com.google.android.apps.maps', telegram: 'org.telegram.messenger',
  camera: 'com.android.camera', photos: 'com.google.android.apps.photos', drive: 'com.google.android.apps.docs',
  calendar: 'com.google.android.calendar', settings: 'com.android.settings', netflix: 'com.netflix.mediaclient',
  'play store': 'com.android.vending', x: 'com.twitter.android', twitter: 'com.twitter.android',
  linkedin: 'com.linkedin.android', notion: 'notion.id', obsidian: 'md.obsidian', brave: 'com.brave.browser',
  phone: 'com.google.android.dialer', messages: 'com.google.android.apps.messaging', clock: 'com.google.android.deskclock',
};

let appCache = { at: 0, apps: [] };

function listInstalledApps(cb) {
  if (Date.now() - appCache.at < 10 * 60 * 1000 && appCache.apps.length) return cb(appCache.apps);
  const done = (apps) => {
    const uniq = [];
    const seen = new Set();
    for (const a of apps) {
      const k = (a.name + '|' + a.launch).toLowerCase();
      if (a.name && a.launch && !seen.has(k)) {
        seen.add(k);
        uniq.push(a);
      }
    }
    uniq.sort((a, b) => a.name.localeCompare(b.name));
    appCache = { at: Date.now(), apps: uniq };
    cb(uniq);
  };
  const plat = PLATFORM;
  if (plat === 'win32') {
    const ps = 'Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress';
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout) return done([]);
      try {
        const parsed = JSON.parse(stdout.trim());
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        done(arr.map((a) => ({ name: String(a.Name || ''), launch: String(a.AppID || ''), kind: 'win-appsfolder' })));
      } catch {
        done([]);
      }
    });
  } else if (plat === 'darwin') {
    const dirs = ['/Applications', '/System/Applications', '/System/Applications/Utilities', path.join(os.homedir(), 'Applications')];
    const apps = [];
    for (const d of dirs) {
      try {
        for (const e of fs.readdirSync(d)) {
          if (e.endsWith('.app')) apps.push({ name: e.replace(/\.app$/, ''), launch: path.join(d, e), kind: 'mac-app' });
        }
      } catch {}
    }
    done(apps);
  } else if (plat === 'android') {
    execFile('pm', ['list', 'packages', '-3'], { timeout: 10000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      const pkgs = err ? [] : String(stdout || '').split('\n').map((l) => l.replace('package:', '').trim()).filter(Boolean);
      const known = Object.entries(ANDROID_KNOWN_PACKAGES).map(([name, pkg]) => ({ name: name.replace(/\b\w/g, (c) => c.toUpperCase()), launch: pkg, kind: 'android-pkg' }));
      const fromPm = pkgs.map((pkg) => {
        const last = pkg.split('.').filter((x) => !['com', 'android', 'app', 'google', 'apps', 'org', 'net'].includes(x)).pop() || pkg;
        return { name: last.charAt(0).toUpperCase() + last.slice(1), launch: pkg, kind: 'android-pkg' };
      });
      done([...known.filter((k) => !pkgs.length || pkgs.includes(k.launch) || k.launch.startsWith('com.android') || k.launch.startsWith('com.google')), ...fromPm]);
    });
  } else {
    const dirs = ['/usr/share/applications', '/usr/local/share/applications', path.join(os.homedir(), '.local/share/applications'), '/var/lib/flatpak/exports/share/applications', '/var/lib/snapd/desktop/applications'];
    const apps = [];
    for (const d of dirs) {
      try {
        for (const e of fs.readdirSync(d)) {
          if (!e.endsWith('.desktop')) continue;
          const txt = fs.readFileSync(path.join(d, e), 'utf8');
          if (/^NoDisplay=true/m.test(txt)) continue;
          const name = (txt.match(/^Name=(.+)$/m) || [])[1];
          if (name) apps.push({ name: name.trim(), launch: e.replace(/\.desktop$/, ''), kind: 'linux-desktop' });
        }
      } catch {}
    }
    done(apps);
  }
}

function scoreAppMatch(query, app) {
  const q = query.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  const n = app.name.toLowerCase();
  const l = app.launch.toLowerCase();
  if (!q) return 0;
  if (n === q) return 100;
  if (n.startsWith(q)) return 80;
  if (n.split(/\s+/).includes(q)) return 70;
  if (n.includes(q)) return 60;
  if (l.includes(q.replace(/\s+/g, ''))) return 40;
  const qWords = q.split(/\s+/);
  const hits = qWords.filter((w) => w.length > 2 && n.includes(w)).length;
  return hits ? 20 + hits * 5 : 0;
}

function launchResolvedApp(app, cb) {
  if (app.kind === 'win-appsfolder') {
    return runSafeCommand('explorer.exe', ['shell:AppsFolder\\' + app.launch], (out) => cb('Launched ' + app.name + (out && out !== 'OK' ? ' (' + out.trim() + ')' : ''), true));
  }
  if (app.kind === 'mac-app') return runSafeCommand('open', [app.launch], (out, ok) => cb(ok ? 'Launched ' + app.name : out, ok));
  if (app.kind === 'android-pkg') {
    return runSafeCommand('am', ['start', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', '-p', app.launch, '--activity-new-task'], (out, ok) => {
      if (ok && !/Error|unable/i.test(out)) return cb('Launched ' + app.name + ' on Android', true);
      runSafeCommand('monkey', ['-p', app.launch, '-c', 'android.intent.category.LAUNCHER', '1'], (o2, ok2) =>
        cb(ok2 ? 'Launched ' + app.name + ' on Android' : 'Android blocked the launch. In Android settings allow Termux to "Display over other apps". (' + out + ')', ok2)
      );
    });
  }
  if (app.kind === 'linux-desktop') {
    return runSafeCommand('gtk-launch', [app.launch], (out, ok) => {
      if (ok) return cb('Launched ' + app.name, true);
      const child = spawn(app.launch, [], { detached: true, stdio: 'ignore' });
      child.on('error', () => cb('Could not launch ' + app.name, false));
      child.unref();
      setTimeout(() => cb('Launched ' + app.name, true), 400);
    });
  }
  cb('Unknown app type', false);
}

function launchAppSafely(targetRaw, cb) {
  const target = String(targetRaw || '').trim();
  if (!target) return cb('Missing application name', false);

  // URLs / deep links are opened directly.
  if (/^(https?|whatsapp|notion|obsidian|vscode|spotify|instagram|tg|mailto|tel|sms|ms-settings):/i.test(target)) {
    try {
      return launchUrlSafely(validateSafeUrl(target, true), cb);
    } catch (err) {
      return cb(err.message, false);
    }
  }
  if (target.length > 80 || /[;&|`$<>]/.test(target)) {
    return cb('Blocked application name containing unsafe characters.', false);
  }

  listInstalledApps((apps) => {
    const alias = ALLOWED_APPS[target.toLowerCase()];
    const query = target.replace(/\b(app|application|the)\b/gi, '').trim();
    let best = null;
    let bestScore = 0;
    for (const a of apps) {
      const sc = scoreAppMatch(query, a);
      if (sc > bestScore) {
        best = a;
        bestScore = sc;
      }
    }
    if (best && bestScore >= 40) return launchResolvedApp(best, cb);

    if (PLATFORM === 'android') {
      const pkg = ANDROID_KNOWN_PACKAGES[query.toLowerCase()];
      if (pkg) return launchResolvedApp({ name: query, launch: pkg, kind: 'android-pkg' }, cb);
      return cb('No installed Android app matches "' + query + '".', false);
    }
    const mapped = alias?.[os.platform()];
    if (mapped && /^https?:/.test(mapped)) return launchUrlSafely(mapped, cb);
    const exe = mapped || query;
    if (!/^[a-zA-Z0-9 ._-]{1,64}$/.test(exe)) return cb('No installed app matches "' + query + '".', false);
    const plat = os.platform();
    if (plat === 'darwin') return runSafeCommand('open', ['-a', exe], cb);
    if (plat === 'win32') return runSafeCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process', "'" + exe.replace(/'/g, '') + "'"], cb);
    const child = spawn(exe, [], { detached: true, stdio: 'ignore' });
    child.on('error', () => cb('No installed app matches "' + query + '".', false));
    child.unref();
    setTimeout(() => cb('Launched ' + exe, true), 400);
  });
}

// ---------------------------------------------------------------------------
// Notifications, speech, clipboard — native on every platform
// ---------------------------------------------------------------------------

function psQuote(v) {
  return "'" + String(v || '').replace(/'/g, "''") + "'";
}

function showNativeNotification(title, message, cb) {
  const plat = PLATFORM;
  if (plat === 'android') return runSafeCommand('termux-notification', ['--title', title, '--content', message, '--priority', 'high', '--sound'], cb);
  if (plat === 'darwin') return runSafeCommand('osascript', ['-e', 'display notification ' + JSON.stringify(message) + ' with title ' + JSON.stringify(title)], cb);
  if (plat === 'win32') {
    const ps = "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;" +
      "$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);" +
      "$x = $t.GetElementsByTagName('text'); $x.Item(0).AppendChild($t.CreateTextNode(" + psQuote(title) + ")) | Out-Null; $x.Item(1).AppendChild($t.CreateTextNode(" + psQuote(message) + ")) | Out-Null;" +
      "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('RAY').Show([Windows.UI.Notifications.ToastNotification]::new($t))";
    return runSafeCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], cb);
  }
  return runSafeCommand('notify-send', [title, message], cb);
}

function speakNative(text, cb) {
  const clean = String(text || '').slice(0, 1500);
  const plat = PLATFORM;
  if (plat === 'android') return runSafeCommand('termux-tts-speak', [clean], cb);
  if (plat === 'darwin') return runSafeCommand('say', [clean], cb);
  if (plat === 'win32') {
    const ps = 'Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak(' + psQuote(clean) + ')';
    return execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 60000 }, (err) => cb(err ? err.message : 'Spoken', !err));
  }
  runSafeCommand('spd-say', [clean], (out, ok) => (ok ? cb(out, ok) : runSafeCommand('espeak', [clean], cb)));
}

function setNativeClipboard(text, cb) {
  const plat = PLATFORM;
  const pipe = (cmd, args) => {
    const child = execFile(cmd, args, { timeout: 5000 }, (err) => cb(err ? err.message : 'Copied to clipboard', !err));
    child.stdin?.write(String(text));
    child.stdin?.end();
  };
  if (plat === 'android') return runSafeCommand('termux-clipboard-set', [String(text)], cb);
  if (plat === 'darwin') return pipe('pbcopy', []);
  if (plat === 'win32') return pipe('clip', []);
  return pipe('xclip', ['-selection', 'clipboard']);
}

// ---------------------------------------------------------------------------
// Calls: ring this device (RAY calling Ray / device-to-device) and dial real numbers
// ---------------------------------------------------------------------------

const RAY_WEB_ORIGIN = WS_URL.replace(/^ws(s?):/, 'http$1:').replace(/\/ws\/?$/, '');

function ringThisDevice(call, cb) {
  const answerUrl = RAY_WEB_ORIGIN + '/?answer=' + encodeURIComponent(call.callId || '') + '&kind=' + encodeURIComponent(call.kind || 'ray') + (call.fromDeviceId ? '&from=' + encodeURIComponent(call.fromDeviceId) : '') + (call.message ? '&m=' + encodeURIComponent(String(call.message).slice(0, 300)) : '');
  const who = call.kind === 'peer' ? (call.fromName || 'your other device') : 'RAY';
  const line = call.kind === 'peer' ? 'Incoming call from ' + who : 'RAY is calling. ' + (call.message || '');
  if (PLATFORM === 'android') {
    runSafeCommand('termux-vibrate', ['-d', '1200', '-f'], () => {});
    runSafeCommand('termux-notification', [
      '--id', 'ray-call', '--title', '📞 Incoming call — ' + who, '--content', String(call.message || 'Tap to answer'),
      '--priority', 'max', '--sound', '--vibrate', '600,300,600,300,600', '--ongoing',
      '--button1', 'Answer', '--button1-action', 'termux-open-url ' + answerUrl,
      '--button2', 'Decline', '--button2-action', 'termux-notification-remove ray-call',
      '--action', 'termux-open-url ' + answerUrl,
    ], () => {});
    // Bring RAY's call screen up and announce the caller.
    launchUrlSafely(answerUrl, () => {});
    speakNative(line, () => {});
    return cb('Ringing ' + DEVICE_NAME, true);
  }
  showNativeNotification('📞 Incoming call — ' + who, String(call.message || 'Opening RAY to answer…'), () => {});
  launchUrlSafely(answerUrl, () => {});
  speakNative(line, () => {});
  cb('Ringing ' + DEVICE_NAME, true);
}

function lookupContactNumber(name, cb) {
  if (!IS_TERMUX) return cb(null, 'Contact lookup needs the Android bridge; give a phone number instead.');
  execFile('termux-contact-list', [], { timeout: 10000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
    if (err || !stdout) return cb(null, 'Could not read contacts (grant Termux:API the Contacts permission).');
    let list = [];
    try { list = JSON.parse(stdout); } catch { return cb(null, 'Contacts unreadable.'); }
    const q = String(name).toLowerCase().trim();
    const exact = list.find((c) => String(c.name || '').toLowerCase() === q);
    const partial = list.filter((c) => String(c.name || '').toLowerCase().includes(q));
    const hit = exact || (partial.length === 1 ? partial[0] : null);
    if (!hit) {
      return cb(null, partial.length > 1
        ? 'Several contacts match "' + name + '": ' + partial.slice(0, 5).map((c) => c.name).join(', ') + '. Say the full name.'
        : 'No contact named "' + name + '" on this phone.');
    }
    cb(String(hit.number || '').replace(/[^+\d]/g, ''), hit.name);
  });
}

function placePhoneCall(to, cb) {
  const raw = String(to || '').trim();
  const dial = (number, label) => {
    if (!/^\+?\d{3,15}$/.test(number)) return cb('Invalid phone number: ' + number, false);
    if (PLATFORM === 'android') {
      return runSafeCommand('termux-telephony-call', [number], (out, ok) =>
        ok ? cb('Calling ' + (label || number) + ' from ' + DEVICE_NAME, true)
           : launchUrlSafely('tel:' + number, (o2, ok2) => cb(ok2 ? 'Opened the dialer for ' + (label || number) : 'Call failed: ' + out, ok2)));
    }
    // PC: tel: opens Windows Phone Link / FaceTime / the default dialer app.
    launchUrlSafely('tel:' + number, (out, ok) => cb(ok ? 'Opened the dialer for ' + (label || number) + ' on ' + DEVICE_NAME + ' (Phone Link places the call through your phone)' : 'Could not open the dialer: ' + out, ok));
  };
  if (/^\+?[\d\s()-]{3,20}$/.test(raw)) return dial(raw.replace(/[^+\d]/g, ''), raw);
  lookupContactNumber(raw, (number, labelOrErr) => (number ? dial(number, labelOrErr) : cb(labelOrErr, false)));
}

// ---------------------------------------------------------------------------
// Wake-on-LAN: lets this device wake another sleeping PC on the same network
// ---------------------------------------------------------------------------

function getPrimaryMac() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (!ni.internal && ni.family === 'IPv4' && ni.mac && ni.mac !== '00:00:00:00:00:00') return ni.mac;
    }
  }
  return undefined;
}

function sendWakeOnLan(mac, cb) {
  const clean = String(mac || '').replace(/[^0-9a-f]/gi, '');
  if (clean.length !== 12) return cb('Invalid MAC address', false);
  const macBuf = Buffer.from(clean, 'hex');
  const packet = Buffer.alloc(102, 0xff);
  for (let i = 1; i <= 16; i++) macBuf.copy(packet, i * 6);
  const sock = dgram.createSocket('udp4');
  sock.once('error', (e) => {
    try { sock.close(); } catch {}
    cb(e.message, false);
  });
  sock.bind(() => {
    sock.setBroadcast(true);
    let sent = 0;
    for (const port of [9, 7]) {
      sock.send(packet, 0, packet.length, port, '255.255.255.255', () => {
        sent++;
        if (sent === 2) {
          try { sock.close(); } catch {}
          cb('Wake-on-LAN magic packet sent to ' + mac, true);
        }
      });
    }
  });
}

function captureScreenPng(cb) {
  const plat = os.platform();
  const tmpFile = path.join(os.tmpdir(), 'jarvis-screen-' + Date.now() + '.png');
  const finish = (errMsg, ok) => {
    try {
      if (ok && fs.existsSync(tmpFile)) {
        const b64 = fs.readFileSync(tmpFile).toString('base64');
        fs.unlinkSync(tmpFile);
        return cb({ ok: true, dataUrl: 'data:image/png;base64,' + b64, mimeType: 'image/png' });
      }
    } catch (e) {
      return cb({ ok: false, error: e.message });
    }
    try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch {}
    cb({ ok: false, error: errMsg || 'Screen capture failed' });
  };

  if (plat === 'darwin') {
    runSafeCommand('screencapture', ['-x', tmpFile], (msg, ok) => finish(msg, ok));
  } else if (plat === 'win32') {
    const ps = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp=New-Object System.Drawing.Bitmap($b.Width,$b.Height); $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $bmp.Save('${tmpFile.replace(/'/g, "''")}',[System.Drawing.Imaging.ImageFormat]::Png);`;
    runSafeCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], (msg, ok) => finish(msg, ok));
  } else if (IS_TERMUX) {
    finish('Android blocks background screenshots for non-system apps. Use "Share Screen" in the RAY app on the phone instead.', false);
  } else {
    runSafeCommand('scrot', [tmpFile], (msg, ok) => {
      if (ok) return finish(msg, ok);
      runSafeCommand('gnome-screenshot', ['-f', tmpFile], (msg2, ok2) => finish(msg2, ok2));
    });
  }
}

function executeGuiControl(payload, cb) {
  const action = String(payload.action || '').toLowerCase();
  const plat = os.platform();

  if (action === 'press_hotkey') {
    const combo = String(payload.keys || '').toLowerCase().replace(/\s+/g, '');
    if (BLOCKED_HOTKEYS.has(combo)) {
      return cb({ ok: false, error: 'Blocked hotkey: ' + combo });
    }
  }

  if (plat === 'darwin') {
    if (action === 'type_text') {
      const safe = String(payload.text || '').replace(/[\\"]/g, '');
      return runSafeCommand('osascript', ['-e', `tell application "System Events" to keystroke "${safe}"`], (m, ok) => cb({ ok, data: m }));
    }
    if (action === 'focus_window') {
      const appName = String(payload.target || '').replace(/[^a-zA-Z0-9 ._-]/g, '');
      return runSafeCommand('osascript', ['-e', `tell application "${appName}" to activate`], (m, ok) => cb({ ok, data: m }));
    }
    if (action === 'press_hotkey') {
      const parts = String(payload.keys || '').split('+');
      const key = parts.pop() || '';
      const mods = parts.map((p) => (p === 'cmd' || p === 'command' ? 'command down' : p === 'shift' ? 'shift down' : p === 'alt' ? 'option down' : 'control down'));
      const usingClause = mods.length ? ` using {${mods.join(', ')}}` : '';
      return runSafeCommand('osascript', ['-e', `tell application "System Events" to keystroke "${key}"${usingClause}`], (m, ok) => cb({ ok, data: m }));
    }
    if (action === 'mouse_click' || action === 'mouse_move') {
      const x = Math.round(Number(payload.x || 0));
      const y = Math.round(Number(payload.y || 0));
      return runSafeCommand('osascript', ['-e', `tell application "System Events" to click at {${x}, ${y}}`], (m, ok) => cb({ ok, data: m }));
    }
    return cb({ ok: true, data: 'Executed GUI action ' + action });
  }

  if (plat === 'win32') {
    // Native user32 input via a tiny inline C# helper (real clicks, scrolls and hotkeys).
    const header = "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class RayIn { " +
      "[DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int x, int y); " +
      "[DllImport(\"user32.dll\")] public static extern void mouse_event(uint f, uint dx, uint dy, int d, UIntPtr e); " +
      "[DllImport(\"user32.dll\")] public static extern void keybd_event(byte vk, byte s, uint f, UIntPtr e); }';";
    const x = Math.round(Number(payload.x || 0));
    const y = Math.round(Number(payload.y || 0));
    const runPs = (body) => runSafeCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', header + body], (m, ok) => cb({ ok, data: ok ? 'Executed ' + action : m }));
    if (action === 'mouse_move') return runPs('[RayIn]::SetCursorPos(' + x + ',' + y + ') | Out-Null');
    if (action === 'mouse_click' || action === 'mouse_double_click') {
      const right = payload.button === 'right';
      const down = right ? 8 : 2;
      const up = right ? 16 : 4;
      const once = '[RayIn]::mouse_event(' + down + ',0,0,0,[UIntPtr]::Zero); [RayIn]::mouse_event(' + up + ',0,0,0,[UIntPtr]::Zero);';
      return runPs('[RayIn]::SetCursorPos(' + x + ',' + y + ') | Out-Null; ' + once + (action === 'mouse_double_click' ? ' Start-Sleep -Milliseconds 60; ' + once : ''));
    }
    if (action === 'scroll_screen') {
      const delta = Math.round(-Number(payload.deltaY || 0)) || -120;
      return runPs('[RayIn]::mouse_event(2048,0,0,' + delta + ',[UIntPtr]::Zero)');
    }
    if (action === 'type_text') {
      const escaped = String(payload.text || '').replace(/[+^%~(){}\[\]]/g, '{$&}').replace(/'/g, "''");
      return runSafeCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('" + escaped + "')"], (m, ok) => cb({ ok, data: ok ? 'Typed text' : m }));
    }
    if (action === 'press_hotkey') {
      const VK = { ctrl: 0x11, control: 0x11, alt: 0x12, shift: 0x10, win: 0x5b, meta: 0x5b, cmd: 0x11, enter: 0x0d, return: 0x0d, tab: 0x09, esc: 0x1b, escape: 0x1b, space: 0x20, backspace: 0x08, delete: 0x2e, up: 0x26, down: 0x28, left: 0x25, right: 0x27, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22 };
      const keys = String(payload.keys || '').toLowerCase().split('+').map((k) => k.trim()).filter(Boolean);
      const codes = keys.map((k) => VK[k] ?? (/^f([1-9]|1[0-2])$/.test(k) ? 0x6f + Number(k.slice(1)) : k.length === 1 ? k.toUpperCase().charCodeAt(0) : null));
      if (codes.some((c) => c == null)) return cb({ ok: false, error: 'Unsupported key in combo: ' + payload.keys });
      const downs = codes.map((c) => '[RayIn]::keybd_event(' + c + ',0,0,[UIntPtr]::Zero);').join(' ');
      const ups = codes.slice().reverse().map((c) => '[RayIn]::keybd_event(' + c + ',0,2,[UIntPtr]::Zero);').join(' ');
      return runPs(downs + ' Start-Sleep -Milliseconds 40; ' + ups);
    }
    if (action === 'focus_window') {
      const t = String(payload.target || '').replace(/'/g, "''");
      return runSafeCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "(New-Object -ComObject WScript.Shell).AppActivate('" + t + "')"], (m, ok) => cb({ ok, data: m }));
    }
    return cb({ ok: false, error: 'Unsupported Windows GUI action ' + action });
  }

  if (plat === 'linux' && !IS_TERMUX) {
    if (action === 'press_hotkey') return runSafeCommand('xdotool', ['key', String(payload.keys || '').replace(/cmd|meta|win/gi, 'super')], (m, ok) => cb({ ok, data: m }));
    if (action === 'scroll_screen') return runSafeCommand('xdotool', ['click', Number(payload.deltaY || 0) > 0 ? '5' : '4'], (m, ok) => cb({ ok, data: m }));
    if (action === 'mouse_double_click') return runSafeCommand('xdotool', ['mousemove', String(Number(payload.x || 0)), String(Number(payload.y || 0)), 'click', '--repeat', '2', '1'], (m, ok) => cb({ ok, data: m }));
    if (action === 'focus_window') return runSafeCommand('xdotool', ['search', '--name', String(payload.target || ''), 'windowactivate'], (m, ok) => cb({ ok, data: m }));
  }
  if (IS_TERMUX) {
    return cb({ ok: false, error: 'Android does not allow other apps to control the screen without root/accessibility. RAY can still open apps, links and read notifications on this phone.' });
  }

  if (action === 'mouse_move') {
    return runSafeCommand('xdotool', ['mousemove', String(Number(payload.x || 0)), String(Number(payload.y || 0))], (m, ok) => cb({ ok, data: m }));
  }
  if (action === 'mouse_click') {
    return runSafeCommand('xdotool', ['mousemove', String(Number(payload.x || 0)), String(Number(payload.y || 0)), 'click', payload.button === 'right' ? '3' : '1'], (m, ok) => cb({ ok, data: m }));
  }
  if (action === 'type_text') {
    return runSafeCommand('xdotool', ['type', '--clearmodifiers', String(payload.text || '')], (m, ok) => cb({ ok, data: m }));
  }
  return cb({ ok: true, data: 'Executed Linux GUI action ' + action });
}

function getActiveWindowTitle(cb) {
  const plat = os.platform();
  if (plat === 'win32') {
    const ps = `Add-Type 'using System; using System.Runtime.InteropServices; public class WinAPI { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count); }'; $h=[WinAPI]::GetForegroundWindow(); $sb=New-Object System.Text.StringBuilder 256; [void][WinAPI]::GetWindowText($h,$sb,256); $sb.ToString()`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 3000 }, (err, stdout) => {
      cb(err ? '' : String(stdout || '').trim());
    });
  } else if (plat === 'darwin') {
    execFile('osascript', ['-e', 'tell application "System Events" to get name of first application process whose frontmost is true'], { timeout: 2500 }, (err, stdout) => {
      cb(err ? '' : String(stdout || '').trim());
    });
  } else {
    execFile('xdotool', ['getactivewindow', 'getwindowname'], { timeout: 2500 }, (err, stdout) => {
      cb(err ? '' : String(stdout || '').trim());
    });
  }
}

function sampleTopProcesses(cb) {
  const plat = os.platform();
  if (plat === 'darwin' || plat === 'linux') {
    execFile('ps', ['-axo', 'pid,pcpu,pmem,comm'], { timeout: 3000 }, (err, stdout) => {
      if (err || !stdout) return cb([]);
      const rows = stdout.trim().split('\n').slice(1)
        .map((line) => {
          const m = line.trim().match(/^(\d+)\s+([\d.]+)\s+([\d.]+)\s+(.+)$/);
          if (!m) return null;
          return {
            pid: Number(m[1]),
            cpuPercent: Number(m[2]),
            memoryPercent: Number(m[3]),
            name: m[4].split('/').pop() || m[4],
          };
        })
        .filter(Boolean)
        .sort((a, b) => b.cpuPercent - a.cpuPercent)
        .slice(0, 8);
      cb(rows);
    });
  } else if (plat === 'win32') {
    const ps = 'Get-Process | Sort-Object CPU -Descending | Select-Object -First 8 Id,ProcessName,@{N="MemPct";E={[math]::Round(($_.WorkingSet64/1MB),1)}},@{N="CpuSec";E={[math]::Round(($_.CPU),1)}} | ConvertTo-Json -Compress';
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 4000 }, (err, stdout) => {
      if (err || !stdout) return cb([]);
      try {
        const parsed = JSON.parse(stdout.trim());
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        const totalMb = Math.max(1, os.totalmem() / 1024 / 1024);
        cb(arr.map((p) => ({
          pid: Number(p.Id || 0),
          name: String(p.ProcessName || 'process'),
          cpuPercent: Math.min(99, Math.round(Number(p.CpuSec || 0) % 100)),
          memoryPercent: Number(((Number(p.MemPct || 0) / totalMb) * 100).toFixed(1)),
        })));
      } catch {
        cb([]);
      }
    });
  } else {
    cb([]);
  }
}

function getTelemetry(topProcesses = [], activeWindow = '') {
  const cpus = os.cpus();
  const load = os.loadavg()[0] || 0;
  const cpuPercent = Math.min(100, Math.round((load / Math.max(1, cpus.length)) * 100));
  const totalMb = Math.round(os.totalmem() / 1024 / 1024);
  const freeMb = Math.round(os.freemem() / 1024 / 1024);
  const memoryPercent = totalMb > 0 ? Math.round(((totalMb - freeMb) / totalMb) * 100) : 0;
  return {
    platform: os.platform() + ' ' + os.release(),
    cpuUsage: load.toFixed(2) + ' load (' + cpus.length + ' cores)',
    cpuPercent,
    memoryPercent,
    memoryFreeMb: freeMb,
    memoryTotalMb: totalMb,
    uptimeMinutes: Math.round(os.uptime() / 60),
    activeWindow: activeWindow || undefined,
    topProcesses,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    localTime: new Date().toLocaleTimeString(),
  };
}

async function runBridgeAction(action, reqData) {
  try {
    if (action === 'ollama_tags') {
      const targetBase = new URL(reqData.ollamaUrl || OLLAMA_HOST);
      if (!['127.0.0.1', 'localhost'].includes(targetBase.hostname)) {
        return { ok: false, data: null, error: 'Ollama bridge proxy only allows 127.0.0.1/localhost.' };
      }
      const safeOrigin = targetBase.origin.replace('://localhost', '://127.0.0.1');
      try {
        const r = await fetch(safeOrigin + '/api/tags', { signal: AbortSignal.timeout(6000) });
        const j = await r.json();
        return { ok: r.ok, data: j, error: r.ok ? undefined : 'Ollama returned ' + r.status };
      } catch {
        return { ok: false, data: null, error: 'Cannot reach local Ollama at ' + safeOrigin + ' — run "ollama serve" first.' };
      }
    }
    if (action === 'ollama_chat') {
      const targetBase = new URL(reqData.ollamaUrl || OLLAMA_HOST);
      if (!['127.0.0.1', 'localhost'].includes(targetBase.hostname)) {
        return { ok: false, data: null, error: 'Ollama bridge proxy only allows 127.0.0.1/localhost.' };
      }
      const safeOrigin = targetBase.origin.replace('://localhost', '://127.0.0.1');
      try {
        const r = await fetch(safeOrigin + '/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(reqData.body || {}),
          signal: AbortSignal.timeout(170000),
        });
        const j = await r.json();
        return { ok: r.ok, data: j, error: r.ok ? undefined : 'Ollama returned ' + r.status };
      } catch {
        return { ok: false, data: null, error: 'Local Ollama chat failed at ' + safeOrigin + ' — ensure "ollama serve" is running.' };
      }
    }
    if (action === 'fs_list_roots') {
      return { ok: true, data: { platform: os.platform(), hostname: os.hostname(), roots: ALLOWED_FS_ROOTS } };
    }
    if (action === 'fs_list_dir') {
      return { ok: true, data: listDirectoryEntries(reqData.dirPath || reqData.path || '', reqData.limit) };
    }
    if (action === 'fs_read_file') {
      return { ok: true, data: readSafeTextFile(reqData.filePath || reqData.path || '', reqData.startLine, reqData.endLine) };
    }
    if (action === 'fs_search_files') {
      return { ok: true, data: { query: reqData.query || '', results: searchSafeFiles(reqData.query, reqData.dirPath) } };
    }
    if (action === 'fs_write_file') {
      const target = resolveSafeFsPath(reqData.filePath || reqData.path || '', false);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, String(reqData.content || ''), 'utf8');
      return { ok: true, data: { path: target, saved: true, bytes: Buffer.byteLength(String(reqData.content || ''), 'utf8') } };
    }
    if (action === 'active_window') {
      return await new Promise((resolve) =>
        getActiveWindowTitle((title) =>
          sampleTopProcesses((procs) => resolve({ ok: true, data: { activeWindow: title || 'Desktop / Unknown', telemetry: getTelemetry(procs, title) } }))
        )
      );
    }
    if (action === 'vault_list') {
      return { ok: true, data: { vaultDir: VAULT_ROOT, notes: listVaultFiles() } };
    }
    if (action === 'vault_read') {
      const filePath = resolveSafeVaultPath(reqData.path);
      if (!fs.existsSync(filePath)) return { ok: false, data: null, error: 'Note not found in vault' };
      return { ok: true, data: { path: reqData.path, content: fs.readFileSync(filePath, 'utf8') } };
    }
    if (action === 'vault_write') {
      const filePath = resolveSafeVaultPath(reqData.path);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, String(reqData.content || ''), 'utf8');
      return { ok: true, data: { path: reqData.path, saved: true } };
    }
    if (action === 'vault_delete') {
      const filePath = resolveSafeVaultPath(reqData.path);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      return { ok: true, data: { path: reqData.path, deleted: true } };
    }
    if (action === 'screen_capture') {
      return await new Promise((resolve) => captureScreenPng((out) => resolve({ ok: out.ok, data: out, error: out.error })));
    }
    if (action === 'screen_control') {
      return await new Promise((resolve) => executeGuiControl(reqData.payload || {}, (out) => resolve({ ok: out.ok, data: out.data, error: out.error })));
    }
    if (action === 'open_app' || action === 'open_application') {
      const requested = reqData.target || reqData.application || reqData.app_name || '';
      return await new Promise((resolve) => launchAppSafely(requested, (out, ok) => resolve({ ok, data: { message: 'Launch ' + requested + ': ' + out }, error: ok ? undefined : out })));
    }
    if (action === 'open_url') {
      const safeUrl = validateSafeUrl(reqData.url || '', true);
      return await new Promise((resolve) => launchUrlSafely(safeUrl, (out, ok) => resolve({ ok, data: { message: 'Opened URL: ' + out }, error: ok ? undefined : out })));
    }
    if (action === 'list_apps') {
      return await new Promise((resolve) =>
        listInstalledApps((apps) => {
          const f = String(reqData.filter || '').toLowerCase();
          const list = f ? apps.filter((a) => a.name.toLowerCase().includes(f) || a.launch.toLowerCase().includes(f)) : apps;
          resolve({ ok: true, data: { platform: PLATFORM, total: apps.length, apps: list.slice(0, 400).map((a) => ({ name: a.name, id: a.launch })) } });
        })
      );
    }
    if (action === 'wake_on_lan') {
      return await new Promise((resolve) => sendWakeOnLan(reqData.mac, (msg, ok) => resolve({ ok, data: { message: msg }, error: ok ? undefined : msg })));
    }
    if (action === 'notify') {
      return await new Promise((resolve) => showNativeNotification(String(reqData.title || 'RAY'), String(reqData.message || ''), (msg, ok) => resolve({ ok, data: { message: msg }, error: ok ? undefined : msg })));
    }
    if (action === 'speak') {
      return await new Promise((resolve) => speakNative(reqData.text, (msg, ok) => resolve({ ok, data: { message: msg }, error: ok ? undefined : msg })));
    }
    if (action === 'clipboard_set') {
      return await new Promise((resolve) => setNativeClipboard(String(reqData.content || ''), (msg, ok) => resolve({ ok, data: { message: msg }, error: ok ? undefined : msg })));
    }
    if (action === 'place_call') {
      return await new Promise((resolve) => placePhoneCall(reqData.to, (msg, ok) => resolve({ ok, data: { message: msg }, error: ok ? undefined : msg })));
    }
    if (action === 'read_notifications') {
      return { ok: true, data: { items: await readChatNotifications(true) } };
    }
    if (action === 'system_info') {
      return await new Promise((resolve) =>
        getActiveWindowTitle((title) =>
          sampleTopProcesses((procs) => resolve({ ok: true, data: getTelemetry(procs, title) }))
        )
      );
    }
    return { ok: false, data: null, error: 'Unknown proxy action: ' + action };
  } catch (err) {
    return { ok: false, data: null, error: err instanceof Error ? err.message : String(err) };
  }
}

function startLocalDirectBridge() {
  const srv = http.createServer(async (req, res) => {
    const reqOrigin = req.headers.origin || '*';
    res.setHeader('Access-Control-Allow-Origin', reqOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Relay-Room-Token');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const urlObj = new URL(req.url || '/', 'http://127.0.0.1:' + LOCAL_PORT);
    const remoteAddr = String(req.socket?.remoteAddress || '');
    const isLoopback = !remoteAddr || remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1';

    if (req.method === 'GET' && urlObj.pathname === '/status' && isLoopback) {
      await ensureOllamaRunning(false);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          bridgeVersion: BRIDGE_VERSION,
          roomId: ROOM_ID,
          platform: os.platform(),
          deviceName: DEVICE_NAME,
          ollamaRunning: ollamaState.running,
          ollamaModels: ollamaState.models,
          startupInstalled: isStartupInstalled(),
        })
      );
      return;
    }

    if (req.method === 'GET' && urlObj.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          service: 'RAY Desktop OS Bridge',
          bridgeVersion: BRIDGE_VERSION,
          roomId: ROOM_ID,
          localPort: LOCAL_PORT,
          ollamaHost: OLLAMA_HOST,
          ollamaRunning: ollamaState.running,
          startupInstalled: isStartupInstalled(),
          message: 'RAY Local Direct Bridge is active. Return to your RAY browser tab.',
        })
      );
      return;
    }

    const tokenHeader = String(req.headers['x-relay-room-token'] || '');
    if (tokenHeader !== ROOM_TOKEN) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: false,
          code: 'TOKEN_MISMATCH',
          roomId: ROOM_ID,
          error:
            'Invalid X-Relay-Room-Token. Run "node relay-bridge-' +
            ROOM_ID.toLowerCase() +
            '.mjs --set-token <TOKEN>" or re-download from Pair Device -> Desktop OS Bridge.',
        })
      );
      return;
    }

    if (req.method === 'GET' && urlObj.pathname === '/health') {
      await pingOllamaOnce();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          bridgeVersion: BRIDGE_VERSION,
          deviceName: DEVICE_NAME,
          roomId: ROOM_ID,
          platform: os.platform(),
          ollamaHost: OLLAMA_HOST,
          ollamaRunning: ollamaState.running,
          ollamaModels: ollamaState.models,
          startupInstalled: isStartupInstalled(),
          localPort: LOCAL_PORT,
        })
      );
      return;
    }

    if (req.method === 'GET' && urlObj.pathname === '/ollama/tags') {
      await ensureOllamaRunning(true);
      const out = await runBridgeAction('ollama_tags', { ollamaUrl: urlObj.searchParams.get('url') || OLLAMA_HOST });
      const models = Array.isArray(out.data?.models) ? out.data.models.map((m) => m.name).filter(Boolean) : [];
      res.writeHead(out.ok ? 200 : 502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: out.ok, models, raw: out.data, error: out.error }));
      return;
    }

    if (req.method === 'POST' && (urlObj.pathname === '/ollama/chat' || urlObj.pathname === '/command')) {
      const chunks = [];
      let total = 0;
      for await (const chunk of req) {
        total += chunk.length;
        if (total > 12 * 1024 * 1024) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Payload too large' }));
          return;
        }
        chunks.push(chunk);
      }
      let parsed = {};
      try {
        parsed = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON body' }));
        return;
      }

      if (urlObj.pathname === '/ollama/chat') {
        const out = await runBridgeAction('ollama_chat', { ollamaUrl: parsed.ollamaUrl || OLLAMA_HOST, body: parsed.body || parsed });
        res.writeHead(out.ok ? 200 : 502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
        return;
      }

      const out = await runBridgeAction(String(parsed.action || ''), parsed);
      res.writeHead(out.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Not found' }));
  });

  srv.listen(LOCAL_PORT, '127.0.0.1', () => {
    console.log('[RAY Local Direct Bridge] Ready on http://127.0.0.1:' + LOCAL_PORT + ' (Ollama + OS control)');
  });
  srv.on('error', (err) => {
    console.warn('[RAY Local Direct Bridge] Port ' + LOCAL_PORT + ' notice:', err.message);
  });
}

// ---------------------------------------------------------------------------
// Android: relay incoming chat notifications (WhatsApp, Instagram, Messenger, SMS, Telegram)
// Reads only what is already shown in your notification shade (needs Termux:API +
// notification access). Nothing is sent from your accounts without your command.
// ---------------------------------------------------------------------------

const CHAT_PACKAGES = {
  'com.whatsapp': 'whatsapp', 'com.whatsapp.w4b': 'whatsapp', 'com.instagram.android': 'instagram',
  'com.facebook.orca': 'messenger', 'com.facebook.katana': 'facebook', 'org.telegram.messenger': 'telegram',
  'com.google.android.apps.messaging': 'sms', 'com.samsung.android.messaging': 'sms', 'com.instagram.barcelona': 'threads',
};
const seenNotificationKeys = new Set();

function readChatNotifications(includeSeen = false) {
  return new Promise((resolve) => {
    if (!IS_TERMUX) return resolve([]);
    execFile('termux-notification-list', [], { timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout) return resolve([]);
      let list = [];
      try { list = JSON.parse(stdout); } catch { return resolve([]); }
      const out = [];
      for (const n of Array.isArray(list) ? list : []) {
        const app = CHAT_PACKAGES[n.packageName];
        if (!app || !n.content) continue;
        if (/^\d+ new messages?$|checking for new messages/i.test(String(n.content))) continue;
        const key = n.packageName + '|' + n.title + '|' + n.content;
        if (!includeSeen && seenNotificationKeys.has(key)) continue;
        seenNotificationKeys.add(key);
        out.push({ app, from: String(n.title || 'Unknown'), text: String(n.content), receivedAt: Date.parse(n.when) || Date.now() });
      }
      if (seenNotificationKeys.size > 2000) seenNotificationKeys.clear();
      resolve(out);
    });
  });
}

let activeWs = null;
function startNotificationRelay() {
  if (!IS_TERMUX) return;
  setInterval(async () => {
    if (!activeWs || activeWs.readyState !== WebSocket.OPEN) return;
    const items = await readChatNotifications(false);
    if (items.length) activeWs.send(JSON.stringify({ event: 'messages:incoming', data: { items } }));
  }, 12000);
}

let loggedProxyRedirect = false;
let reconnectAttempt = 0;

function connect() {
  const url = WS_URL + '?room=' + encodeURIComponent(ROOM_ID) + '&token=' + encodeURIComponent(ROOM_TOKEN);
  const ws = new WebSocket(url);

  ws.on('unexpected-response', (_req, response) => {
    if (!loggedProxyRedirect) {
      loggedProxyRedirect = true;
      if (response.statusCode === 401) {
        console.log('[RAY Bridge] Room token rejected (401). Re-download the bridge from RAY → Devices → Pair, or run: node ' + path.basename(fileURLToPath(import.meta.url)) + ' --set-token <TOKEN>');
      } else {
        console.log('[RAY Bridge] Cloud hub answered HTTP ' + response.statusCode + ' (preview/auth proxy?). Will keep retrying. Local Direct Bridge on http://127.0.0.1:' + LOCAL_PORT + ' stays active.');
      }
    }
    try { ws.terminate(); } catch {}
  });

  ws.on('error', (err) => {
    if (!loggedProxyRedirect) {
      console.warn('[RAY Bridge] Cloud WS notice:', err.message);
    }
  });

  let pingTimer = null;
  ws.on('open', () => {
    loggedProxyRedirect = false;
    reconnectAttempt = 0;
    activeWs = ws;
    console.log('[RAY Bridge] Connected to room', ROOM_ID, '| Vault:', VAULT_ROOT);
    pingTimer = setInterval(() => {
      try { ws.ping(); } catch {}
    }, 25000);
    sampleTopProcesses((procs) => {
      listInstalledApps((apps) => {
        const caps = [
          'notify', 'clipboard', 'open_url', 'speak', 'timers', 'apps',
          'os-bridge', 'open_application', 'close_application', 'kill_process',
          'adjust_volume', 'obsidian-vault', 'ollama-proxy', 'fs-sandbox', 'wake-on-lan', 'chat-compose', 'calls',
        ];
        if (IS_TERMUX) caps.push('notifications-relay');
        else caps.push('screen-control', 'clean_slate', 'optimize_system');
        ws.send(JSON.stringify({
          event: 'device:register',
          data: {
            id: DEVICE_ID,
            name: DEVICE_NAME,
            type: 'bridge',
            os: IS_TERMUX ? 'Android (Termux) ' + os.arch() : os.type() + ' ' + os.arch(),
            browser: 'Node.js ' + process.version,
            capabilities: caps,
            macAddress: getPrimaryMac(),
            telemetry: { ...getTelemetry(procs), ollamaRunning: ollamaState.running, ollamaModels: ollamaState.models, installedAppCount: apps.length },
          },
        }));
      });
    });
  });

  const interval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      getActiveWindowTitle((title) => {
        sampleTopProcesses((procs) => {
          ws.send(JSON.stringify({ event: 'device:telemetry', data: { id: DEVICE_ID, telemetry: { ...getTelemetry(procs, title), ollamaRunning: ollamaState.running, ollamaModels: ollamaState.models } } }));
        });
      });
    }
  }, 15000);

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.event === 'bridge:proxy_request') {
        const reqData = msg.data || {};
        const requestId = reqData.requestId;
        const out = await runBridgeAction(reqData.action, reqData);
        ws.send(JSON.stringify({ event: 'bridge:proxy_response', data: { requestId, ok: out.ok, data: out.data, error: out.error } }));
        return;
      }

      if (msg.event !== 'command:execute') return;
      const cmd = msg.data;
      const ack = (status, message, data) => {
        ws.send(JSON.stringify({ event: 'command:ack', data: { commandId: cmd.id, deviceId: DEVICE_ID, status, message, data } }));
      };

      const platform = os.platform();
      if (cmd.type === 'open_url' && cmd.payload?.url) {
        try {
          const safeUrl = validateSafeUrl(cmd.payload.url, true);
          launchUrlSafely(safeUrl, (out, ok) => ack(ok ? 'completed' : 'failed', ok ? 'Opened ' + safeUrl + ' in a new browser tab on ' + DEVICE_NAME : 'Could not open URL: ' + out));
        } catch (err) {
          ack('failed', err.message);
        }
      } else if (cmd.type === 'notify') {
        showNativeNotification(String(cmd.payload?.title || 'RAY'), String(cmd.payload?.message || ''), (out, ok) =>
          ack(ok ? 'completed' : 'failed', ok ? 'Displayed native notification on ' + DEVICE_NAME : 'Notification failed: ' + out)
        );
      } else if (cmd.type === 'clipboard' && cmd.payload?.content) {
        setNativeClipboard(String(cmd.payload.content), (out, ok) => ack(ok ? 'completed' : 'failed', out));
      } else if (cmd.type === 'speak' && cmd.payload?.text) {
        ack('completed', 'Speaking on ' + DEVICE_NAME);
        speakNative(cmd.payload.text, () => {});
      } else if (cmd.type === 'call') {
        ringThisDevice(cmd.payload || {}, (out, ok) => ack(ok ? 'completed' : 'failed', out));
      } else if (cmd.type === 'wake') {
        ack('completed', DEVICE_NAME + ' is awake');
      } else if (cmd.type === 'refresh_telemetry') {
        sampleTopProcesses((procs) => {
          const t = getTelemetry(procs);
          ws.send(JSON.stringify({ event: 'device:telemetry', data: { id: DEVICE_ID, telemetry: t } }));
          ack('completed', 'OS telemetry refreshed', t);
        });
      } else if (cmd.type === 'bridge_command') {
        const action = String(cmd.payload?.action || '');
        if (['list_apps', 'wake_on_lan', 'notify', 'speak', 'clipboard_set', 'read_notifications', 'open_url', 'fs_list_dir', 'fs_read_file', 'fs_search_files', 'active_window'].includes(action)) {
          runBridgeAction(action, cmd.payload || {}).then((out) =>
            ack(out.ok ? 'completed' : 'failed', out.ok ? JSON.stringify(out.data).slice(0, 4000) : out.error || 'Failed', out.data && typeof out.data === 'object' ? out.data : undefined)
          );
        } else if (action === 'system_info') {
          sampleTopProcesses((procs) => ack('completed', 'Collected live OS stats', getTelemetry(procs)));
        } else if (action === 'open_app' || action === 'open_application') {
          const requested = cmd.payload?.target || cmd.payload?.application || cmd.payload?.app_name || '';
          launchAppSafely(requested, (out, ok) => ack(ok ? 'completed' : 'failed', 'Launch ' + requested + ': ' + out));
        } else if (action === 'close_application' || action === 'kill_process') {
          const target = String(cmd.payload?.target || cmd.payload?.application || '').trim();
          if (!target) return ack('failed', 'No process or application specified.');
          if (isProtected(target)) {
            return ack('failed', 'Blocked by Protected Process Safelist: ' + target + ' cannot be terminated.');
          }
          if (!/^\d+$/.test(target) && !/^[a-zA-Z0-9._-]{1,64}$/.test(target)) {
            return ack('failed', 'Blocked invalid process identifier.');
          }
          if (platform === 'darwin' || platform === 'linux') {
            const flag = /^\d+$/.test(target) ? [target] : ['-x', target];
            const bin = /^\d+$/.test(target) ? 'kill' : 'pkill';
            runSafeCommand(bin, flag, (out, ok) => ack(ok ? 'completed' : 'failed', 'Process action on ' + target + ': ' + out));
          } else if (platform === 'win32') {
            const args = /^\d+$/.test(target) ? ['/PID', target, '/F'] : ['/IM', target, '/F'];
            runSafeCommand('taskkill', args, (out, ok) => ack(ok ? 'completed' : 'failed', 'Taskkill ' + target + ': ' + out));
          }
        } else if (action === 'adjust_volume') {
          const level = Math.max(0, Math.min(100, Number(cmd.payload?.level ?? 50)));
          const done = (out, ok) => ack(ok ? 'completed' : 'failed', ok ? 'System volume set to ' + level + '%' : out);
          if (IS_TERMUX) {
            runSafeCommand('termux-volume', ['music', String(Math.round(level * 0.15))], done);
          } else if (platform === 'darwin') {
            runSafeCommand('osascript', ['-e', 'set volume output volume ' + level], done);
          } else if (platform === 'win32') {
            const ps = '$w = New-Object -ComObject WScript.Shell; 1..50 | % { $w.SendKeys([char]174) }; 1..' + Math.round(level / 2) + ' | % { $w.SendKeys([char]175) }';
            runSafeCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], done);
          } else {
            runSafeCommand('pactl', ['set-sink-volume', '@DEFAULT_SINK@', level + '%'], done);
          }
        } else if (action === 'clean_slate' || action === 'optimize_system') {
          sampleTopProcesses((procs) => {
            const nonProtected = procs.filter((p) => !isProtected(p.name));
            ack('completed', 'Safelist-verified scan complete (' + nonProtected.length + ' non-protected processes inspected; critical OS/browser processes untouched).', { telemetry: getTelemetry(procs) });
          });
        } else {
          ack('completed', 'Bridge processed action: ' + action);
        }
      } else {
        ack('acknowledged', 'Bridge received ' + cmd.type);
      }
    } catch (e) {
      console.error('Bridge error:', e);
    }
  });

  ws.on('close', () => {
    clearInterval(interval);
    if (pingTimer) clearInterval(pingTimer);
    if (activeWs === ws) activeWs = null;
    reconnectAttempt++;
    // Exponential backoff capped at 30s — never gives up, so RAY reconnects after sleep / Wi-Fi drops.
    const delay = Math.min(30000, 1000 * 2 ** Math.min(reconnectAttempt, 5)) + Math.floor(Math.random() * 1000);
    if (!loggedProxyRedirect) console.log('[RAY Bridge] Disconnected, retrying in ' + Math.round(delay / 1000) + 's...');
    setTimeout(connect, delay);
  });
}

void ensureOllamaRunning(true);
setInterval(() => {
  void ensureOllamaRunning(true);
}, 20000);

startLocalDirectBridge();
startNotificationRelay();
connect();
