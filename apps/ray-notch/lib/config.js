// Where RAY Notch finds its room (written by the PC bridge when it installs the notch) and its own
// settings (look, wake phrase, voice, hotkeys…). Settings also sync with RAY's web app (ui-prefs).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const BRIDGE_DIR = path.join(os.homedir(), '.ray-bridge');

/** { hub: 'https://ray-hub.onrender.com', roomId, token, localPort } from the bridge. */
function loadLink() {
  const env = process.env;
  if (env.RAY_NOTCH_HUB && env.RAY_NOTCH_ROOM && env.RAY_NOTCH_TOKEN) {
    return { hub: env.RAY_NOTCH_HUB.replace(/\/+$/, ''), roomId: env.RAY_NOTCH_ROOM, token: env.RAY_NOTCH_TOKEN, localPort: Number(env.RAY_NOTCH_LOCAL_PORT || 17345) };
  }
  try {
    const j = JSON.parse(fs.readFileSync(path.join(BRIDGE_DIR, 'notch.json'), 'utf8'));
    if (j.hub && j.roomId && j.token) return { hub: String(j.hub).replace(/\/+$/, ''), roomId: j.roomId, token: j.token, localPort: Number(j.localPort || 17345) };
  } catch {
    // not linked yet
  }
  return null;
}

const DEFAULTS = {
  style: 'eyes', // eyes | ring | bars
  color: 'cyan', // cyan | white | blue | green | yellow | orange | pink | purple
  wakeEnabled: true,
  wakePhrases: ['hey ray'],
  stt: 'stt-fast', // stt-fast | stt-accurate | stt-multilingual
  voice: 'voice-alan', // voice-alan | voice-jenny | voice-amy
  speakAnswers: true,
  followUp: true, // keep listening a few seconds after answering, no wake word needed
  hotkeyCommand: 'RightCtrl',
  hotkeyDictate: 'RightAlt',
  apps: ['Chrome', 'Spotify', 'File Explorer', 'Calculator'],
  waterEveryMin: 0, // 0 = off
  focusMin: 25,
  breakMin: 5,
  startWithPc: true,
};

function settingsPath(userData) {
  return path.join(userData, 'settings.json');
}
function loadSettings(userData) {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsPath(userData), 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}
function saveSettings(userData, s) {
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(settingsPath(userData), JSON.stringify(s, null, 2));
}

/** Notch's own small local data: lists, reminders, shelf (never uploaded). */
function dataStore(userData) {
  const file = path.join(userData, 'data.json');
  let data = { todos: [], shelf: [], waterToday: { day: '', glasses: 0 } };
  try {
    data = { ...data, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    // first run
  }
  return {
    get: () => data,
    save: () => {
      try {
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
      } catch {
        // disk full / read-only
      }
    },
  };
}

module.exports = { loadLink, loadSettings, saveSettings, dataStore, DEFAULTS, BRIDGE_DIR };
