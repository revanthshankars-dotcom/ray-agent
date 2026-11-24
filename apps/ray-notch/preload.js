// The notch UI's only door to the app: a small, explicit API (no Node access in the page).
'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (ch) => (fn) => {
  const h = (_e, d) => fn(d);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};

contextBridge.exposeInMainWorld('notch', {
  init: () => ipcRenderer.invoke('init'),
  audio: (f32) => ipcRenderer.send('audio', f32.buffer),
  interactive: (on) => ipcRenderer.send('interactive', Boolean(on)),
  command: (text) => ipcRenderer.invoke('command', text),
  listen: (mode) => ipcRenderer.invoke('listen', mode),
  stopListening: () => ipcRenderer.invoke('stop-listening'),
  cancel: () => ipcRenderer.invoke('cancel'),
  approve: (id, yes) => ipcRenderer.invoke('approve', { id, yes }),
  answerAsk: (id, answer) => ipcRenderer.invoke('answer-ask', { id, answer }),
  saveSettings: (s) => ipcRenderer.invoke('settings', s),
  saveTodos: (t) => ipcRenderer.invoke('todos', t),
  shelfOpen: (item) => ipcRenderer.invoke('shelf-open', item),
  shelfRemove: (i) => ipcRenderer.invoke('shelf-remove', i),
  dropFiles: (files) => ipcRenderer.invoke('drop-files', Array.from(files).map((f) => webUtils.getPathForFile(f))),
  imageOp: (file, op) => ipcRenderer.invoke('image-op', { file, op }),
  media: (a) => ipcRenderer.invoke('media', a),
  control: (kind, value) => ipcRenderer.invoke('control', { kind, value }),
  openApp: (name) => ipcRenderer.invoke('open-app', name),
  water: () => ipcRenderer.invoke('water'),
  lyrics: () => ipcRenderer.invoke('lyrics'),
  downloadModel: (id) => ipcRenderer.invoke('download-model', id),
  openRay: () => ipcRenderer.invoke('open-ray'),
  quit: () => ipcRenderer.invoke('quit'),
  on: {
    state: on('state'),
    widget: on('widget'),
    settings: on('settings'),
    todos: on('todos'),
    shelf: on('shelf'),
    playing: on('playing'),
    online: on('online'),
    engine: on('engine'),
    water: on('water'),
    awake: on('awake'),
    play: on('play'),
    askAnswered: on('ask-answered'),
  },
});
