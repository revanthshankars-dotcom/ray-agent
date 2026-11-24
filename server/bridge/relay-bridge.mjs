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
import crypto from 'crypto';
import WebSocket, { WebSocketServer } from 'ws';

const BRIDGE_VERSION = '3.10';
const IS_TERMUX = Boolean(process.env.PREFIX && process.env.PREFIX.includes('com.termux')) || fs.existsSync('/data/data/com.termux');
const PLATFORM = IS_TERMUX ? 'android' : os.platform();
const WS_URL = process.env.RELAY_WS_URL || "__RAY_WS_URL__";
const ROOM_ID = process.env.RELAY_ROOM_ID || "__RAY_ROOM_ID__";
const DEFAULT_ROOM_TOKEN = "__RAY_ROOM_TOKEN__";
const OLLAMA_HOST = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace('://localhost', '://127.0.0.1');
const LOCAL_PORT = Number(process.env.RELAY_LOCAL_PORT || 17345);
// Offline mode: PC bridges host a LAN hub so the phone can reach RAY with NO internet
// (same Wi-Fi, or the phone's hotspot). Discovery over UDP; everything token-protected.
const LAN_PORT = Number(process.env.RAY_LAN_PORT || 17346);
const LAN_DISCOVERY_PORT = Number(process.env.RAY_LAN_DISCOVERY_PORT || 17347);
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

/** Termux:Widget home-screen buttons: "Ask RAY" (one question) and "Talk to RAY" (a voice conversation). */
function writePhoneShortcuts(nodeBin, scriptPath) {
  const loc = { scriptTarget: scriptPath };
  const process = { execPath: nodeBin };
  // "Ask RAY" button for the home screen (Termux:Widget): speak → RAY answers, online or offline.
  const shortcutsDir = path.join(os.homedir(), '.shortcuts');
  fs.mkdirSync(shortcutsDir, { recursive: true });
  fs.writeFileSync(
    path.join(shortcutsDir, 'Ask RAY'),
    '#!/data/data/com.termux/files/usr/bin/sh\n' +
      'TEXT=$(termux-speech-to-text)\n' +
      '[ -n "$TEXT" ] && "' + process.execPath + '" "' + loc.scriptTarget + '" --ask "$TEXT"\n',
    { mode: 0o755 }
  );
  // "Talk to RAY": a back-and-forth voice conversation (listen → answer aloud → listen) until silence or "stop".
  fs.writeFileSync(
    path.join(shortcutsDir, 'Talk to RAY'),
    '#!/data/data/com.termux/files/usr/bin/sh\n' +
      'termux-notification --id ray-talk --title "RAY is listening" --content "Speak now · say stop to end" --priority max --ongoing\n' +
      'n=0\n' +
      'while [ $n -lt 12 ]; do\n' +
      '  n=$((n+1))\n' +
      '  TEXT=$(termux-speech-to-text)\n' +
      '  [ -z "$TEXT" ] && break\n' +
      '  case "$(echo "$TEXT" | tr A-Z a-z)" in *stop*|*"that\'s all"*|*goodbye*|*"bye ray"*|*"thank you"*) termux-tts-speak "Okay."; break;; esac\n' +
      '  ANS=$("' + process.execPath + '" "' + loc.scriptTarget + '" --ask "$TEXT" --quiet --target "${RAY_RUN_ON:-}")\n' +
      '  termux-notification --id ray-talk --title "RAY" --content "$ANS" --priority max --ongoing\n' +
      '  termux-tts-speak "$ANS"\n' +
      'done\n' +
      'termux-notification-remove ray-talk\n',
    { mode: 0o755 }
  );
}

async function handleCliFlags() {
  const args = process.argv.slice(2);
  const askIdx = args.indexOf('--ask');
  if (askIdx >= 0) {
    // Used by the "Ask RAY" home-screen button: hand the question to the running bridge.
    const tIdx = args.indexOf('--target');
    const target = tIdx >= 0 ? String(args[tIdx + 1] || '') : '';
    const question = args.slice(askIdx + 1).filter((a, i, arr) => a !== '--quiet' && a !== '--target' && arr[i - 1] !== '--target').join(' ').trim();
    if (!question) process.exit(0);
    try {
      const r = await fetch('http://127.0.0.1:' + LOCAL_PORT + '/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Relay-Room-Token': String(process.env.RELAY_ROOM_TOKEN || loadSavedBridgeConfig().roomToken || DEFAULT_ROOM_TOKEN) },
        body: JSON.stringify({ text: question.replace(/\s*--quiet\b/, ''), speak: !args.includes('--quiet'), target }),
        signal: AbortSignal.timeout(120000),
      });
      const j = await r.json();
      console.log(j.answer || j.error || 'No answer');
    } catch (e) {
      console.log('RAY bridge is not running on this device. Start it first.');
    }
    process.exit(0);
  }
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
      writePhoneShortcuts(process.execPath, loc.scriptTarget);
      console.log('[RAY Bridge] Added "Ask RAY" and "Talk to RAY" shortcuts — add the Termux:Widget widget to your home screen.');
      // Lets RAY open its window over other apps from the background (pop-ups and calls).
      spawn('am', ['start', '-a', 'android.settings.action.MANAGE_OVERLAY_PERMISSION', '-d', 'package:com.termux'], { detached: true, stdio: 'ignore' }).unref();
      console.log('[RAY Bridge] IMPORTANT: turn ON "Display over other apps" for Termux (the screen that just opened), and allow Termux to ignore battery optimisation when asked.');
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
  if (!args.includes('--foreground') && !args.includes('--status') && !args.includes('--ask') && !runningInstalledCopy && !process.env.RAY_NO_AUTOSTART) {
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

// A bridge must never die from one bad request — log and keep serving (phones depend on it).
process.on('uncaughtException', (err) => console.error('[RAY Bridge] Recovered from error:', err && err.stack ? err.stack.split('\n')[0] : err));
process.on('unhandledRejection', (err) => console.error('[RAY Bridge] Recovered from rejection:', err && err.message ? err.message : err));

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

/**
 * File map for RAY's 3D brain: names, folders, sizes and dates only — never file contents.
 * Skips system/app folders and anything that looks like a credential.
 */
const INDEX_SKIP_DIRS = /^(\.|node_modules$|AppData$|Library$|\$Recycle\.Bin$|System Volume Information$|Windows$|Program Files|ProgramData$|__pycache__$|venv$|\.venv$|dist$|build$|target$|cache$|Caches?$|tmp$|temp$|Android$|data$)/i;
const INDEX_SKIP_FILES = /(^\.|\.(pem|key|pfx|p12|kdbx|sqlite-wal|tmp|lock|log)$|^id_(rsa|ed25519)|credentials|secrets?\.|service[-_]?account|\.env)/i;

function buildFileIndex(maxEntries = 6000, maxDepth = 6) {
  const files = [];
  const roots = ALLOWED_FS_ROOTS.filter((r) => r.id !== 'vault' || true);
  const seenRoots = new Set(roots.map((r) => r.path));
  const seenPaths = new Set();
  const walkedRoots = new Set();
  for (const root of roots) {
    if (walkedRoots.has(root.path)) continue;
    walkedRoots.add(root.path);
    const walk = (dir, depth) => {
      if (depth > maxDepth || files.length >= maxEntries) return;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (files.length >= maxEntries) return;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (INDEX_SKIP_DIRS.test(e.name)) continue;
          // Avoid indexing the same subtree twice (Home contains Documents, Downloads…)
          if (seenRoots.has(full)) continue;
          walk(full, depth + 1);
        } else if (e.isFile() && !INDEX_SKIP_FILES.test(e.name)) {
          if (seenPaths.has(full)) continue;
          seenPaths.add(full);
          try {
            const st = fs.statSync(full);
            files.push({ p: full, s: st.size, m: Math.round(st.mtimeMs) });
          } catch {}
        }
      }
    };
    walk(root.path, 0);
  }
  // Newest first so the most relevant files survive the cap.
  files.sort((a, b) => b.m - a.m);
  return { platform: PLATFORM, sep: path.sep, roots: roots.map((r) => ({ label: r.label, path: r.path })), count: files.length, truncated: files.length >= maxEntries, files };
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

// Each browser's program on this PC, so "open it in Chrome" uses Chrome even when Brave is the default.
const BROWSER_APPS = {
  chrome: { win: [['Google', 'Chrome', 'Application', 'chrome.exe']], mac: 'Google Chrome', linux: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'] },
  brave: { win: [['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe']], mac: 'Brave Browser', linux: ['brave-browser', 'brave', 'brave-browser-stable'] },
  edge: { win: [['Microsoft', 'Edge', 'Application', 'msedge.exe']], mac: 'Microsoft Edge', linux: ['microsoft-edge', 'microsoft-edge-stable'] },
  firefox: { win: [['Mozilla Firefox', 'firefox.exe']], mac: 'Firefox', linux: ['firefox'] },
  opera: { win: [['Programs', 'Opera', 'opera.exe'], ['Programs', 'Opera GX', 'opera.exe'], ['Opera', 'opera.exe']], mac: 'Opera', linux: ['opera'] },
  vivaldi: { win: [['Vivaldi', 'Application', 'vivaldi.exe']], mac: 'Vivaldi', linux: ['vivaldi', 'vivaldi-stable'] },
};

async function findBrowserBinary(name) {
  const app = BROWSER_APPS[String(name || '').toLowerCase()];
  if (!app) return null;
  const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
  if (PLATFORM === 'win32') {
    for (const base of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean)) {
      for (const parts of app.win) {
        const p = path.join(base, ...parts);
        if (exists(p)) return { bin: p, args: [] };
      }
    }
    return null;
  }
  if (PLATFORM === 'darwin') {
    return exists('/Applications/' + app.mac + '.app') || exists(path.join(os.homedir(), 'Applications', app.mac + '.app')) ? { bin: 'open', args: ['-a', app.mac] } : null;
  }
  for (const b of app.linux) {
    const where = await whichBin(b);
    if (where) return { bin: where, args: [] };
  }
  return null;
}

