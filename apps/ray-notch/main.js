// RAY Notch — RAY in a small black notch at the top of the screen, above every app.
// Say "Hey Ray" (or hold Right Ctrl) to command, hold Right Alt to dictate into any app, tap the pen to
// write. Speech runs offline on this PC; answers come from RAY (free cloud engines) or, offline, from
// the PC bridge and local Ollama.
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain, screen, clipboard, powerSaveBlocker, desktopCapturer, shell, nativeImage, Menu } = require('electron');
const { loadLink, loadSettings, saveSettings, dataStore } = require('./lib/config.js');
const { RayLink } = require('./lib/hub.js');
const { parseIntent, wantsScreen } = require('./lib/brain.js');
const { cleanDictation } = require('./lib/dictate.js');
const sys = require('./lib/system.js');
const { modelStatus } = require('./lib/models.js');

if (!app.requestSingleInstanceLock()) app.quit();
app.commandLine.appendSwitch('disable-renderer-backgrounding');

const W = 760; // window holds the largest card; everything outside the notch is click-through
const H = 600;
let win = null;
let settings = null;
let store = null;
let ray = null;
let voice = null;
let voiceError = '';
let hook = null;
let awakeId = null;
let awakeTimer = null;
const nowPlaying = new sys.NowPlaying();
let lyrics = null;
let history = [];
let busy = null; // AbortController of the running request
let approvalPending = false;

const send = (ch, data) => win && !win.isDestroyed() && win.webContents.send(ch, data);
const ui = (state) => send('state', state);
const modelsDir = () => process.env.RAY_NOTCH_MODELS || path.join(app.getPath('userData'), 'models');

function placeWindow() {
  const d = screen.getPrimaryDisplay();
  const x = Math.round(d.bounds.x + (d.bounds.width - W) / 2);
  win.setBounds({ x, y: d.bounds.y, width: W, height: H });
}

