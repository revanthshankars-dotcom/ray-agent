// Offline round trip: RAY's voice says a command -> wake phrase -> speech-to-text. No network.
'use strict';
const path = require('path');
const { VoiceEngine, SR } = require('../lib/voice.js');

function resample(x, from, to) {
  if (from === to) return x;
  const n = Math.round((x.length * to) / from);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = (i * from) / to;
    const j = Math.floor(t);
    const f = t - j;
    out[i] = (x[j] || 0) * (1 - f) + (x[j + 1] || 0) * f;
  }
  return out;
}

(async () => {
  const modelsDir = process.env.RAY_NOTCH_MODELS || path.join(__dirname, '..', 'models');
  const say = process.argv[2] || 'Hey Ray. Open Spotify and set a timer for ten minutes.';
  const phrases = (process.argv[3] || 'hey ray').split(',');
  const v = new VoiceEngine({ modelsDir, wakePhrases: phrases });
  const t0 = Date.now();
  await v.init((p) => process.stdout.write(`\rdownloading ${p.label} ${Math.round(p.progress * 100)}%   `));
  console.log(`\nloaded in ${Date.now() - t0} ms; skipped phrases: ${JSON.stringify(v.skippedPhrases)}`);
  const events = [];
  v.on('wake', (k) => events.push(`wake: ${k}`));
  v.on('listening', (m) => events.push(`listening (${m})`));
  v.on('partial', (t) => events.push(`partial: ${t}`));
  v.on('final', (t, m) => events.push(`final (${m}): ${t}`));
  const t1 = Date.now();
  const audio = v.speak(say);
  console.log(`spoke ${(audio.samples.length / audio.sampleRate).toFixed(1)}s of audio in ${Date.now() - t1} ms at ${audio.sampleRate} Hz`);
  const pcm = resample(audio.samples, audio.sampleRate, SR);
  const silence = new Float32Array(SR * 2);
  const all = new Float32Array(SR / 2 + pcm.length + silence.length);
  all.set(pcm, SR / 2);
  const t2 = Date.now();
  for (let i = 0; i < all.length; i += 1600) v.feed(all.subarray(i, i + 1600));
  console.log(`processed ${(all.length / SR).toFixed(1)}s of audio in ${Date.now() - t2} ms`);
  console.log(events.join('\n'));
  process.exit(events.some((e) => e.startsWith('final')) ? 0 : 1);
})().catch((e) => {
  console.error('FAILED', e);
  process.exit(1);
});