/** Opens the link in the named browser; falls back to the system default (and says so). */
async function launchUrlInBrowser(urlStr, browser, cb) {
  const want = String(browser || '').toLowerCase();
  if (!want || PLATFORM === 'android' || !/^https?:/i.test(urlStr)) return launchUrlSafely(urlStr, (out, ok) => cb(out, ok, ''));
  const found = await findBrowserBinary(want);
  if (!found) return launchUrlSafely(urlStr, (out, ok) => cb(out, ok, want + ' is not installed here, so it opened in the default browser'));
  try {
    // Detached: if the browser wasn't running, it keeps running after RAY's command returns.
    const child = spawn(found.bin, [...found.args, urlStr], { detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', () => launchUrlSafely(urlStr, () => undefined));
    child.unref();
    cb('OK', true, '');
  } catch (e) {
    launchUrlSafely(urlStr, (out, ok) => cb(out, ok, 'could not start ' + want + ' (' + (e?.message || e) + '), used the default browser'));
  }
}

function launchUrlSafely(urlStr, cb) {
  const plat = PLATFORM;
  if (plat === 'android') {
    // Chrome on Android reuses the tab it opened earlier for the same "application id", so tagging
    // each link with its site makes RAY reopen youtube.com in the YouTube tab instead of piling up tabs.
    let reuse = [];
    try {
      const h = new URL(urlStr);
      if (/^https?:$/.test(h.protocol)) reuse = ['--es', 'com.android.browser.application_id', 'ray.' + h.hostname.replace(/^(www|m)\./, '')];
    } catch {}
    runSafeCommand('am', ['start', '-a', 'android.intent.action.VIEW', '-d', urlStr, ...reuse], (out, ok) => {
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
// Computer use ("give RAY a mouse"): agent screenshots + actions on the PC, and on an
// Android phone through ADB (USB or Wireless debugging) from this PC.
// ---------------------------------------------------------------------------

function findAdb() {
  const cands = [];
  if (os.platform() === 'win32') {
    if (process.env.LOCALAPPDATA) cands.push(path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe'));
    cands.push(path.join(os.homedir(), 'platform-tools', 'adb.exe'), 'C:\\platform-tools\\adb.exe');
  } else {
    cands.push(path.join(os.homedir(), 'Library', 'Android', 'sdk', 'platform-tools', 'adb'), path.join(os.homedir(), 'Android', 'Sdk', 'platform-tools', 'adb'), '/usr/bin/adb', '/usr/local/bin/adb', '/opt/homebrew/bin/adb');
  }
  if (process.env.RAY_ADB_PATH) cands.unshift(process.env.RAY_ADB_PATH);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch {} }
  return 'adb';
}
const ADB = IS_TERMUX ? null : findAdb();

function adbRun(args, opts = {}) {
  return new Promise((resolve) => {
    if (!ADB) return resolve({ ok: false, out: 'ADB is only used from the PC bridge.' });
    execFile(ADB, args, { timeout: opts.timeout || 15000, maxBuffer: 25 * 1024 * 1024, encoding: opts.binary ? 'buffer' : 'utf8' }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: stdout, err: err ? String(stderr || err.message) : '' });
    });
  });
}

async function adbDevice() {
  const r = await adbRun(['devices']);
  if (!r.ok) return null;
  const line = String(r.out).split('\n').map((l) => l.trim()).find((l) => /\tdevice$/.test(l));
  return line ? line.split('\t')[0] : null;
}

/** Screenshot for the agent: JPEG ≤1280px wide + real screen size for coordinate mapping. */
function agentScreenshot(target, cb) {
  if (target === 'phone') {
    return void (async () => {
      const dev = await adbDevice();
      if (!dev) return cb({ ok: false, error: 'No Android phone over ADB. On the phone: Developer options → Wireless debugging → pair with this PC (adb pair / adb connect), or plug in USB with USB debugging on.' });
      const r = await adbRun(['-s', dev, 'exec-out', 'screencap', '-p'], { binary: true, timeout: 20000 });
      if (!r.ok || !r.out || r.out.length < 100) return cb({ ok: false, error: 'Phone screenshot failed: ' + (r.err || 'empty') });
      const buf = r.out;
      const w = buf.readUInt32BE(16);
      const h = buf.readUInt32BE(20);
      cb({ ok: true, dataUrl: 'data:image/png;base64,' + buf.toString('base64'), width: w, height: h, screenW: w, screenH: h, device: 'phone' });
    })();
  }
  if (IS_TERMUX) return cb({ ok: false, error: 'Android blocks screen capture from Termux. Control the phone through ADB from the PC bridge instead.' });
  const plat = os.platform();
  const tmp = path.join(os.tmpdir(), 'ray-agent-' + Date.now() + '.jpg');
  const finish = (screenW, screenH) => {
    try {
      const buf = fs.readFileSync(tmp);
      fs.unlinkSync(tmp);
      const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
      let width = screenW, height = screenH;
      if (!isJpeg && buf.length > 24) { width = buf.readUInt32BE(16); height = buf.readUInt32BE(20); }
      else if (isJpeg) {
        // Read JPEG SOF0/2 for the scaled size.
        for (let i = 2; i < buf.length - 9; ) {
          if (buf[i] !== 0xff) break;
          const marker = buf[i + 1];
          const len = buf.readUInt16BE(i + 2);
          if (marker === 0xc0 || marker === 0xc2) { height = buf.readUInt16BE(i + 5); width = buf.readUInt16BE(i + 7); break; }
          i += 2 + len;
        }
      }
      cb({ ok: true, dataUrl: 'data:' + (isJpeg ? 'image/jpeg' : 'image/png') + ';base64,' + buf.toString('base64'), width, height, screenW: screenW || width, screenH: screenH || height, device: 'pc' });
    } catch (e) {
      cb({ ok: false, error: 'Screenshot failed: ' + e.message });
    }
  };
  if (plat === 'win32') {
    const ps = "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; " +
      "Add-Type 'using System;using System.Runtime.InteropServices;public class RayDpi{[DllImport(\"user32.dll\")]public static extern bool SetProcessDPIAware();}'; [RayDpi]::SetProcessDPIAware() | Out-Null; " +
      "$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp=New-Object Drawing.Bitmap $b.Width,$b.Height; $g=[Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[Drawing.Point]::Empty,$b.Size); " +
      "$w=[Math]::Min(1280,$b.Width); $h=[int]($b.Height*$w/$b.Width); $s=New-Object Drawing.Bitmap $bmp,$w,$h; " +
      "$enc=[Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | ? { $_.MimeType -eq 'image/jpeg' }; $p=New-Object Drawing.Imaging.EncoderParameters 1; $p.Param[0]=New-Object Drawing.Imaging.EncoderParameter ([Drawing.Imaging.Encoder]::Quality),([long]70); " +
      "$s.Save(" + psQuote(tmp) + ",$enc,$p); Write-Output ($b.Width.ToString()+'x'+$b.Height.ToString())";
    return execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 20000 }, (err, out) => {
      if (err) return cb({ ok: false, error: 'Screenshot failed: ' + err.message });
      const [sw, sh] = String(out).trim().split('x').map(Number);
      finish(sw, sh);
    });
  }
  if (plat === 'darwin') {
    return execFile('screencapture', ['-x', '-t', 'jpg', tmp], { timeout: 15000 }, (err) => {
      if (err) return cb({ ok: false, error: 'Screenshot failed (allow Screen Recording for Terminal/Node in System Settings → Privacy).' });
      execFile('osascript', ['-e', 'tell application "Finder" to get bounds of window of desktop'], { timeout: 5000 }, (e2, out2) => {
        const parts = String(out2 || '').split(',').map((v) => Number(v.trim()));
        execFile('sips', ['-Z', '1280', tmp], { timeout: 15000 }, () => finish(parts[2] || 0, parts[3] || 0));
      });
    });
  }
  execFile('scrot', ['-o', tmp], { timeout: 15000 }, (err) => {
    if (err) return cb({ ok: false, error: 'Screenshot failed: install scrot (sudo apt install scrot).' });
    execFile('xdotool', ['getdisplaygeometry'], { timeout: 5000 }, (e2, out2) => {
      const [sw, sh] = String(out2 || '').trim().split(/\s+/).map(Number);
      execFile('convert', [tmp, '-resize', '1280x>', '-quality', '70', tmp], { timeout: 15000 }, () => finish(sw || 0, sh || 0));
    });
  });
}

const ADB_KEYS = { back: 'KEYCODE_BACK', home: 'KEYCODE_HOME', enter: 'KEYCODE_ENTER', recent: 'KEYCODE_APP_SWITCH', apps: 'KEYCODE_APP_SWITCH', delete: 'KEYCODE_DEL', backspace: 'KEYCODE_DEL', tab: 'KEYCODE_TAB', search: 'KEYCODE_SEARCH', volume_up: 'KEYCODE_VOLUME_UP', volume_down: 'KEYCODE_VOLUME_DOWN', power: 'KEYCODE_POWER' };

/** One agent action. x/y are SCREEN coordinates (already mapped by the server). */
function agentAct(target, a, cb) {
  const action = String(a.action || '');
  if (target === 'phone') {
    return void (async () => {
      const dev = await adbDevice();
      if (!dev) return cb({ ok: false, error: 'No Android phone connected over ADB.' });
      const sh = (args) => adbRun(['-s', dev, 'shell', ...args]);
      const x = String(Math.round(Number(a.x || 0)));
      const y = String(Math.round(Number(a.y || 0)));
      let r;
      if (action === 'click' || action === 'tap') r = await sh(['input', 'tap', x, y]);
      else if (action === 'double_click') { await sh(['input', 'tap', x, y]); r = await sh(['input', 'tap', x, y]); }
      else if (action === 'long_press') r = await sh(['input', 'swipe', x, y, x, y, '800']);
      else if (action === 'type') r = await sh(['input', 'text', String(a.text || '').replace(/ /g, '%s').replace(/(["'`\\$&|;<>()])/g, '\\$1')]);
      else if (action === 'key' || action === 'hotkey') r = await sh(['input', 'keyevent', ADB_KEYS[String(a.keys || a.key || '').toLowerCase()] || String(a.keys || a.key || 'KEYCODE_ENTER')]);
      else if (action === 'scroll') {
        const dy = Number(a.deltaY || 600);
        r = await sh(['input', 'swipe', x || '540', String(Number(y || 1200) + dy / 2), x || '540', String(Number(y || 1200) - dy / 2), '350']);
      } else if (action === 'open_app') {
        const q = String(a.app || '').toLowerCase();
        let pkg = ANDROID_KNOWN_PACKAGES[q] || q;
        if (!/\./.test(pkg)) {
          const list = await sh(['pm', 'list', 'packages']);
          pkg = String(list.out).split('\n').map((l) => l.replace('package:', '').trim()).find((p) => p.toLowerCase().includes(q)) || pkg;
        }
        r = await sh(['monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1']);
      } else if (action === 'move' || action === 'glide') r = { ok: true };
      else return cb({ ok: false, error: 'Unsupported phone action ' + action });
      cb({ ok: r.ok, data: 'Phone: ' + action, error: r.ok ? undefined : r.err });
    })();
  }
  if (IS_TERMUX) return cb({ ok: false, error: 'Use the PC bridge (ADB) to control the phone screen.' });
  const map = { click: 'mouse_click', double_click: 'mouse_double_click', right_click: 'mouse_click', move: 'mouse_move', glide: 'mouse_glide', type: 'type_text', hotkey: 'press_hotkey', key: 'press_hotkey', scroll: 'scroll_screen' };
  if (action === 'open_app') return launchAppSafely(String(a.app || ''), (out, ok) => cb({ ok, data: out, error: ok ? undefined : out }));
  const gui = map[action];
  if (!gui) return cb({ ok: false, error: 'Unsupported action ' + action });
  executeGuiControl({ ...a, action: gui, button: action === 'right_click' ? 'right' : a.button, keys: a.keys || a.key, target: a.target }, (out) => cb(out));
}

// ---------------------------------------------------------------------------
// Coding agents on this machine (Claude Code, Codex, Gemini CLI, Aider) as background jobs.
// The task is passed on STDIN (never on the command line) so no prompt can inject shell code.
// ---------------------------------------------------------------------------

const CODING_AGENTS = {
  claude: { bin: 'claude', args: ['-p', '--permission-mode', 'acceptEdits', '--output-format', 'text'], label: 'Claude Code' },
  codex: { bin: 'codex', args: ['exec', '-'], label: 'Codex CLI' },
  gemini: { bin: 'gemini', args: [], label: 'Gemini CLI' },
  aider: { bin: 'aider', args: ['--yes-always', '--no-pretty', '--message-file', '{PROMPT_FILE}'], label: 'Aider' },
};
const codingJobs = new Map();

function whichBin(bin) {
  return new Promise((resolve) => {
    execFile(os.platform() === 'win32' ? 'where' : 'which', [bin], { timeout: 5000 }, (err, out) => resolve(!err && String(out).trim() ? String(out).trim().split(/\r?\n/)[0] : null));
  });
}

async function listCodingAgents() {
  const out = [];
  for (const [id, a] of Object.entries(CODING_AGENTS)) {
    const where = await whichBin(a.bin);
    out.push({ id, label: a.label, installed: Boolean(where), path: where || undefined });
  }
  return out;
}

async function startCodingJob(agentId, prompt, cwdRaw) {
  const agent = CODING_AGENTS[agentId];
  if (!agent) throw new Error('Unknown coding agent: ' + agentId);
  if (!(await whichBin(agent.bin))) throw new Error(agent.label + ' is not installed on ' + DEVICE_NAME + '.');
  const rawDir = String(cwdRaw || 'Documents').replace(/^~[\\/]?/, '');
  const cwd = resolveSafeFsPath(path.isAbsolute(rawDir) ? rawDir : path.join(os.homedir(), rawDir), true);
  if (!fs.statSync(cwd).isDirectory()) throw new Error('Folder not found: ' + cwd);
  const id = crypto.randomUUID().slice(0, 8);
  const promptFile = path.join(os.tmpdir(), 'ray-agent-prompt-' + id + '.txt');
  fs.writeFileSync(promptFile, String(prompt), 'utf8');
  const args = agent.args.map((a) => (a === '{PROMPT_FILE}' ? promptFile : a));
  const child = spawn(agent.bin, args, { cwd, shell: os.platform() === 'win32', windowsHide: true, env: { ...process.env, CI: '1' } });
  const job = { id, agent: agent.label, cwd, prompt: String(prompt).slice(0, 300), status: 'running', startedAt: Date.now(), output: '', code: null };
  codingJobs.set(id, job);
  const append = (d) => { job.output = (job.output + String(d)).slice(-24000); };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  if (!agent.args.includes('{PROMPT_FILE}')) { child.stdin.write(String(prompt)); }
  child.stdin.end();
  const killer = setTimeout(() => { try { child.kill(); } catch {} job.status = 'timeout'; }, 20 * 60_000);
  child.on('close', (code) => {
    clearTimeout(killer);
    try { fs.unlinkSync(promptFile); } catch {}
    if (job.status === 'running') job.status = code === 0 ? 'done' : 'failed';
    job.code = code;
    job.endedAt = Date.now();
    if (activeWs && activeWs.readyState === WebSocket.OPEN) {
      activeWs.send(JSON.stringify({ event: 'bridge:job_done', data: { jobId: id, agent: job.agent, status: job.status, cwd, summary: job.output.trim().slice(-600) } }));
    }
  });
  child.on('error', (e) => { job.status = 'failed'; append('\n' + e.message); });
  return job;
}

// ---------------------------------------------------------------------------
// Calls: ring this device (RAY calling Ray / device-to-device) and dial real numbers
// ---------------------------------------------------------------------------

const RAY_WEB_ORIGIN = WS_URL.replace(/^ws(s?):/, 'http$1:').replace(/\/ws\/?$/, '');

function ringThisDevice(call, cb) {
  const answerUrl = RAY_WEB_ORIGIN + '/?answer=' + encodeURIComponent(call.callId || '') + '&kind=' + encodeURIComponent(call.kind || 'ray') + (call.fromDeviceId ? '&from=' + encodeURIComponent(call.fromDeviceId) : '') + (call.message ? '&m=' + encodeURIComponent(String(call.message).slice(0, 300)) : '') + (call.video ? '&video=1' : '') + (call.askId ? '&ask=' + encodeURIComponent(String(call.askId)) : '');
  const who = call.kind === 'peer' ? (call.fromName || 'your other device') : 'RAY';
  const line = call.kind === 'peer' ? 'Incoming ' + (call.video ? 'video ' : '') + 'call from ' + who : 'RAY is calling. ' + (call.message || '');
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
  playRingtone(25);
  openRayWindow(answerUrl + '&room=' + encodeURIComponent(ROOM_ID), 'RAY Call', 20, () => {});
  setTimeout(() => speakNative(line, () => {}), 1500);
  cb('Ringing ' + DEVICE_NAME + ' (window in front)', true);
}

/** All phone contacts (name + number) for RAY's contact finder — Android only, read-only. */
function listPhoneContacts() {
  if (!IS_TERMUX) return Promise.resolve({ ok: false, error: 'Phone contacts are only on the Android bridge.' });
  return new Promise((res) => {
    execFile('termux-contact-list', [], { timeout: 15000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout) return res({ ok: false, error: 'Could not read contacts (grant Termux:API the Contacts permission).' });
      try {
        const list = JSON.parse(stdout)
          .map((c) => ({ name: String(c.name || '').slice(0, 80), number: String(c.number || '').replace(/[^+\d]/g, '') }))
          .filter((c) => c.name && c.number.replace(/\D/g, '').length >= 6)
          .slice(0, 5000);
        res({ ok: true, data: list });
      } catch {
        res({ ok: false, error: 'Contacts unreadable.' });
      }
    });
  });
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
      "[DllImport(\"user32.dll\")] public static extern void keybd_event(byte vk, byte s, uint f, UIntPtr e); " +
      "[DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware(); }'; [RayIn]::SetProcessDPIAware() | Out-Null;";
    const x = Math.round(Number(payload.x || 0));
    const y = Math.round(Number(payload.y || 0));
    const runPs = (body) => runSafeCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', header + body], (m, ok) => cb({ ok, data: ok ? 'Executed ' + action : m }));
    if (action === 'mouse_move') return runPs('[RayIn]::SetCursorPos(' + x + ',' + y + ') | Out-Null');
    if (action === 'mouse_glide') {
      // Teach mode: move the pointer smoothly so Ray can follow it.
      return runPs('Add-Type -AssemblyName System.Windows.Forms; $p=[System.Windows.Forms.Cursor]::Position; for($i=1;$i -le 30;$i++){ [RayIn]::SetCursorPos([int]($p.X+(' + x + '-$p.X)*$i/30),[int]($p.Y+(' + y + '-$p.Y)*$i/30)) | Out-Null; Start-Sleep -Milliseconds 25 }');
    }
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

// ===========================================================================
// JARVIS layer (bridge 3.1): browser hands (Chrome DevTools Protocol), device
// diagnose & repair, file versions, self-update, and the RAY pop-up window.
// ===========================================================================

/** Public URL of the RAY web app this bridge belongs to (derived from the hub WebSocket URL). */
function rayAppUrl(extra) {
  try {
    const u = new URL(WS_URL);
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    u.pathname = '/';
    u.search = '';
    u.searchParams.set('room', ROOM_ID);
    for (const [k, v] of Object.entries(extra || {})) u.searchParams.set(k, String(v));
    return u.toString();
  } catch {
    return '';
  }
}

function findChromeBinary() {
  if (process.env.RAY_CHROME_PATH && fs.existsSync(process.env.RAY_CHROME_PATH)) return process.env.RAY_CHROME_PATH;
  const c = [];
  if (os.platform() === 'win32') {
    for (const base of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean)) {
      c.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      c.push(path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
      c.push(path.join(base, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'));
    }
  } else if (os.platform() === 'darwin') {
    c.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', '/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else {
    c.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/snap/bin/chromium');
  }
  return c.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

// --- Ask Ray: RAY needs a decision -------------------------------------------
// Android: speak the question and show a dialog over any app (choices or a spoken answer) — works
// while the RAY app is closed. PC: pop RAY up on the question.
async function postAskAnswer(askId, answer, via) {
  try {
    await fetch(RAY_WEB_ORIGIN + '/api/ask/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Relay-Room-Token': ROOM_TOKEN },
      body: JSON.stringify({ roomId: ROOM_ID, askId, answer, via }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {}
}
function termuxDialog(args) {
  return new Promise((resolve) => {
    execFile('termux-dialog', args, { timeout: 5 * 60_000 }, (err, stdout) => {
      try { resolve(JSON.parse(String(stdout || '{}'))); } catch { resolve({}); }
    });
  });
}
async function askOnThisDevice(p) {
  const askId = String(p.askId || '');
  const question = String(p.question || '').slice(0, 400);
  if (!askId || !question) return;
  const options = (Array.isArray(p.options) ? p.options : []).map((o) => String(o).replace(/,/g, ' ').slice(0, 60)).filter(Boolean).slice(0, 6);
  if (IS_TERMUX) {
    runSafeCommand('termux-vibrate', ['-d', '500'], () => {});
    execFile('termux-notification', ['--id', 'ray-ask', '--title', 'RAY needs your answer', '--content', question, '--priority', 'max', '--sound'], { timeout: 8000 }, () => {});
    speakNative('Ray, ' + question + (options.length ? ' Your options: ' + options.join(', or ') + '.' : ''), () => {});
    // Choices → radio list; free answer → speak it (keyboard if speech gives nothing).
    let out = options.length
      ? await termuxDialog(['radio', '-t', ('RAY: ' + question).slice(0, 180), '-v', [...options, 'Other…'].join(',')])
      : await termuxDialog(['speech', '-t', ('RAY: ' + question).slice(0, 180)]);
    let answer = String(out.text || '').trim();
    if (answer === 'Other…' || (!options.length && !answer && out.code !== -2)) {
      out = await termuxDialog(['text', '-t', ('RAY: ' + question).slice(0, 180), '-i', 'Your answer']);
      answer = String(out.text || '').trim();
    }
    execFile('termux-notification-remove', ['ray-ask'], { timeout: 5000 }, () => {});
    if (answer) await postAskAnswer(askId, answer, DEVICE_NAME + ' (dialog)');
    return;
  }
  showNativeNotification('RAY needs your answer', question, () => {});
  const url = rayAppUrl({ popup: 1, ask: askId });
  if (url) openRayWindow(url, 'RAY Assistant', p.pin ? 0 : 6, () => {});
}

// --- RAY pop-up ------------------------------------------------------------
// Windows stops background programs from stealing focus, so a freshly opened window lands behind
// whatever Ray is using. raiseWindow() finds RAY's window by its title and forces it to the front
// (Alt-key trick + briefly always-on-top) so pop-ups and calls appear over every app.
const WIN_RAISE_CS = [
  'using System; using System.Text; using System.Runtime.InteropServices;',
  'public class RayWin {',
  ' public delegate bool EnumProc(IntPtr h, IntPtr l);',
  ' [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);',
  ' [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
  ' [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);',
  ' [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);',
  ' [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr h, int n);',
  ' [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);',
  ' [DllImport("user32.dll")] static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);',
  ' public static IntPtr Find(string prefix) { IntPtr found = IntPtr.Zero; EnumWindows((h, l) => { if (!IsWindowVisible(h)) return true; var sb = new StringBuilder(256); GetWindowText(h, sb, 256); if (sb.ToString().StartsWith(prefix)) { found = h; return false; } return true; }, IntPtr.Zero); return found; }',
  ' public static void Front(IntPtr h) { ShowWindowAsync(h, 9); keybd_event(0x12, 0, 0, UIntPtr.Zero); SetForegroundWindow(h); keybd_event(0x12, 0, 2, UIntPtr.Zero); SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 0x43); }',
  ' public static void Release(IntPtr h) { SetWindowPos(h, new IntPtr(-2), 0, 0, 0, 0, 0x43); }',
  '}',
].join('\n');

// holdSeconds 0 = pin: stay above other windows until Ray closes it ("display over other apps").
function raiseWindow(titlePrefix, holdSeconds) {
  const pin = holdSeconds === 0;
  const hold = Math.max(1, Math.min(60, Number(holdSeconds) || 4));
  const t = String(titlePrefix).replace(/[^\w .-]/g, '');
  if (os.platform() === 'win32') {
    const ps =
      'Add-Type -TypeDefinition @"\n' + WIN_RAISE_CS + '\n"@;' +
      '$h=[IntPtr]::Zero;$d=(Get-Date).AddSeconds(15);' +
      "while($h -eq [IntPtr]::Zero -and (Get-Date) -lt $d){$h=[RayWin]::Find('" + t + "');if($h -eq [IntPtr]::Zero){Start-Sleep -Milliseconds 300}}" +
      'if($h -ne [IntPtr]::Zero){[RayWin]::Front($h);Start-Sleep -Seconds ' + hold + ';[RayWin]::Front($h)' + (pin ? '' : ';[RayWin]::Release($h)') + '}';
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], { timeout: (hold + 25) * 1000, windowsHide: true }, () => {});
  } else if (os.platform() === 'darwin') {
    setTimeout(() => {
      for (const app of ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium']) {
        execFile('osascript', ['-e', 'if application "' + app + '" is running then tell application "' + app + '" to activate'], { timeout: 5000 }, () => {});
      }
    }, 2500);
  } else if (!IS_TERMUX) {
    let tries = 0;
    const tick = () => execFile('wmctrl', ['-a', t], { timeout: 4000 }, (err) => {
      if (err && ++tries < 10) return setTimeout(tick, 1000);
      if (!err && pin) execFile('wmctrl', ['-r', t, '-b', 'add,above'], { timeout: 4000 }, () => {});
    });
    setTimeout(tick, 1500);
  }
}

/** Opens a RAY page as its own app window (not a tab) and brings it in front of everything. */
function openRayWindow(url, titlePrefix, holdSeconds, cb) {
  const done = cb || (() => {});
  if (IS_TERMUX) {
    // Needs "Display over other apps" for Termux, otherwise Android blocks opening from the background —
    // the heads-up notification is the backup the user can tap from any app or the lock screen.
    execFile('termux-notification', ['--id', 'ray-popup', '--title', titlePrefix === 'RAY Call' ? 'RAY is calling' : 'RAY wants you', '--content', 'Tap to open RAY', '--priority', 'max', '--sound', '--vibrate', '300,200,300', '--action', 'termux-open-url "' + url + '"'], { timeout: 10000 }, () => {});
    return runSafeCommand('termux-open-url', [url], (m, ok) => done(ok ? 'RAY opened on the phone' : m, ok));
  }
  const chrome = findChromeBinary();
  if (chrome) {
    try {
      spawn(chrome, ['--app=' + url, '--window-size=470,780', '--window-position=40,40'], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
      raiseWindow(titlePrefix, holdSeconds);
      return done('RAY window opened in front', true);
    } catch (e) {}
  }
  launchUrlSafely(url, (m, ok) => {
    if (ok) raiseWindow(titlePrefix, holdSeconds);
    done(ok ? 'RAY opened in the browser' : m, ok);
  });
}

let ringProc = null;
/** PC ringtone that plays even when no browser is open (stops after ~25 s or the next call). */
function playRingtone(seconds) {
  try { if (ringProc) ringProc.kill(); } catch {}
  ringProc = null;
  const secs = Math.max(3, Math.min(45, seconds || 25));
  if (os.platform() === 'win32') {
    const wav = ['Ring06.wav', 'Ring01.wav', 'Alarm01.wav'].map((f) => path.join(process.env.WINDIR || 'C:\\Windows', 'Media', f)).find((f) => fs.existsSync(f));
    if (!wav) return;
    ringProc = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$p=New-Object Media.SoundPlayer '" + wav.replace(/'/g, "''") + "';$p.PlayLooping();Start-Sleep -Seconds " + secs + ';$p.Stop()'], { timeout: (secs + 10) * 1000, windowsHide: true }, () => {});
  } else if (os.platform() === 'darwin') {
    ringProc = execFile('sh', ['-c', 'end=$(($(date +%s)+' + secs + ')); while [ $(date +%s) -lt $end ]; do afplay /System/Library/Sounds/Glass.aiff; sleep 0.6; done'], { timeout: (secs + 5) * 1000 }, () => {});
  } else if (!IS_TERMUX) {
    ringProc = execFile('sh', ['-c', 'end=$(($(date +%s)+' + secs + ')); while [ $(date +%s) -lt $end ]; do paplay /usr/share/sounds/freedesktop/stereo/phone-incoming-call.oga 2>/dev/null || sleep 1; done'], { timeout: (secs + 5) * 1000 }, () => {});
  }
}

let lastPopupAt = 0;
function openRayPopup(reason, cb, runOn, pin) {
  const done = cb || (() => {});
  if (Date.now() - lastPopupAt < 4000) return done('Already opening', true);
  lastPopupAt = Date.now();
  const url = rayAppUrl(runOn ? { popup: 1, listen: 1, runon: runOn } : { popup: 1, listen: 1 });
  if (!url) return done('RAY URL unknown', false);
  openRayWindow(url, 'RAY Assistant', pin ? 0 : 4, (m, ok) => done(m + (reason ? ' (' + reason + ')' : '') + (pin ? ' · pinned on top' : ''), ok));
}

/** Windows: Start-menu shortcut "RAY" with the global hotkey Ctrl+Alt+R that pops RAY up. */
function installPopupShortcuts() {
  if (os.platform() !== 'win32') return;
  const chrome = findChromeBinary();
  const url = rayAppUrl({ popup: 1, listen: 1 });
  if (!chrome || !url) return;
  const lnk = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'RAY.lnk');
  const q = (s) => String(s).replace(/'/g, "''");
  const ps =
    "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('" + q(lnk) + "');" +
    "$s.TargetPath='" + q(chrome) + "';$s.Arguments='--app=" + q(url) + " --window-size=470,780';" +
    "$s.Hotkey='CTRL+ALT+R';$s.Description='RAY assistant';$s.Save()";
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 20000, windowsHide: true }, () => {});
}

/** Android: a permanent "RAY is running" notification with Open / Ask buttons. */
function showPersistentPhoneNotification() {
  if (!IS_TERMUX) return;
  const url = rayAppUrl({ popup: 1, listen: 1 });
  const talk = path.join(os.homedir(), '.shortcuts', 'Talk to RAY');
  const ask = path.join(os.homedir(), '.shortcuts', 'Ask RAY');
  const voice = fs.existsSync(talk) ? talk : ask;
  execFile('termux-notification', [
    '--id', 'ray-persistent', '--ongoing', '--priority', 'low', '--alert-once',
    '--title', 'RAY is running', '--content', 'Tap Talk to speak to RAY from anywhere',
    '--action', 'sh "' + voice + '"',
    '--button1', 'Talk', '--button1-action', 'sh "' + voice + '"',
    '--button2', 'Open RAY', '--button2-action', 'termux-open-url "' + url + '"',
  ], { timeout: 10000 }, () => {});
}

// --- Browser hands (Chrome DevTools Protocol) --------------------------------
const CDP_PORT = Number(process.env.RAY_CDP_PORT || 9333);
const cdpState = { visible: { port: CDP_PORT, current: null }, background: { port: CDP_PORT + 1, current: null } };

async function cdpJson(port, p, method) {
  const r = await fetch('http://127.0.0.1:' + port + p, { method: method || 'GET', signal: AbortSignal.timeout(4000) });
  return r.json();
}

async function ensureCdpBrowser(background) {
  const st = background ? cdpState.background : cdpState.visible;
  try { await cdpJson(st.port, '/json/version'); return st; } catch {}
  const chrome = findChromeBinary();
  if (!chrome) throw new Error('No Chrome/Edge/Brave found on this PC (set RAY_CHROME_PATH).');
  const profile = path.join(CONFIG_DIR, background ? 'browser-profile-bg' : 'browser-profile');
  fs.mkdirSync(profile, { recursive: true });
  const args = ['--remote-debugging-port=' + st.port, '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', '--disable-features=Translate'];
  const noScreen = os.platform() === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
  if (background || noScreen) args.push('--headless=new', '--window-size=1280,900');
  if (process.getuid && process.getuid() === 0) args.push('--no-sandbox');
  args.push('about:blank');
  spawn(chrome, args, { detached: true, stdio: 'ignore', windowsHide: !!background }).unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 300));
    try { await cdpJson(st.port, '/json/version'); return st; } catch {}
  }
  throw new Error('Browser did not start with remote control enabled.');
}

function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    let id = 0;
    const pending = new Map();
    sock.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id);
        if (m.error) p.rej(new Error(m.error.message)); else p.res(m.result);
      }
    });
    sock.on('error', reject);
    sock.on('open', () => resolve({
      send: (method, params) => new Promise((res, rej) => {
        const i = ++id; pending.set(i, { res, rej });
        sock.send(JSON.stringify({ id: i, method, params: params || {} }));
        setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error('Browser timeout: ' + method)); } }, 25000);
      }),
      close: () => { try { sock.close(); } catch {} },
    }));
  });
}