function createWindow() {
  win = new BrowserWindow({
    width: W,
    height: H,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    fullscreenable: false,
    show: false,
    title: 'RAY Notch',
    backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  // Above every app, full-screen ones included, on every desktop.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });
  placeWindow();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.showInactive()); // never steals focus from the app Ray is in
  screen.on('display-metrics-changed', placeWindow);
  // Something else grabbed the top spot (e.g. a full-screen game): take it back.
  setInterval(() => win && !win.isDestroyed() && win.setAlwaysOnTop(true, 'screen-saver'), 15_000).unref?.();
}

// --- voice -----------------------------------------------------------------------------------------
async function startVoice() {
  try {
    const { VoiceEngine } = require('./lib/voice.js');
    voice = new VoiceEngine({ modelsDir: modelsDir(), stt: settings.stt, voice: settings.voice, wakePhrases: settings.wakePhrases });
    voice.wakeEnabled = settings.wakeEnabled;
    await voice.init((p) => ui({ phase: 'setup', text: `Setting up RAY's offline voice — ${p.label}`, progress: p.progress }));
    voice.on('wake', () => ui({ phase: 'listening', mode: 'command', text: '' }));
    voice.on('listening', (mode) => ui({ phase: 'listening', mode, text: '' }));
    voice.on('partial', (text, mode) => ui({ phase: 'listening', mode, text }));
    voice.on('final', (text, mode) => void onUtterance(text, mode));
    voiceError = '';
    ui({ phase: 'idle' });
  } catch (e) {
    voice = null;
    voiceError = `Offline voice unavailable: ${e.message}`;
    ui({ phase: 'idle', note: voiceError });
  }
}

async function onUtterance(text, mode) {
  if (!text) return ui({ phase: 'idle' });
  if (mode === 'dictate') {
    const clean = cleanDictation(text);
    if (clean) await typeIntoApp(clean);
    return ui({ phase: 'done', text: clean ? `Typed: ${clean.slice(0, 80)}` : 'Didn’t catch that.', mode: 'dictate' });
  }
  await handleCommand(text, { spoken: true });
}

function speak(text) {
  if (!settings.speakAnswers || !voice || !text) return;
  try {
    const a = voice.speak(text.replace(/[*_#`>]/g, '').slice(0, 600));
    send('play', { samples: Array.from(a.samples), sampleRate: a.sampleRate });
  } catch {
    // voice not ready
  }
}

// --- typing into the app Ray is in -------------------------------------------------------------------
async function typeIntoApp(text) {
  const before = clipboard.readText();
  clipboard.writeText(text);
  shelfSkip = text;
  await new Promise((r) => setTimeout(r, 60));
  try {
    const { uIOhook, UiohookKey } = require('uiohook-napi');
    uIOhook.keyTap(UiohookKey.V, [process.platform === 'darwin' ? UiohookKey.Meta : UiohookKey.Ctrl]);
  } catch {
    if (ray) await ray.action('press_hotkey', { keys: process.platform === 'darwin' ? 'cmd+v' : 'ctrl+v' });
  }
  setTimeout(() => {
    shelfSkip = before;
    clipboard.writeText(before);
  }, 900);
}

// --- commands --------------------------------------------------------------------------------------
async function handleCommand(text, { spoken = false } = {}) {
  ui({ phase: 'working', text });
  const intent = parseIntent(text);
  try {
    if (intent) {
      const said = await runIntent(intent, text);
      if (said !== null) {
        ui({ phase: 'done', text: said });
        if (spoken) speak(said);
        return;
      }
    }
    approvalPending = false;
    const answer = await askRay(text, intent);
    if (approvalPending) {
      // The Yes / Not now card stays up until Ray answers it.
      if (spoken) speak('I need your OK for that.');
      return;
    }
    if (answer) {
      ui({ phase: 'answer', text: answer, question: text });
      if (spoken) speak(answer);
    }
  } catch (e) {
    const msg = /abort/i.test(String(e && e.name)) ? 'That took too long, so I stopped. Try again.' : `Sorry — ${e.message || e}`;
    ui({ phase: 'answer', text: msg, question: text });
  }
}

/** Runs an offline quick command. Returns what to say, or null to hand the request to RAY. */
async function runIntent(i, text) {
  switch (i.kind) {
    case 'timer':
      send('widget', { type: 'timer', seconds: i.seconds, label: i.label || '' });
      return `Timer set for ${fmtDuration(i.seconds)}${i.label ? ` — ${i.label}` : ''}.`;
    case 'timer-cancel':
      send('widget', { type: 'timer-cancel' });
      return 'Timers cleared.';
    case 'stopwatch':
      send('widget', { type: 'stopwatch' });
      return 'Stopwatch started.';
    case 'stopwatch-stop':
      send('widget', { type: 'stopwatch-stop' });
      return 'Stopwatch stopped.';
    case 'focus':
      send('widget', { type: 'focus', minutes: i.minutes || settings.focusMin, breakMin: settings.breakMin });
      return `Focus for ${i.minutes || settings.focusMin} minutes. I'll call a break.`;
    case 'focus-stop':
      send('widget', { type: 'focus-stop' });
      return 'Focus session ended.';
    case 'awake':
      keepAwake(i.minutes);
      return `Keeping your PC awake for ${fmtDuration(i.minutes * 60)}.`;
    case 'awake-off':
      keepAwake(0);
      return 'Your PC can sleep again.';
    case 'todo-add': {
      store.get().todos.push({ id: Date.now(), text: i.text, done: false, at: Date.now() });
      store.save();
      send('todos', store.get().todos);
      send('widget', { type: 'show', panel: 'list' });
      return `Added ${i.text}.`;
    }
    case 'todo-done': {
      const t = store.get().todos.find((x) => !x.done && x.text.toLowerCase().includes(i.text.toLowerCase()));
      if (!t) return `${i.text} isn't on your list.`;
      t.done = true;
      t.doneAt = Date.now();
      store.save();
      send('todos', store.get().todos);
      return `Ticked off ${t.text}.`;
    }
    case 'todo-show':
      send('widget', { type: 'show', panel: 'list' });
      return '';
    case 'volume':
      return sys.setVolume(i.level);
    case 'volume-step':
      return sys.volumeStep(i.dir);
    case 'mute':
      return sys.mute();
    case 'media':
      return sys.media(i.action);
    case 'lyrics':
      send('widget', { type: 'show', panel: 'music', lyrics: true });
      return nowPlaying.current ? '' : 'Nothing is playing right now.';
    case 'lock':
      return sys.lock();
    case 'dark':
      return sys.darkMode(i.on);
    case 'brightness':
      return sys.brightness(i.level);
    case 'settings':
      return sys.openSettings(i.page);
    case 'say':
      return i.text;
    case 'battery':
      send('widget', { type: 'battery' });
      return '';
    case 'water':
      logWater();
      return `Logged. ${store.get().waterToday.glasses} glass${store.get().waterToday.glasses === 1 ? '' : 'es'} today.`;
    case 'type':
      await typeIntoApp(i.text);
      return `Typed it.`;
    case 'write': {
      const draft = await writeDraft(i.what);
      if (!draft) return 'I couldn’t write that right now.';
      await typeIntoApp(draft);
      addShelf({ type: 'text', text: draft });
      return 'Written. It’s on your Shelf too.';
    }
    case 'open-app': {
      if (!ray) return null;
      const r = await ray.action('open_app', { target: i.app });
      return r.ok ? `Opening ${titleCase(i.app)}.` : null; // bridge missing -> let RAY try
    }
    case 'screen': {
      // Capture screen then send to RAY (online) or the local bridge (offline).
      ui({ phase: 'working', text: i.question, step: 'Taking a screenshot…' });
      const att = await screenAttachment();
      if (!att) return 'I could not capture the screen.';
      if (!ray || !ray.online) {
        // Offline: ask the local SmolVLM2 via the bridge /ask endpoint.
        try {
          const j = await ray.bridge('/ask', { text: i.question, image: att[0].dataBase64 });
          return String(j.answer || 'I see your screen but could not interpret it offline.');
        } catch { return "I'm offline — the PC bridge isn't running."; }
      }
      return await ray.chat(i.question, { attachments: att, history: [] });
    }
    default:
      return null;
  }
}

async function writeDraft(what) {
  const prompt = `Write ${what}. Reply with ONLY the text to insert — in Ray's own voice, ready to send, no preamble, no quotes, no sign-off unless asked.`;
  if (ray && ray.online) {
    try {
      return (await ray.chat(prompt, { history: [] })).trim();
    } catch {
      // fall through to offline
    }
  }
  return ray ? (await ray.askOffline(prompt)).trim() : '';
}

async function askRay(text, intent) {
  if (!ray) return 'RAY Notch isn’t linked to your RAY yet — install it from RAY (JARVIS Core → RAY Notch) so it knows your room.';
  if (busy) busy.abort();
  busy = new AbortController();
  // Like Nixi: a request that runs over ~3 minutes stops instead of hanging the notch.
  const guard = setTimeout(() => busy && busy.abort(), 3 * 60_000);
  try {
    if (!ray.online) {
      ui({ phase: 'working', text, step: 'Offline — answering on this PC' });
      return await ray.askOffline(text);
    }
    let attachments;
    if (wantsScreen(text)) {
      ui({ phase: 'working', text, step: 'Looking at your screen' });
      attachments = await screenAttachment();
    }
    const answer = await ray.chat(text, {
      history: history.slice(-6),
      attachments,
      signal: busy.signal,
      onEvent: (ev) => {
        if (ev.type === 'tool_start') ui({ phase: 'working', text, step: stepLabel(ev.data) });
        else if (ev.type === 'confirmation_required') {
          approvalPending = true;
          ui({ phase: 'approve', id: ev.data.id, text: ev.data.summary, secret: ev.data.secretPrompt || '' });
        }
        else if (ev.type === 'engine' && ev.data && ev.data.answeredBy) send('engine', ev.data.answeredBy);
      },
    });
    history.push({ role: 'user', text }, { role: 'assistant', text: answer });
    history = history.slice(-12);
    return answer || 'Done.';
  } catch (e) {
    if (/abort/i.test(String(e && e.name))) throw e;
    // RAY unreachable mid-way: answer offline instead.
    return ray.askOffline(text);
  } finally {
    clearTimeout(guard);
    busy = null;
  }
}

function stepLabel(t) {
  const n = String((t && t.name) || '');
  const a = (t && t.args) || {};
  const map = {
    open_application: `Opening ${a.app_name || a.target || 'the app'}`,
    search_and_open: `Opening ${a.site || 'search'} for ${a.query || ''}`,
    open_url_on_device: 'Opening the page',
    send_chat_message: 'Preparing the message',
    whatsapp: 'On WhatsApp',
    instagram: 'On Instagram',
    browse_web: 'Browsing',
    web_search: 'Searching the web',
    google_workspace_action: 'Checking your Google account',
    google_api_request: 'Checking your Google account',
    play_media: 'Starting the music',
  };
  return map[n] || 'Working on it';
}

async function screenAttachment() {
  try {
    const d = screen.getPrimaryDisplay();
    const scale = Math.min(1, 1600 / d.size.width);
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(d.size.width * scale), height: Math.round(d.size.height * scale) } });
    const img = sources[0] && sources[0].thumbnail;
    if (!img || img.isEmpty()) return undefined;
    return [{ mimeType: 'image/jpeg', dataBase64: img.toJPEG(70).toString('base64') }];
  } catch {
    return undefined;
  }
}

const fmtDuration = (s) => (s >= 3600 ? `${Math.floor(s / 3600)} hour${s >= 7200 ? 's' : ''}${s % 3600 ? ` ${Math.round((s % 3600) / 60)} min` : ''}` : s >= 60 ? `${Math.round(s / 60)} minute${s >= 120 ? 's' : ''}` : `${s} seconds`);
const titleCase = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());

