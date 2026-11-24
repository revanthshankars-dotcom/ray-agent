// Offline voice models RAY Notch downloads once (from the sherpa-onnx releases on GitHub) and then
// runs fully on this PC: wake phrase, voice detection, speech-to-text and RAY's speaking voice.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const BASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';

/** What each model is, where it comes from and which files RAY needs from it. */
const CATALOG = {
  vad: { label: 'Voice detection (Silero)', mb: 1, file: `${BASE}/asr-models/silero_vad.onnx`, dir: null, check: 'silero_vad.onnx' },
  kws: {
    label: 'Wake phrase (any phrase, English)',
    mb: 17,
    url: `${BASE}/kws-models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2`,
    dir: 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01',
    check: 'tokens.txt',
  },
  'stt-fast': {
    label: 'Speech-to-text: fast (Moonshine tiny, English)',
    mb: 103,
    url: `${BASE}/asr-models/sherpa-onnx-moonshine-tiny-en-int8.tar.bz2`,
    dir: 'sherpa-onnx-moonshine-tiny-en-int8',
    check: 'tokens.txt',
  },
  'stt-accurate': {
    label: 'Speech-to-text: accurate (Moonshine base, English)',
    mb: 250,
    url: `${BASE}/asr-models/sherpa-onnx-moonshine-base-en-int8.tar.bz2`,
    dir: 'sherpa-onnx-moonshine-base-en-int8',
    check: 'tokens.txt',
  },
  'stt-multilingual': {
    label: 'Speech-to-text: 99 languages incl. Hindi & Tamil (Whisper base)',
    mb: 200,
    url: `${BASE}/asr-models/sherpa-onnx-whisper-base.tar.bz2`,
    dir: 'sherpa-onnx-whisper-base',
    check: 'base-tokens.txt',
  },
  'voice-alan': {
    label: 'RAY voice: Alan (British, male)',
    mb: 65,
    url: `${BASE}/tts-models/vits-piper-en_GB-alan-medium.tar.bz2`,
    dir: 'vits-piper-en_GB-alan-medium',
    check: 'en_GB-alan-medium.onnx',
  },
  'voice-jenny': {
    label: 'RAY voice: Jenny (British, female)',
    mb: 65,
    url: `${BASE}/tts-models/vits-piper-en_GB-jenny_dioco-medium.tar.bz2`,
    dir: 'vits-piper-en_GB-jenny_dioco-medium',
    check: 'en_GB-jenny_dioco-medium.onnx',
  },
  'voice-amy': {
    label: 'RAY voice: Amy (American, female)',
    mb: 65,
    url: `${BASE}/tts-models/vits-piper-en_US-amy-low.tar.bz2`,
    dir: 'vits-piper-en_US-amy-low',
    check: 'en_US-amy-low.onnx',
  },
};

function isInstalled(modelsDir, id) {
  const m = CATALOG[id];
  if (!m) return false;
  return fs.existsSync(path.join(modelsDir, m.dir || '', m.check));
}

async function download(url, dest, onProgress) {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok || !r.body) throw new Error(`Download failed (${r.status}) ${url}`);
  const total = Number(r.headers.get('content-length') || 0);
  const tmp = dest + '.part';
  const out = fs.createWriteStream(tmp);
  let got = 0;
  for await (const chunk of r.body) {
    got += chunk.length;
    if (!out.write(chunk)) await new Promise((res) => out.once('drain', res));
    if (onProgress && total) onProgress(got / total);
  }
  await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
  fs.renameSync(tmp, dest);
}

/** tar is built into Windows 10+, macOS and Linux, and reads .tar.bz2. */
function untar(file, cwd) {
  return new Promise((res, rej) =>
    execFile('tar', ['-xjf', file, '-C', cwd], { timeout: 10 * 60_000, windowsHide: true }, (e, _o, err) => (e ? rej(new Error(String(err || e.message))) : res()))
  );
}

/** Make sure a model is on disk; downloads and unpacks it if missing. */
async function ensureModel(modelsDir, id, onProgress) {
  const m = CATALOG[id];
  if (!m) throw new Error(`Unknown model ${id}`);
  fs.mkdirSync(modelsDir, { recursive: true });
  if (isInstalled(modelsDir, id)) return path.join(modelsDir, m.dir || '');
  if (m.file) {
    await download(m.file, path.join(modelsDir, m.check), onProgress);
  } else {
    const archive = path.join(modelsDir, `${m.dir}.tar.bz2`);
    await download(m.url, archive, onProgress);
    await untar(archive, modelsDir);
    fs.rmSync(archive, { force: true });
  }
  if (!isInstalled(modelsDir, id)) throw new Error(`${m.label} did not unpack correctly`);
  return path.join(modelsDir, m.dir || '');
}

function modelStatus(modelsDir) {
  return Object.entries(CATALOG).map(([id, m]) => ({ id, label: m.label, mb: m.mb, installed: isInstalled(modelsDir, id) }));
}

module.exports = { CATALOG, ensureModel, isInstalled, modelStatus };