async function cdpPage(st, wantId) {
  const list = (await cdpJson(st.port, '/json/list')).filter((t) => t.type === 'page');
  let t = list.find((x) => x.id === (wantId || st.current)) || list[0];
  if (!t) t = await cdpJson(st.port, '/json/new?about:blank', 'PUT');
  st.current = t.id;
  return { target: t, s: await cdpConnect(t.webSocketDebuggerUrl) };
}

async function cdpEval(s, fn, arg) {
  const expr = '(' + fn.toString() + ')(' + JSON.stringify(arg === undefined ? null : arg) + ')';
  const r = await s.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('Page script error: ' + (r.exceptionDetails.text || 'unknown'));
  return r.result ? r.result.value : undefined;
}

async function cdpWaitLoad(s, ms) {
  const end = Date.now() + (ms || 15000);
  await new Promise((r) => setTimeout(r, 400));
  while (Date.now() < end) {
    try { if ((await cdpEval(s, () => document.readyState)) === 'complete') break; } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  await new Promise((r) => setTimeout(r, 500));
}

// Runs inside the page: number every visible interactive element and return the page text.
function pageReadScript() {
  document.querySelectorAll('[data-ray-id]').forEach((e) => e.removeAttribute('data-ray-id'));
  const sel = 'a[href],button,input,textarea,select,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=option],[role=searchbox],[role=textbox],[contenteditable=true],summary';
  const out = [];
  let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) continue;
    if (r.bottom < -50 || r.top > innerHeight * 2) continue;
    // Never read back what's in secret fields (passwords, one-time codes, card numbers).
    const secret = el.type === 'password' || /one-time-code|cc-|password/i.test(String(el.getAttribute('autocomplete') || ''));
    const label = String(el.getAttribute('aria-label') || el.innerText || (secret ? '' : el.value) || el.placeholder || el.title || el.name || el.alt || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    n++;
    el.setAttribute('data-ray-id', String(n));
    out.push({ i: n, tag: el.tagName.toLowerCase(), type: el.type ? String(el.type) : undefined, label, href: el.href ? String(el.href).slice(0, 120) : undefined, inView: r.top >= 0 && r.bottom <= innerHeight });
    if (n >= 140) break;
  }
  const text = (document.body ? document.body.innerText : '').replace(/\n{3,}/g, '\n\n').slice(0, 14000);
  return { title: document.title, url: location.href, text, elements: out, scrollY: Math.round(scrollY), scrollMax: Math.max(0, document.documentElement.scrollHeight - innerHeight) };
}