function keepAwake(minutes) {
  if (awakeId !== null && powerSaveBlocker.isStarted(awakeId)) powerSaveBlocker.stop(awakeId);
  clearTimeout(awakeTimer);
  awakeId = null;
  if (minutes > 0) {
    awakeId = powerSaveBlocker.start('prevent-display-sleep');
    awakeTimer = setTimeout(() => keepAwake(0), minutes * 60_000);
    send('awake', Date.now() + minutes * 60_000);
    return `Keeping your PC awake for ${minutes >= 60 ? Math.round(minutes / 60) + ' h' : minutes + ' min'}.`;
  } else {
    send('awake', 0);
    return 'Sleep allowed.';
  }
}

function logWater() {
  const d = new Date().toDateString();
  const w = store.get().waterToday;
  if (w.day !== d) {
    w.day = d;
    w.glasses = 0;
  }
  w.glasses++;
  store.save();
  send('water', w);
}

// --- shelf: recent copies + dropped files ---------------------------------------------------------------
let lastClip = '';
let shelfSkip = '';
function addShelf(item) {
  const s = store.get().shelf;
  const key = item.type === 'text' ? item.text : item.path;
  const i = s.findIndex((x) => (x.type === 'text' ? x.text : x.path) === key);
  if (i >= 0) s.splice(i, 1);
  s.unshift({ ...item, at: Date.now() });
  s.splice(30);
  store.save();
  send('shelf', s);
}
function watchClipboard() {
  setInterval(() => {
    const t = clipboard.readText();
    if (t && t !== lastClip && t !== shelfSkip && t.length < 8000) addShelf({ type: 'text', text: t });
    lastClip = t;
  }, 1200).unref?.();
}

/** "make it smaller" / "convert it to PNG" on a picture dropped on the notch. */
function imageOp(file, op) {
  const img = nativeImage.createFromPath(file);
  if (img.isEmpty()) return { ok: false, message: 'That isn’t a picture I can open.' };
  const { dir, name } = path.parse(file);
  let out;
  if (/png/i.test(op)) out = { buf: img.toPNG(), file: path.join(dir, `${name}.png`) };
  else if (/jpe?g/i.test(op)) out = { buf: img.toJPEG(88), file: path.join(dir, `${name}.jpg`) };
  else {
    const f = /bigger|larger|double/i.test(op) ? 2 : /quarter/i.test(op) ? 0.25 : 0.5;
    const s = img.getSize();
    const r = img.resize({ width: Math.max(1, Math.round(s.width * f)), quality: 'best' });
    out = { buf: /\.png$/i.test(file) ? r.toPNG() : r.toJPEG(90), file: path.join(dir, `${name}-${f < 1 ? 'small' : 'large'}${path.extname(file) || '.jpg'}`) };
  }
  if (fs.existsSync(out.file) && out.file !== file) out.file = out.file.replace(/(\.\w+)$/, `-${Date.now() % 10000}$1`);
  fs.writeFileSync(out.file, out.buf);
  addShelf({ type: 'file', path: out.file, name: path.basename(out.file) });
  return { ok: true, message: `Saved ${path.basename(out.file)}.` };
}