function pageLocateScript(q) {
  let el = q.i ? document.querySelector('[data-ray-id="' + q.i + '"]') : null;
  if (!el && q.text) {
    const want = String(q.text).toLowerCase();
    el = [...document.querySelectorAll('a,button,input,textarea,[role=button],[role=link],[role=tab],[role=menuitem],summary,label')].find((e) =>
      String(e.getAttribute('aria-label') || e.innerText || e.value || e.placeholder || '').toLowerCase().includes(want)
    ) || null;
  }
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, password: el.type === 'password', tag: el.tagName.toLowerCase() };
}

async function cdpClickAt(s, x, y) {
  await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

const CDP_KEYS = { enter: ['Enter', 13, '\r'], tab: ['Tab', 9, ''], escape: ['Escape', 27, ''], backspace: ['Backspace', 8, ''], arrowdown: ['ArrowDown', 40, ''], arrowup: ['ArrowUp', 38, ''], pagedown: ['PageDown', 34, ''], pageup: ['PageUp', 33, ''] };
async function cdpKey(s, name) {
  const k = CDP_KEYS[String(name || 'enter').toLowerCase()] || CDP_KEYS.enter;
  await s.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k[0], code: k[0], windowsVirtualKeyCode: k[1], text: k[2] || undefined });
  await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k[0], code: k[0], windowsVirtualKeyCode: k[1] });
}