// --- hotkeys: hold Right Ctrl to command, hold Right Alt to dictate --------------------------------------
function startHotkeys() {
  try {
    const { uIOhook, UiohookKey } = require('uiohook-napi');
    hook = uIOhook;
    const KEY = { RightCtrl: UiohookKey.CtrlRight, RightAlt: UiohookKey.AltRight, RightShift: UiohookKey.ShiftRight, F8: UiohookKey.F8, F9: UiohookKey.F9 };
    let held = null;
    let armed = null;
    let other = false;
    uIOhook.on('keydown', (e) => {
      const mode = e.keycode === KEY[settings.hotkeyCommand] ? 'command' : e.keycode === KEY[settings.hotkeyDictate] ? 'dictate' : null;
      if (!mode) {
        if (held) other = true; // part of a shortcut (e.g. Right Ctrl + C): not for RAY
        return;
      }
      if (held) return; // key repeat
      held = mode;
      other = false;
      armed = setTimeout(() => {
        if (held === mode && !other && voice) voice.startListening(mode, { pushToTalk: true });
      }, 220);
    });
    uIOhook.on('keyup', (e) => {
      if (!held) return;
      const releasedOurKey = e.keycode === KEY[settings.hotkeyCommand] || e.keycode === KEY[settings.hotkeyDictate];
      if (!releasedOurKey) return;
      clearTimeout(armed);
      if (voice && voice.state === 'listening' && voice.pushToTalk) {
        if (other) voice.cancel();
        else voice.finish();
      }
      held = null;
    });
    uIOhook.start();
  } catch (e) {
    console.warn('[RAY Notch] hotkeys unavailable:', e.message);
  }
}

// --- RAY link ------------------------------------------------------------------------------------------
function startRay() {
  const link = loadLink();
  if (!link) return ui({ phase: 'idle', note: 'Not linked to RAY yet — open RAY → JARVIS Core → RAY Notch → Install.' });
  ray = new RayLink(link);
  ray.on('online', (v) => {
    send('online', v);
    if (v) void syncPrefsFromRay();
  });
  ray.on('command', (cmd) => void onDeviceCommand(cmd));
  ray.on('ask', (a) => ui({ phase: 'ask', id: a.id, text: a.question, options: a.options || [], why: a.why || '' }));
  ray.on('ask-answered', (a) => send('ask-answered', a));
  ray.on('confirmation', (c) => ui({ phase: 'approve', id: c.id, text: c.summary, secret: c.secretPrompt || '' }));
  ray.on('prefs', (p) => p && p.notch && applySettings({ ...settings, ...p.notch }, false));
  ray.connect();
}

async function onDeviceCommand(cmd) {
  const p = cmd.payload || {};
  switch (cmd.type) {
    case 'notify':
      ui({ phase: 'toast', title: String(p.title || 'RAY'), text: String(p.message || p.body || '') });
      return ray.ack(cmd, 'completed', 'Shown in the notch');
    case 'speak':
      ui({ phase: 'toast', title: 'RAY', text: String(p.text || '') });
      speak(String(p.text || ''));
      return ray.ack(cmd, 'completed', 'Spoken by the notch');
    case 'set_timer': {
      const secs = Number(p.seconds || (p.minutes ? Number(p.minutes) * 60 : 0) || p.durationSeconds || 0);
      send('widget', { type: 'timer', seconds: secs, label: String(p.label || p.title || '') });
      return ray.ack(cmd, 'completed', `Timer for ${fmtDuration(secs)} in the notch`);
    }
    case 'ask':
      ui({ phase: 'ask', id: String(p.askId || ''), text: String(p.question || ''), options: p.options || [], why: String(p.why || '') });
      return ray.ack(cmd, 'completed', 'Asked in the notch');
    default:
      return ray.ack(cmd, 'failed', `RAY Notch can't run ${cmd.type}`);
  }
}

async function syncPrefsFromRay() {
  try {
    const p = await ray.getPrefs();
    if (p && p.notch && Object.keys(p.notch).length) applySettings({ ...settings, ...p.notch }, false);
    else await ray.savePrefs(publicSettings()); // first link: publish the notch's settings to RAY
  } catch {
    // offline
  }
}

const SYNCED = ['style', 'color', 'wakeEnabled', 'wakePhrases', 'stt', 'voice', 'speakAnswers', 'hotkeyCommand', 'hotkeyDictate', 'apps', 'waterEveryMin', 'focusMin', 'breakMin', 'startWithPc'];
const publicSettings = () => Object.fromEntries(SYNCED.map((k) => [k, settings[k]]));

let waterTimer = null;
function applySettings(next, publish = true) {
  const prev = settings;
  settings = { ...prev, ...next };
  saveSettings(app.getPath('userData'), settings);
  send('settings', { ...settings, models: modelStatus(modelsDir()), voiceError });
  if (voice) {
    voice.wakeEnabled = settings.wakeEnabled;
    if (JSON.stringify(prev.wakePhrases) !== JSON.stringify(settings.wakePhrases)) {
      try {
        voice.setWakePhrases(settings.wakePhrases); // works at once, no restart
      } catch (e) {
        send('state', { phase: 'toast', title: 'Wake phrase', text: e.message });
      }
    }
  }
  if (prev.stt !== settings.stt || prev.voice !== settings.voice) void restartVoice();
  clearInterval(waterTimer);
  if (settings.waterEveryMin > 0) waterTimer = setInterval(() => ui({ phase: 'water' }), settings.waterEveryMin * 60_000);
  if (publish && ray && ray.online) void ray.savePrefs(publicSettings());
}

async function restartVoice() {
  voice = null;
  await startVoice();
}