async function browserAction(req) {
  if (IS_TERMUX) return { ok: false, error: 'Browser hands run on the PC bridge.' };
  const op = String(req.op || 'read');
  const background = Boolean(req.background);
  const st = await ensureCdpBrowser(background);
  if (op === 'tabs') {
    const list = (await cdpJson(st.port, '/json/list')).filter((t) => t.type === 'page');
    return { ok: true, data: { tabs: list.map((t) => ({ id: t.id, title: t.title, url: t.url, current: t.id === st.current })) } };
  }
  if (op === 'new_tab' || (op === 'open' && req.newTab)) {
    const url = req.url ? validateSafeUrl(String(req.url), true) : 'about:blank';
    const t = await cdpJson(st.port, '/json/new?' + encodeURIComponent(url), 'PUT');
    st.current = t.id;
  }
  if (op === 'close_tab') {
    await cdpJson(st.port, '/json/close/' + encodeURIComponent(String(req.tabId || st.current)));
    st.current = null;
    return { ok: true, data: { closed: true } };
  }
  const { target, s } = await cdpPage(st, req.tabId);
  try {
    if (op === 'switch_tab') await cdpJson(st.port, '/json/activate/' + target.id);
    if (op === 'open' && !req.newTab) {
      const url = validateSafeUrl(String(req.url || ''), true);
      await s.send('Page.navigate', { url });
    }
    if (op === 'open' || op === 'new_tab') await cdpWaitLoad(s, 20000);
    if (op === 'click') {
      const loc = await cdpEval(s, pageLocateScript, { i: req.i, text: req.text });
      if (!loc) return { ok: false, error: 'Element not found: ' + (req.i || req.text) };
      await new Promise((r) => setTimeout(r, 250));
      await cdpClickAt(s, loc.x, loc.y);
      await cdpWaitLoad(s, 12000);
    }
    if (op === 'type') {
      const loc = await cdpEval(s, pageLocateScript, { i: req.i, text: req.label });
      if (!loc) return { ok: false, error: 'Field not found: ' + (req.i || req.label) };
      // Password fields only take a secret Ray typed into RAY's secure approval prompt (one-time, never stored).
      if (loc.password && req.allowSecret !== true) return { ok: false, error: 'PASSWORD_FIELD: needs Ray’s approval and his password.' };
      await cdpClickAt(s, loc.x, loc.y);
      if (req.clear !== false) {
        await cdpEval(s, () => { const e = document.activeElement; if (e && 'value' in e) { e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); } else if (e && e.isContentEditable) e.textContent = ''; });
      }
      await s.send('Input.insertText', { text: String(req.value || req.textToType || '') });
      if (req.submit) { await cdpKey(s, 'enter'); await cdpWaitLoad(s, 12000); }
    }
    if (op === 'upload') {
      // Put a file from this PC into the page's upload field (post a photo/reel, attach a document).
      let filePath;
      try { filePath = resolveSafeFsPath(String(req.path || ''), true); } catch (e) { return { ok: false, error: 'File not allowed or not found: ' + e.message }; }
      if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return { ok: false, error: 'File not found: ' + req.path };
      const sel = req.i ? '[data-ray-id="' + Number(req.i) + '"]' : 'input[type=file]';
      const found = await s.send('Runtime.evaluate', {
        expression: '(() => { let e = document.querySelector(' + JSON.stringify(sel) + '); if (e && !(e.tagName === "INPUT" && e.type === "file")) e = (e.querySelector && e.querySelector("input[type=file]")) || document.querySelector("input[type=file]"); return e || document.querySelector("input[type=file]"); })()',
      });
      const objectId = found && found.result && found.result.objectId;
      if (!objectId) return { ok: false, error: 'No upload field on this page yet — click the Upload / “Select from computer” button first.' };
      await s.send('DOM.setFileInputFiles', { files: [filePath], objectId });
      await new Promise((r) => setTimeout(r, 1800));
    }
    if (op === 'front') {
      // Bring this browser window over every app so Ray can solve a CAPTCHA / take over.
      await s.send('Page.bringToFront').catch(() => {});
      const title = await cdpEval(s, () => document.title).catch(() => '');
      if (title) raiseWindow(String(title).slice(0, 24), 6);
    }
    if (op === 'key') { await cdpKey(s, req.key); await cdpWaitLoad(s, 8000); }
    if (op === 'scroll') { await cdpEval(s, (dy) => scrollBy(0, dy), Number(req.dy || 700)); await new Promise((r) => setTimeout(r, 500)); }
    if (op === 'back') { await cdpEval(s, () => history.back()); await cdpWaitLoad(s, 10000); }
    let shot;
    if (op === 'screenshot' || req.screenshot) {
      const r = await s.send('Page.captureScreenshot', { format: 'jpeg', quality: 55 });
      shot = 'data:image/jpeg;base64,' + r.data;
    }
    const page = await cdpEval(s, pageReadScript);
    return { ok: true, data: { ...page, tabId: target.id, screenshot: shot } };
  } finally {
    s.close();
  }
}

// --- Diagnose & repair -------------------------------------------------------
function execOut(cmd, args, timeout) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeout || 20000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || (err && err.message) || '').trim() })
    );
  });
}

function diskInfo() {
  const roots = os.platform() === 'win32' ? ['C:\\', os.homedir()] : IS_TERMUX ? [os.homedir(), '/storage/emulated/0'] : ['/', os.homedir()];
  const seen = new Set();
  const out = [];
  for (const r of roots) {
    try {
      const s = fs.statfsSync(r);
      const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
      const key = total + ':' + free;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ path: r, freeGb: +(free / 1e9).toFixed(1), totalGb: +(total / 1e9).toFixed(1), freePct: Math.round((free / Math.max(1, total)) * 100) });
    } catch {}
  }
  return out;
}

function dirSizeMb(dir, limit) {
  let bytes = 0, n = 0;
  const walk = (d, depth) => {
    if (n > (limit || 20000) || depth > 6) return;
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      n++;
      const p = path.join(d, e.name);
      try {
        if (e.isDirectory()) walk(p, depth + 1);
        else bytes += fs.statSync(p).size;
      } catch {}
    }
  };
  walk(dir, 0);
  return Math.round(bytes / 1e6);
}

async function diagnoseDevice() {
  const report = {
    device: DEVICE_NAME, platform: PLATFORM, bridgeVersion: BRIDGE_VERSION, uptimeHours: Math.round(os.uptime() / 360) / 10,
    disks: diskInfo(), memory: { freeMb: Math.round(os.freemem() / 1e6), totalMb: Math.round(os.totalmem() / 1e6) },
    tempMb: dirSizeMb(os.tmpdir()), issues: [],
  };
  report.memory.usedPct = Math.round((1 - report.memory.freeMb / Math.max(1, report.memory.totalMb)) * 100);
  try {
    const t0 = Date.now();
    const r = await fetch('https://www.gstatic.com/generate_204', { signal: AbortSignal.timeout(6000) });
    report.internet = { ok: r.status === 204 || r.ok, latencyMs: Date.now() - t0 };
  } catch (e) {
    report.internet = { ok: false, error: String(e.message || e).slice(0, 120) };
  }
  report.ollama = { running: ollamaState.running, models: ollamaState.models.length };
  report.topProcesses = await new Promise((res) => sampleTopProcesses((p) => res((p || []).slice(0, 8))));
  if (os.platform() === 'win32') {
    const nr = await execOut('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Process | ? { $_.MainWindowHandle -ne 0 -and -not $_.Responding } | select -ExpandProperty ProcessName']);
    report.notResponding = nr.out ? nr.out.split(/\r?\n/).filter(Boolean) : [];
    const ev = await execOut('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-WinEvent -FilterHashtable @{LogName='Application';Level=2;StartTime=(Get-Date).AddHours(-24)} -MaxEvents 40 -ErrorAction SilentlyContinue | Group-Object ProviderName | sort Count -desc | select -First 6 Count,Name | ConvertTo-Json -Compress"], 30000);
    try { report.recentAppErrors = ev.out ? [].concat(JSON.parse(ev.out)) : []; } catch { report.recentAppErrors = []; }
  }
  if (IS_TERMUX) {
    const b = await execOut('termux-battery-status', [], 8000);
    try { report.battery = JSON.parse(b.out); } catch {}
  }
  for (const d of report.disks) if (d.freePct < 10) report.issues.push('Low disk space on ' + d.path + ' (' + d.freeGb + ' GB free)');
  if (report.memory.usedPct > 90) report.issues.push('Memory almost full (' + report.memory.usedPct + '% used)');
  if (!report.internet.ok) report.issues.push('No internet from this device');
  if (report.tempMb > 2000) report.issues.push('Temp files use ' + report.tempMb + ' MB');
  if (report.notResponding && report.notResponding.length) report.issues.push('Not responding: ' + report.notResponding.join(', '));
  if (report.battery && report.battery.percentage < 15 && report.battery.status !== 'CHARGING') report.issues.push('Battery low (' + report.battery.percentage + '%)');
  return report;
}

function cleanTempFiles() {
  const dir = IS_TERMUX ? path.join(process.env.PREFIX || '', 'tmp') : os.tmpdir();
  const cutoff = Date.now() - 48 * 3600_000;
  let freed = 0, removed = 0, skipped = 0;
  const walk = (d, depth) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      try {
        const st = fs.lstatSync(p);
        if (e.isDirectory() && !st.isSymbolicLink()) { if (depth < 5) walk(p, depth + 1); try { fs.rmdirSync(p); } catch {} continue; }
        if (st.mtimeMs > cutoff) { skipped++; continue; }
        fs.unlinkSync(p); freed += st.size; removed++;
      } catch { skipped++; }
    }
  };
  walk(dir, 0);
  return { folder: dir, removedFiles: removed, freedMb: Math.round(freed / 1e6), skippedInUseOrRecent: skipped };
}