// --- IPC from the notch UI ---------------------------------------------------------------------------
function wireIpc() {
  ipcMain.on('audio', (_e, buf) => {
    if (voice) voice.feed(new Float32Array(buf));
  });
  ipcMain.on('interactive', (_e, on) => win && win.setIgnoreMouseEvents(!on, { forward: true }));
  ipcMain.handle('init', () => ({ settings: { ...settings, models: modelStatus(modelsDir()), voiceError }, todos: store.get().todos, shelf: store.get().shelf, water: store.get().waterToday, online: Boolean(ray && ray.online), linked: Boolean(ray), playing: nowPlaying.current, platform: process.platform }));
  ipcMain.handle('command', (_e, text) => handleCommand(String(text || '')));
  ipcMain.handle('listen', (_e, mode) => voice && voice.startListening(mode === 'dictate' ? 'dictate' : 'command', { pushToTalk: false }));
  ipcMain.handle('stop-listening', () => voice && voice.finish());
  ipcMain.handle('cancel', () => {
    if (busy) busy.abort();
    if (voice) voice.cancel();
    ui({ phase: 'idle' });
  });
  ipcMain.handle('approve', async (_e, { id, yes }) => {
    if (!ray) return;
    ui({ phase: 'working', text: yes ? 'Approved' : 'Cancelled', step: yes ? 'Doing it now' : '' });
    const summary = await ray.resolveConfirmation(id, Boolean(yes)).catch((e) => `Couldn’t reach RAY: ${e.message}`);
    ui({ phase: yes ? 'answer' : 'done', text: yes ? summary : 'Okay, I won’t.' });
  });
  ipcMain.handle('answer-ask', async (_e, { id, answer }) => {
    if (ray) await ray.answerAsk(id, answer);
    ui({ phase: 'done', text: 'Thanks — passed on to RAY.' });
  });
  ipcMain.handle('settings', (_e, next) => applySettings(next || {}));
  ipcMain.handle('todos', (_e, todos) => {
    store.get().todos = Array.isArray(todos) ? todos.slice(0, 200) : [];
    store.save();
  });
  ipcMain.handle('shelf-open', (_e, item) => (item.type === 'file' ? shell.openPath(item.path) : clipboard.writeText(item.text)));
  ipcMain.handle('shelf-remove', (_e, idx) => {
    store.get().shelf.splice(idx, 1);
    store.save();
    send('shelf', store.get().shelf);
  });
  ipcMain.handle('drop-files', (_e, paths) => {
    for (const p of (paths || []).slice(0, 10)) if (p && fs.existsSync(p)) addShelf({ type: 'file', path: p, name: path.basename(p) });
  });
  ipcMain.handle('image-op', (_e, { file, op }) => imageOp(file, op));
  ipcMain.handle('media', (_e, action) => sys.media(action));
  ipcMain.handle('control', async (_e, { kind, value }) => {
    if (kind === 'volume') return sys.setVolume(value);
    if (kind === 'mute') return sys.mute();
    if (kind === 'brightness') return sys.brightness(value);
    if (kind === 'lock') return sys.lock();
    if (kind === 'dark') return sys.darkMode(Boolean(value));
    if (kind === 'awake') return keepAwake(Number(value) || 0);
    if (['wifi', 'bluetooth', 'nightlight'].includes(kind)) return sys.openSettings(kind);
    return '';
  });
  ipcMain.handle('open-app', async (_e, name) => {
    const r = ray ? await ray.action('open_app', { target: name }) : { ok: false };
    if (!r.ok && process.platform === 'win32') shell.openPath(name);
  });
  ipcMain.handle('water', () => logWater());
  ipcMain.handle('lyrics', async () => {
    const c = nowPlaying.current;
    if (!c) return null;
    if (!lyrics || lyrics.key !== c.title + c.artist) lyrics = { key: c.title + c.artist, lines: await sys.fetchLyrics(c.title, c.artist, c.duration) };
    return lyrics.lines;
  });
  ipcMain.handle('download-model', async (_e, id) => {
    const { ensureModel } = require('./lib/models.js');
    await ensureModel(modelsDir(), id, (p) => ui({ phase: 'setup', text: `Downloading ${p.label}`, progress: p.progress }));
    send('settings', { ...settings, models: modelStatus(modelsDir()), voiceError });
    ui({ phase: 'idle' });
  });
  ipcMain.handle('quit', () => app.quit());
  ipcMain.handle('open-ray', () => ray && shell.openExternal(`${ray.link.hub}/?room=${encodeURIComponent(ray.link.roomId)}`));
}

app.whenReady().then(async () => {
  settings = loadSettings(app.getPath('userData'));
  store = dataStore(app.getPath('userData'));
  Menu.setApplicationMenu(null);
  createWindow();
  wireIpc();
  startRay();
  nowPlaying.on('change', (c) => send('playing', c));
  nowPlaying.start();
  watchClipboard();
  startHotkeys();
  applySettings({}, false);
  await startVoice();
  // Developer screenshots of every state (never in normal use).
  if (process.env.RAY_NOTCH_SHOTS) require('./test/shots.js')({ win, ui, send, handleCommand, voice, dir: process.env.RAY_NOTCH_SHOTS });
});

app.on('second-instance', () => win && win.showInactive());
app.on('before-quit', () => {
  try {
    if (hook) hook.stop();
  } catch {
    // already stopped
  }
  nowPlaying.stop();
});
app.on('window-all-closed', () => app.quit());