const SAFE_NAME = /^[a-zA-Z0-9 ._+-]{1,64}$/;
async function repairAction(req) {
  const fix = String(req.fix || '');
  const target = String(req.target || '').trim();
  const win = os.platform() === 'win32';
  if (fix === 'clear_temp') return { ok: true, data: cleanTempFiles() };
  if (fix === 'flush_dns') {
    const r = win ? await execOut('ipconfig', ['/flushdns']) : os.platform() === 'darwin' ? await execOut('dscacheutil', ['-flushcache']) : await execOut('resolvectl', ['flush-caches']);
    return { ok: r.ok, data: r.out.slice(0, 400), error: r.ok ? undefined : r.err.slice(0, 300) };
  }
  if (fix === 'renew_ip' && win) {
    await execOut('ipconfig', ['/release'], 30000);
    const r = await execOut('ipconfig', ['/renew'], 60000);
    return { ok: r.ok, data: 'Network address renewed', error: r.ok ? undefined : r.err.slice(0, 300) };
  }
  if (fix === 'kill_not_responding' && win) {
    const r = await execOut('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-Process | ? { $_.MainWindowHandle -ne 0 -and -not $_.Responding -and $_.ProcessName -notmatch '^(explorer|csrss|winlogon|dwm|lsass|services|svchost|System)$' } | % { $_.ProcessName; Stop-Process -Id $_.Id -Force }"]);
    return { ok: true, data: r.out ? 'Closed frozen apps: ' + r.out.split(/\r?\n/).join(', ') : 'No frozen apps found' };
  }
  if (fix === 'restart_explorer' && win) {
    await execOut('taskkill', ['/F', '/IM', 'explorer.exe']);
    spawn('explorer.exe', [], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true, data: 'Restarted Windows Explorer (taskbar/desktop)' };
  }
  if (fix === 'restart_app') {
    if (!SAFE_NAME.test(target) || isProtected(target)) return { ok: false, error: 'Cannot restart ' + target };
    const exe = target.replace(/\.exe$/i, '');
    if (win) await execOut('taskkill', ['/F', '/IM', exe + '.exe']);
    else await execOut('pkill', ['-f', exe]);
    await new Promise((r) => setTimeout(r, 1500));
    return await new Promise((res) => launchAppSafely(exe, (m, ok) => res({ ok, data: 'Restarted ' + exe + ': ' + m, error: ok ? undefined : m })));
  }
  if (fix === 'update_app') {
    if (!SAFE_NAME.test(target)) return { ok: false, error: 'Invalid app name' };
    const r = win ? await execOut('winget', ['upgrade', '--name', target, '--silent', '--accept-package-agreements', '--accept-source-agreements'], 600000)
      : IS_TERMUX ? await execOut('pkg', ['install', '-y', target], 600000)
      : os.platform() === 'darwin' ? await execOut('brew', ['upgrade', target], 600000)
      : { ok: false, out: '', err: 'Use your package manager to update ' + target };
    return { ok: r.ok, data: (r.out || '').slice(-600), error: r.ok ? undefined : (r.err || r.out).slice(-400) };
  }
  if (fix === 'restart_ollama') {
    if (win) await execOut('taskkill', ['/F', '/IM', 'ollama.exe']); else await execOut('pkill', ['-x', 'ollama']);
    ollamaState.autoStartAttempted = false;
    await ensureOllamaRunning(true);
    return { ok: true, data: 'Ollama restarted: ' + (ollamaState.running ? 'running' : 'not running') };
  }
  if (fix === 'restart_bridge') {
    setTimeout(() => process.exit(0), 1200);
    return { ok: true, data: 'RAY bridge restarting (back in ~10 s)' };
  }
  if (fix === 'self_update') return await selfUpdateBridge();
  if (fix === 'restore_file') return restoreFileVersion(String(req.path || target), req.version);
  return { ok: false, error: 'Unknown or unsupported repair on this device: ' + fix };
}

async function selfUpdateBridge() {
  try {
    const u = new URL(rayAppUrl());
    u.pathname = '/api/bridge-script';
    u.searchParams.set('token', ROOM_TOKEN);
    const r = await fetch(u.toString(), { signal: AbortSignal.timeout(30000) });
    const code = await r.text();
    if (!r.ok || !code.includes('RAY Device Bridge')) return { ok: false, error: 'Download failed (' + r.status + ')' };
    const ver = (code.match(/BRIDGE_VERSION = '([^']+)'/) || [])[1] || '?';
    const self = fileURLToPath(import.meta.url);
    fs.copyFileSync(self, self + '.bak');
    fs.writeFileSync(self, code, 'utf8');
    setTimeout(() => process.exit(0), 1500);
    return { ok: true, data: 'Updated bridge ' + BRIDGE_VERSION + ' → ' + ver + '; restarting' };
  } catch (e) {
    return { ok: false, error: 'Self-update failed: ' + (e.message || e) };
  }
}

// --- File versions: RAY backs up a file before it overwrites it ---------------
const BACKUP_DIR = path.join(CONFIG_DIR, 'file-versions');
function backupKey(p) { return crypto.createHash('sha1').update(path.resolve(p)).digest('hex').slice(0, 16); }
function backupBeforeWrite(target) {
  try {
    if (!fs.existsSync(target) || fs.statSync(target).size > 20 * 1024 * 1024) return;
    const dir = path.join(BACKUP_DIR, backupKey(target));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'path.txt'), path.resolve(target));
    fs.copyFileSync(target, path.join(dir, Date.now() + '.bak'));
    const vers = fs.readdirSync(dir).filter((f) => f.endsWith('.bak')).sort();
    for (const old of vers.slice(0, Math.max(0, vers.length - 10))) fs.unlinkSync(path.join(dir, old));
  } catch {}
}
function listFileVersions(p) {
  const dir = path.join(BACKUP_DIR, backupKey(p));
  if (!fs.existsSync(dir)) return { ok: true, data: { path: p, versions: [] } };
  const versions = fs.readdirSync(dir).filter((f) => f.endsWith('.bak')).sort().reverse().map((f) => ({ version: f.replace('.bak', ''), savedAt: new Date(Number(f.replace('.bak', ''))).toISOString(), bytes: fs.statSync(path.join(dir, f)).size }));
  return { ok: true, data: { path: p, versions } };
}
function restoreFileVersion(p, version) {
  const target = resolveSafeFsPath(p, false);
  const dir = path.join(BACKUP_DIR, backupKey(target));
  if (!fs.existsSync(dir)) return { ok: false, error: 'RAY has no saved versions of ' + target };
  const vers = fs.readdirSync(dir).filter((f) => f.endsWith('.bak')).sort();
  const pick = version ? vers.find((v) => v.startsWith(String(version))) : vers[vers.length - 1];
  if (!pick) return { ok: false, error: 'Version not found' };
  backupBeforeWrite(target);
  fs.copyFileSync(path.join(dir, pick), target);
  return { ok: true, data: { restored: target, from: new Date(Number(pick.replace('.bak', ''))).toISOString() } };
}

// --- Home Assistant (free smart-home hub) on the home network ------------------
// The cloud can't reach a LAN Home Assistant, so the PC bridge relays calls to it. Only local
// addresses and Home Assistant's /api/ paths are allowed, so this can't be used as an open proxy.
function isLocalHaUrl(raw) {
  try {
    const u = new URL(raw);
    if (!/^https?:$/.test(u.protocol)) return false;
    const h = u.hostname.toLowerCase();
    return h === 'localhost' || h === 'homeassistant' || h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.home') ||
      /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(h);
  } catch { return false; }
}
async function homeAssistantAction(req) {
  const method = String(req.method || 'GET').toUpperCase();
  const pathPart = String(req.path || '/api/');
  if (!['GET', 'POST'].includes(method) || !/^\/api\/[\w./-]*$/.test(pathPart)) return { ok: false, error: 'Only Home Assistant /api/ GET/POST calls are allowed.' };
  const candidates = req.url ? [String(req.url)] : ['http://homeassistant.local:8123', 'http://homeassistant:8123', 'http://localhost:8123'];
  for (const base of candidates) {
    if (!isLocalHaUrl(base)) return { ok: false, error: 'Home Assistant URL must be on your home network (e.g. http://homeassistant.local:8123).' };
    try {
      const r = await fetch(base.replace(/\/+$/, '') + pathPart, {
        method,
        headers: { Authorization: 'Bearer ' + String(req.token || ''), 'Content-Type': 'application/json' },
        body: method === 'POST' ? JSON.stringify(req.body || {}) : undefined,
        signal: AbortSignal.timeout(12000),
      });
      const text = await r.text();
      if (r.status === 401) return { ok: false, error: 'Home Assistant refused the token (401).' };
      if (!r.ok) return { ok: false, error: 'Home Assistant answered ' + r.status + ': ' + text.slice(0, 160) };
      let data; try { data = JSON.parse(text); } catch { data = text.slice(0, 4000); }
      return { ok: true, data: { base, result: data } };
    } catch (e) {
      if (req.url) return { ok: false, error: 'Could not reach Home Assistant at ' + base + ': ' + e.message };
    }
  }
  return { ok: false, error: 'Home Assistant not found on this network (tried homeassistant.local:8123). Enter its address in JARVIS Core → Home.' };
}

async function jarvisAction(action, req) {
  if (action === 'home_assistant') return await homeAssistantAction(req);
  if (action === 'list_contacts') return await listPhoneContacts();
  if (action === 'lookup_contact') return await new Promise((res) => lookupContactNumber(String(req.name || ''), (number, label) => res(number ? { ok: true, data: { number, name: label } } : { ok: false, error: label })));
  if (action === 'browser') return await browserAction(req);
  if (action === 'diagnose') return { ok: true, data: await diagnoseDevice() };
  if (action === 'repair') return await repairAction(req);
  if (action === 'file_versions') return listFileVersions(resolveSafeFsPath(String(req.path || ''), false));
  if (action === 'popup') return await new Promise((res) => openRayPopup(String(req.reason || ''), (m, ok) => res({ ok, data: m, error: ok ? undefined : m })));
  return null;
}

async function runBridgeAction(action, reqData) {
  try {
    const jv = await jarvisAction(action, reqData || {});
    if (jv) return jv;
    if (action === 'ollama_tags') {
      const targetBase = new URL(reqData.ollamaUrl || OLLAMA_HOST);
      if (!['127.0.0.1', 'localhost'].includes(targetBase.hostname)) {
        return { ok: false, data: null, error: 'Ollama bridge proxy only allows 127.0.0.1/localhost.' };
      }
      const safeOrigin = targetBase.origin.replace('://localhost', '://127.0.0.1');
      try {
        const r = await fetch(safeOrigin + '/api/tags', { signal: AbortSignal.timeout(6000) });
        const j = await r.json();
        // Pass Ollama's own reason ("does not support tools", "model not found"…) so RAY can adapt.
        return { ok: r.ok, data: j, error: r.ok ? undefined : 'Ollama returned ' + r.status + (j && j.error ? ': ' + String(j.error).slice(0, 300) : '') };
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
      backupBeforeWrite(target); // self-healing: every overwrite can be undone with restore_file
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
    if (action === 'list_coding_agents') {
      return { ok: true, data: { device: DEVICE_NAME, agents: await listCodingAgents() } };
    }
    if (action === 'run_coding_agent') {
      try {
        const job = await startCodingJob(String(reqData.agent || 'claude'), String(reqData.prompt || ''), reqData.cwd);
        return { ok: true, data: { jobId: job.id, agent: job.agent, cwd: job.cwd } };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
    if (action === 'coding_agent_status') {
      const jobs = Array.from(codingJobs.values()).filter((j) => !reqData.jobId || j.id === reqData.jobId).slice(-10);
      return { ok: true, data: { jobs: jobs.map((j) => ({ ...j, output: j.output.slice(reqData.jobId ? -12000 : -1500) })) } };
    }
    if (action === 'agent_screenshot') {
      return await new Promise((resolve) => agentScreenshot(reqData.target === 'phone' ? 'phone' : 'pc', (out) => resolve({ ok: out.ok, data: out, error: out.error })));
    }
    if (action === 'agent_act') {
      return await new Promise((resolve) => agentAct(reqData.target === 'phone' ? 'phone' : 'pc', reqData.step || {}, (out) => resolve({ ok: out.ok, data: out.data, error: out.error })));
    }
    if (action === 'agent_capabilities') {
      return { ok: true, data: { pc: !IS_TERMUX, phoneViaAdb: Boolean(await adbDevice()), platform: PLATFORM } };
    }
    if (action === 'open_file') {
      // Open a file with its default app — only inside the folders RAY may read, never credential files.
      const target = resolveSafeFsPath(reqData.path || reqData.filePath || '', true);
      return await new Promise((resolve) => {
        const done = (out, ok) => resolve({ ok, data: { message: ok ? 'Opened ' + path.basename(target) + ' on ' + DEVICE_NAME : out }, error: ok ? undefined : out });
        if (IS_TERMUX) return runSafeCommand('termux-open', [target], done);
        if (os.platform() === 'darwin') return runSafeCommand('open', [target], done);
        if (os.platform() === 'win32') return runSafeCommand('explorer.exe', [target], (out) => done(out, true));
        runSafeCommand('xdg-open', [target], done);
      });
    }
    if (action === 'file_index') {
      return { ok: true, data: buildFileIndex(Math.min(15000, Number(reqData.maxEntries || 6000)), Math.min(10, Number(reqData.maxDepth || 6))) };
    }
    if (action === 'battery') {
      if (IS_TERMUX) {
        return await new Promise((resolve) => execFile('termux-battery-status', [], { timeout: 8000 }, (err, out) => {
          if (err) return resolve({ ok: false, error: 'Battery status needs Termux:API.' });
          try { const j = JSON.parse(out); resolve({ ok: true, data: { percentage: j.percentage, charging: /CHARG/i.test(j.status || '') } }); } catch { resolve({ ok: false, error: 'Unreadable battery status' }); }
        }));
      }
      return { ok: false, error: 'Battery level is only available from the phone bridge.' };
    }
    if (action === 'lan_status') {
      return { ok: true, data: { linked: Boolean(lanLink && lanLink.readyState === WebSocket.OPEN), peer: lanPeerName, cloud: Boolean(activeWs && activeWs.readyState === WebSocket.OPEN) } };
    }
    if (action === 'ask') {
      return { ok: true, data: await askRay(String(reqData.text || '')) };
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

    if (req.method === 'POST' && urlObj.pathname === '/ask') {
      let body = '';
      for await (const c of req) { body += c; if (body.length > 20000) break; }
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch {}
      let out;
      try {
        out = await askRay(String(parsed.text || ''), String(parsed.target || ''));
        speakIfAsked(out.answer, parsed.speak);
      } catch (e) {
        out = { answer: 'RAY hit an error: ' + (e && e.message ? e.message : e), via: 'error' };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
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

// ---------------------------------------------------------------------------
// Offline local mode (no internet). Works over ANY local link between phone and PC:
// same Wi-Fi, phone hotspot, Bluetooth tethering (PAN) or USB tethering — no internet needed.
// Every bridge feature travels over it in both directions: open apps/links, ring & dial,
// notifications, clipboard, WhatsApp/Instagram relay, phone status, files, Ask RAY.
// ---------------------------------------------------------------------------

const ROOM_TAG = crypto.createHash('sha256').update('ray-lan:' + ROOM_ID).digest('hex').slice(0, 12);
const SELF_KIND = IS_TERMUX ? 'phone' : 'pc';
let lanLink = null; // socket to the other device (phone: PC hub; PC: connected phone)
let lanPeerName = '';
const lanPending = new Map();
const lanInbox = []; // messages relayed from the phone while offline (newest first)

function speakIfAsked(text, speak) {
  if (speak && text) speakNative(String(text).slice(0, 600), () => {});
}

function lanSend(msg) {
  if (!lanLink || lanLink.readyState !== WebSocket.OPEN) return false;
  lanLink.send(JSON.stringify(msg));
  return true;
}

function lanRequest(msg, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    if (!lanSend({ ...msg, id })) return resolve({ ok: false, error: 'Your ' + (SELF_KIND === 'pc' ? 'phone' : 'PC') + ' is not connected on the local network.' });
    const t = setTimeout(() => { lanPending.delete(id); resolve({ ok: false, error: 'No reply from ' + (lanPeerName || 'the other device') + '.' }); }, timeoutMs);
    lanPending.set(id, (r) => { clearTimeout(t); resolve(r.ok === false && !r.error ? { ...r, error: r.message || 'Failed on ' + (lanPeerName || 'the other device') } : r); });
  });
}

/** Handle a message from the other device (same protocol on both sides). */
async function handleLanMessage(sock, raw) {
  let m = {};
  try { m = JSON.parse(String(raw)); } catch { return; }
  const reply = (data) => { if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ ...data, id: m.id, type: 'reply' })); };
  if (m.type === 'reply' && lanPending.has(m.id)) {
    lanPending.get(m.id)(m);
    lanPending.delete(m.id);
  } else if (m.type === 'hello') {
    lanPeerName = String(m.name || 'device');
    console.log('[RAY LAN] Linked with ' + lanPeerName + ' over the local network (works without internet).');
  } else if (m.type === 'ask') {
    reply({ ok: true, answer: await answerLocally(m.text, true) });
  } else if (m.type === 'command') {
    executeDeviceCommand(
      { id: m.id, type: m.cmd?.type, payload: m.cmd?.payload || {} },
      (status, message, data) => reply({ ok: status !== 'failed', status, message, data, error: status === 'failed' ? message : undefined }),
      null
    );
  } else if (m.type === 'proxy') {
    reply(await runBridgeAction(String(m.action || ''), m.args || {}));
  } else if (m.type === 'messages') {
    for (const it of (m.items || []).slice(0, 20)) {
      lanInbox.unshift(it);
      showNativeNotification((it.app || 'Message') + ' · ' + (it.from || ''), String(it.text || '').slice(0, 160), () => {});
    }
    lanInbox.splice(50);
  }
}

function deviceFromText(q) {
  if (/\b(on|to|from)\s+(my\s+)?(phone|mobile|android)\b/i.test(q)) return 'phone';
  if (/\b(on|to|from)\s+(my\s+)?(pc|computer|laptop|desktop)\b/i.test(q)) return 'pc';
  return null;
}

/** Run an action on whichever device the user meant: here, or the other one over the local link. */
async function onDevice(target, action, args) {
  if (!target || target === SELF_KIND) return runBridgeAction(action, args);
  const r = await lanRequest({ type: 'proxy', action, args }, 45000);
  return r;
}

/**
 * Answer with NO cloud. Deterministic intents for every cross-device feature first,
 * then the local model (Ollama on the PC). `fromPeer` = asked by the other device.
 */
async function answerLocally(text, fromPeer = false) {
  const q = String(text || '').trim().replace(/[.!?]+$/, '');
  const target = deviceFromText(q);
  const strip = (x) => x.replace(/\s+(on|to|from)\s+(my\s+)?(phone|mobile|android|pc|computer|laptop|desktop)\s*$/i, '').trim();
  let m;

  if ((m = q.match(/^(?:call|dial|phone)\s+(.+)$/i)) && !/^(me|my phone|my pc)$/i.test(strip(m[1]))) {
    const r = await onDevice('phone', 'place_call', { to: strip(m[1]) });
    return r.ok ? (r.data?.message || 'Calling ' + strip(m[1]) + '.') : 'Could not call: ' + r.error;
  }
  if (/\b(ring|find)\s+(my\s+)?(phone|mobile)\b|\bwhere'?s my phone\b/i.test(q)) {
    if (SELF_KIND === 'phone') { ringThisDevice({ kind: 'ray', message: 'Here I am!' }, () => {}); return 'Ringing this phone.'; }
    const r = await lanRequest({ type: 'command', cmd: { type: 'call', payload: { kind: 'ray', fromName: DEVICE_NAME, message: 'Your PC is looking for this phone.' } } });
    return r.ok ? 'Ringing your phone.' : r.error;
  }
  if ((m = q.match(/^(?:open|launch|start)\s+(.+)$/i))) {
    const what = strip(m[1]);
    const r = await onDevice(target, 'open_app', { target: what });
    return r.ok ? 'Opening ' + what + (target && target !== SELF_KIND ? ' on your ' + target : '') + '.' : 'Could not open ' + what + ': ' + r.error;
  }
  if ((m = q.match(/^(?:play|watch)\s+(.+?)(?:\s+on\s+youtube)?$/i)) || (m = q.match(/^search\s+youtube\s+for\s+(.+)$/i))) {
    const r = await onDevice(target, 'open_url', { url: 'https://www.youtube.com/results?search_query=' + encodeURIComponent(strip(m[1])) });
    return r.ok ? 'Opening YouTube for ' + strip(m[1]) + ' (needs internet on that device to play).' : r.error;
  }
  if ((m = q.match(/^(?:send|copy|share)\s+["“]?(.+?)["”]?\s+to\s+(?:my\s+)?(phone|mobile|pc|computer|laptop)$/i))) {
    const dest = /phone|mobile/i.test(m[2]) ? 'phone' : 'pc';
    const cmd = { type: 'clipboard', payload: { content: m[1], label: 'From ' + DEVICE_NAME } };
    const r = dest === SELF_KIND ? await new Promise((res) => executeDeviceCommand(cmd, (st, msg) => res({ ok: st !== 'failed', message: msg }), null)) : await lanRequest({ type: 'command', cmd });
    if (dest !== SELF_KIND) lanSend({ type: 'command', cmd: { type: 'notify', payload: { title: 'RAY · clipboard', message: m[1].slice(0, 120) } } });
    return r.ok ? 'Sent to your ' + dest + "'s clipboard." : r.error;
  }
  if ((m = q.match(/^(?:tell|notify|remind)\s+(?:my\s+)?(phone|mobile|pc|computer|laptop)\s+(?:that\s+)?(.+)$/i))) {
    const dest = /phone|mobile/i.test(m[1]) ? 'phone' : 'pc';
    const cmd = { type: 'notify', payload: { title: 'RAY', message: m[2] } };
    if (dest === SELF_KIND) { showNativeNotification('RAY', m[2], () => {}); return 'Done.'; }
    const r = await lanRequest({ type: 'command', cmd });
    return r.ok ? 'Sent to your ' + dest + '.' : r.error;
  }
  if (/\b(messages?|whatsapp|instagram|sms|texts?)\b/i.test(q) && /\b(any|new|read|latest|unread|check|show)\b/i.test(q)) {
    let items = [];
    if (SELF_KIND === 'phone') items = await readChatNotifications(true);
    else {
      const r = await lanRequest({ type: 'proxy', action: 'read_notifications', args: {} });
      items = r.ok ? r.data?.items || [] : lanInbox;
    }
    if (!items.length) return 'No new messages.';
    return items.slice(0, 5).map((it) => (it.app || '') + ' from ' + (it.from || 'someone') + ': ' + String(it.text || '').slice(0, 100)).join('. ');
  }
  if (/\bbattery\b/i.test(q)) {
    const r = await onDevice(target || 'phone', 'battery', {});
    return r.ok ? 'Battery is at ' + r.data?.percentage + '%' + (r.data?.charging ? ' and charging.' : '.') : r.error;
  }
  if ((m = q.match(/^(?:what'?s in|list|show)\s+(?:my\s+)?(downloads|documents|desktop)(?:\s+folder)?/i))) {
    const r = await onDevice(target, 'fs_list_dir', { dirPath: m[1].toLowerCase(), limit: 15 });
    return r.ok ? 'In ' + m[1] + ': ' + (r.data?.items || []).slice(0, 15).map((i) => i.name).join(', ') : r.error;
  }
  if (/\b(time|date)\b/i.test(q) && q.length < 40) return 'It is ' + new Date().toLocaleString() + '.';

  // Free-form question: local model on the PC (the phone forwards it there).
  if (SELF_KIND === 'phone' && !fromPeer) {
    const r = await lanRequest({ type: 'ask', text: q }, 90000);
    return r.ok ? r.answer : "I'm offline and can't reach your PC. Link them with Wi-Fi, hotspot, Bluetooth tethering or USB tethering.";
  }
  const up = await ensureOllamaRunning(true);
  if (!up || !ollamaState.models.length) {
    return "I'm offline and this computer has no local model. Install Ollama and run: ollama pull llama3.2 — device commands (open, call, ring, send, messages, battery, files) still work offline.";
  }
  const model = ollamaState.models.find((x) => /llama3\.2|qwen|gemma|phi|mistral/i.test(x)) || ollamaState.models[0];
  const out = await runBridgeAction('ollama_chat', {
    body: { model, stream: false, messages: [
      { role: 'system', content: "You are RAY, a concise personal assistant running OFFLINE on the user's computer. Answer in 1-3 short spoken sentences." },
      { role: 'user', content: q },
    ] },
  });
  return out.ok ? String(out.data?.message?.content || '').trim() || 'Done.' : 'Local model error: ' + out.error;
}

/** Ask path: cloud RAY when online → offline local handling (both devices) otherwise. */
async function askRay(text, target) {
  if (activeWs && activeWs.readyState === WebSocket.OPEN) {
    try {
      const r = await fetch(RAY_WEB_ORIGIN + '/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Relay-Room-Token': ROOM_TOKEN },
        body: JSON.stringify({ roomId: ROOM_ID, sourceDeviceName: DEVICE_NAME, message: text + '\n\n(Voice: answer in 1-3 short spoken sentences.)', engine: { provider: 'auto' }, targetDeviceHint: target || undefined }),
        signal: AbortSignal.timeout(60000),
      });
      const raw = await r.text();
      let answer = '';
      for (const chunk of raw.split('\n\n')) {
        if (!chunk.startsWith('data: ')) continue;
        try {
          const ev = JSON.parse(chunk.slice(6));
          if (ev.type === 'text') answer = String(ev.data || '');
          if (ev.type === 'error' && !answer) answer = 'Sorry: ' + ev.data;
        } catch {}
      }
      if (answer) return { answer, via: 'cloud' };
    } catch {}
  }
  return { answer: await answerLocally(text), via: lanLink && lanLink.readyState === WebSocket.OPEN ? 'offline-link' : 'offline-local' };
}

function attachLanSocket(sock) {
  lanLink = sock;
  sock.send(JSON.stringify({ type: 'hello', name: DEVICE_NAME, kind: SELF_KIND }));
  sock.on('message', (raw) => void handleLanMessage(sock, raw));
  sock.on('close', () => { if (lanLink === sock) { lanLink = null; lanPeerName = ''; } });
  sock.on('error', () => {});
}

/** PC side: local hub (WebSocket, token-protected) + UDP discovery responder. */
function startLanHub() {
  if (IS_TERMUX || /^(0|false|off)$/i.test(process.env.RAY_LAN || '')) return;
  try {
    const wss = new WebSocketServer({ host: '0.0.0.0', port: LAN_PORT });
    wss.on('connection', (sock, req) => {
      const u = new URL(req.url || '/', 'http://lan');
      if (u.searchParams.get('token') !== ROOM_TOKEN) return sock.close(4001, 'bad token');
      attachLanSocket(sock);
    });
    wss.on('error', (e) => console.warn('[RAY LAN] hub not started:', e.message));
    const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    udp.on('message', (msg, rinfo) => {
      if (String(msg) === 'RAY-DISCOVER ' + ROOM_TAG) udp.send('RAY-HERE ' + ROOM_TAG + ' ' + LAN_PORT, rinfo.port, rinfo.address);
    });
    udp.on('error', () => {});
    udp.bind(LAN_DISCOVERY_PORT);
    console.log('[RAY LAN] Offline hub listening on port ' + LAN_PORT + ' (discovery ' + LAN_DISCOVERY_PORT + ').');
  } catch (e) {
    console.warn('[RAY LAN] could not start:', e.message);
  }
}

/** Phone side: find the PC hub on any local link and stay connected. */
function startLanClient() {
  if (!IS_TERMUX || /^(0|false|off)$/i.test(process.env.RAY_LAN || '')) return;
  const connectTo = (host, port) => {
    const ws = new WebSocket('ws://' + host + ':' + port + '/?token=' + encodeURIComponent(ROOM_TOKEN));
    ws.on('open', () => attachLanSocket(ws));
    ws.on('error', () => {});
  };
  const discover = () => {
    if (lanLink && (lanLink.readyState === WebSocket.OPEN || lanLink.readyState === WebSocket.CONNECTING)) return;
    // Optional fixed address (e.g. the PC's Bluetooth-PAN or USB-tether IP).
    if (process.env.RAY_LAN_HOST) return connectTo(process.env.RAY_LAN_HOST, LAN_PORT);
    const udp = dgram.createSocket('udp4');
    udp.on('error', () => { try { udp.close(); } catch {} });
    udp.on('message', (msg, rinfo) => {
      const parts = String(msg).split(' ');
      if (parts[0] !== 'RAY-HERE' || parts[1] !== ROOM_TAG) return;
      try { udp.close(); } catch {}
      connectTo(rinfo.address, Number(parts[2]) || LAN_PORT);
    });
    udp.bind(() => {
      try {
        udp.setBroadcast(true);
        udp.send('RAY-DISCOVER ' + ROOM_TAG, LAN_DISCOVERY_PORT, '255.255.255.255');
      } catch {}
      setTimeout(() => { try { udp.close(); } catch {} }, 3000);
    });
  };
  discover();
  setInterval(discover, 15000);
}

let activeWs = null;
function startNotificationRelay() {
  if (!IS_TERMUX) return;
  setInterval(async () => {
    const cloudUp = activeWs && activeWs.readyState === WebSocket.OPEN;
    if (!cloudUp) {
      // Offline: relay new chats to the PC over the local link instead.
      if (lanLink && lanLink.readyState === WebSocket.OPEN) {
        const offlineItems = await readChatNotifications(false);
        if (offlineItems.length) lanSend({ type: 'messages', items: offlineItems });
      }
      return;
    }
    const items = await readChatNotifications(false);
    if (items.length) activeWs.send(JSON.stringify({ event: 'messages:incoming', data: { items } }));
  }, 12000);
}

/**
 * Execute a device command (open_url, notify, clipboard, speak, call, bridge_command…).
 * Shared by the cloud connection AND the offline local link, so every feature works both ways.
 */
function executeDeviceCommand(cmd, ack, ws) {
  const platform = os.platform();
  if (cmd.type === 'open_url' && cmd.payload?.url) {
    try {
      const safeUrl = validateSafeUrl(cmd.payload.url, true);
      const want = String(cmd.payload.browser || '').toLowerCase().replace(/[^a-z]/g, '');
      launchUrlInBrowser(safeUrl, want, (out, ok, note) =>
        ack(ok ? 'completed' : 'failed', ok ? 'Opened ' + safeUrl + ' in a new ' + (want && !note ? want.charAt(0).toUpperCase() + want.slice(1) + ' ' : 'browser ') + 'tab on ' + DEVICE_NAME + (note ? ' (' + note + ')' : '') : 'Could not open URL: ' + out)
      );
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
  } else if (cmd.type === 'ask') {
    ack('completed', 'Asking Ray on ' + DEVICE_NAME);
    void askOnThisDevice(cmd.payload || {});
  } else if (cmd.type === 'wake') {
    if (cmd.payload && cmd.payload.listen && IS_TERMUX) {
      // Shared mic: this phone listens and what it hears is carried out on the device that asked.
      const talk = path.join(os.homedir(), '.shortcuts', 'Talk to RAY');
      const runOn = String(cmd.payload.runOn || '').replace(/[^\w .()-]/g, '').slice(0, 80);
      if (fs.existsSync(talk)) {
        spawn('sh', [talk], { detached: true, stdio: 'ignore', env: { ...process.env, RAY_RUN_ON: runOn } }).unref();
        ack('completed', DEVICE_NAME + ' is listening' + (runOn ? ' for ' + runOn : ''));
      } else ack('failed', 'Talk shortcut missing on ' + DEVICE_NAME);
    } else if (cmd.payload && cmd.payload.popup) openRayPopup(String(cmd.payload.reason || ''), (m) => ack('completed', DEVICE_NAME + ': ' + m), cmd.payload.listen ? String(cmd.payload.runOn || '') : '', Boolean(cmd.payload.pin));
    else ack('completed', DEVICE_NAME + ' is awake');
  } else if (cmd.type === 'refresh_telemetry') {
    sampleTopProcesses((procs) => {
      const t = getTelemetry(procs);
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event: 'device:telemetry', data: { id: DEVICE_ID, telemetry: t } }));
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
          'adjust_volume', 'obsidian-vault', 'ollama-proxy', 'fs-sandbox', 'wake-on-lan', 'chat-compose', 'calls', 'coding-agents',
        ];
        caps.push('diagnose', 'repair', 'popup', 'file-versions', 'ask');
        if (!IS_TERMUX) caps.push('home-assistant');
        if (IS_TERMUX) caps.push('notifications-relay');
        else caps.push('screen-control', 'clean_slate', 'optimize_system', 'computer-use', 'browser-agent');
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
            telemetry: { ...getTelemetry(procs), bridgeVersion: BRIDGE_VERSION, ollamaRunning: ollamaState.running, ollamaModels: ollamaState.models, installedAppCount: apps.length },
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

      executeDeviceCommand(cmd, ack, ws);
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
startLanHub();
startLanClient();
startNotificationRelay();
connect();

// Always there: phone keeps a "RAY is running" notification; PC gets Ctrl+Alt+R and pops RAY up
// after boot so "Hey Ray" works right away (set RAY_POPUP_ON_BOOT=0 to turn that off).
if (IS_TERMUX) {
  try { writePhoneShortcuts(process.execPath, process.argv[1]); } catch {}
}
showPersistentPhoneNotification();
setInterval(showPersistentPhoneNotification, 30 * 60_000).unref?.();
installPopupShortcuts();
if (!IS_TERMUX && process.env.RAY_POPUP_ON_BOOT !== '0' && os.uptime() < 15 * 60 && !loadSavedBridgeConfig().popupShownBoot?.startsWith(String(Math.round(Date.now() / 1000 - os.uptime())).slice(0, 7))) {
  setTimeout(() => {
    saveBridgeConfig({ popupShownBoot: String(Math.round(Date.now() / 1000 - os.uptime())) });
    openRayPopup('startup');
  }, 20000);
}
