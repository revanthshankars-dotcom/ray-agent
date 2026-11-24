// RAY Notch offline voice engine — everything runs on this PC (sherpa-onnx, CPU):
//   wake phrase (open-vocabulary keyword spotting) -> voice detection -> speech-to-text with live
//   partial words -> RAY's spoken voice. Feed it 16 kHz mono Float32 audio from the microphone.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { ensureModel, CATALOG } = require('./models.js');
const { loadVocab, buildKeywords } = require('./keywords.js');

const SR = 16000;

class VoiceEngine extends EventEmitter {
  /**
   * @param {{ modelsDir: string, stt?: string, voice?: string, wakePhrases?: string[], sherpa?: any }} opts
   */
  constructor(opts) {
    super();
    this.modelsDir = opts.modelsDir;
    this.sttId = opts.stt || 'stt-fast';
    this.voiceId = opts.voice || 'voice-alan';
    this.wakePhrases = opts.wakePhrases && opts.wakePhrases.length ? opts.wakePhrases : ['hey ray'];
    this.sherpa = opts.sherpa || require('sherpa-onnx-node');
    this.state = 'off'; // off | idle | listening
    this.mode = null; // command | dictate
    this.buffer = [];
    this.bufferLen = 0;
    this.heardSpeech = false;
    this.silentFor = 0;
    this.lastPartialAt = 0;
    this.pushToTalk = false;
    this.wakeEnabled = true;
    this.speechRate = 1.0;
    this.ring = [];
    this.ringLen = 0;
    this.fed = 0; // samples fed while idle (absolute clock for the ring)
    this.resetAt = 0; // value of `fed` when the spotter stream was last reset
  }

  async init(onProgress) {
    const progress = (id) => (p) => onProgress && onProgress({ id, label: CATALOG[id].label, progress: p });
    const kwsDir = await ensureModel(this.modelsDir, 'kws', progress('kws'));
    await ensureModel(this.modelsDir, 'vad', progress('vad'));
    const sttDir = await ensureModel(this.modelsDir, this.sttId, progress(this.sttId));
    const ttsDir = await ensureModel(this.modelsDir, this.voiceId, progress(this.voiceId));
    this.kwsDir = kwsDir;
    this.vocab = loadVocab(path.join(kwsDir, 'tokens.txt'));
    this.buildSpotter();
    this.vad = new this.sherpa.Vad(
      {
        sileroVad: { model: path.join(this.modelsDir, 'silero_vad.onnx'), threshold: 0.5, minSilenceDuration: 0.25, minSpeechDuration: 0.15, windowSize: 512 },
        sampleRate: SR,
        numThreads: 1,
        debug: false,
      },
      30
    );
    this.asr = new this.sherpa.OfflineRecognizer(this.sttConfig(sttDir));
    this.tts = new this.sherpa.OfflineTts(this.ttsConfig(ttsDir));
    this.state = 'idle';
    this.emit('ready');
  }

  sttConfig(dir) {
    const f = (n) => path.join(dir, n);
    const common = { featConfig: { sampleRate: SR, featureDim: 80 }, decodingMethod: 'greedy_search' };
    if (this.sttId === 'stt-multilingual') {
      return { ...common, modelConfig: { whisper: { encoder: f('base-encoder.int8.onnx'), decoder: f('base-decoder.int8.onnx'), language: '', task: 'transcribe' }, tokens: f('base-tokens.txt'), numThreads: 2, provider: 'cpu', debug: 0 } };
    }
    return {
      ...common,
      modelConfig: {
        moonshine: { preprocessor: f('preprocess.onnx'), encoder: f('encode.int8.onnx'), uncachedDecoder: f('uncached_decode.int8.onnx'), cachedDecoder: f('cached_decode.int8.onnx') },
        tokens: f('tokens.txt'),
        numThreads: 2,
        provider: 'cpu',
        debug: 0,
      },
    };
  }

  ttsConfig(dir) {
    const onnx = fs.readdirSync(dir).find((n) => n.endsWith('.onnx'));
    return {
      model: {
        vits: { model: path.join(dir, onnx), tokens: path.join(dir, 'tokens.txt'), dataDir: path.join(dir, 'espeak-ng-data'), noiseScale: 0.667, noiseScaleW: 0.8, lengthScale: 1.0 },
        numThreads: 2,
        provider: 'cpu',
        debug: 0,
      },
      maxNumSentences: 1,
    };
  }

  /** (Re)build the wake-phrase spotter. Called on start and whenever the phrase changes in Settings. */
  buildSpotter() {
    const { text, count, skipped } = buildKeywords(this.wakePhrases, this.vocab);
    if (!count) throw new Error(`None of the wake phrases can be spotted: ${this.wakePhrases.join(', ')}`);
    const file = path.join(os.tmpdir(), `ray-notch-keywords-${process.pid}.txt`);
    fs.writeFileSync(file, text);
    const d = this.kwsDir;
    const pick = (re) => path.join(d, fs.readdirSync(d).find((n) => re.test(n)));
    this.kws = new this.sherpa.KeywordSpotter({
      featConfig: { sampleRate: SR, featureDim: 80 },
      modelConfig: {
        transducer: { encoder: pick(/^encoder.*\.int8\.onnx$/), decoder: pick(/^decoder.*\.int8\.onnx$/), joiner: pick(/^joiner.*\.int8\.onnx$/) },
        tokens: path.join(d, 'tokens.txt'),
        numThreads: 1,
        provider: 'cpu',
        debug: 0,
      },
      keywordsFile: file,
    });
    this.kwsStream = this.kws.createStream();
    this.skippedPhrases = skipped;
  }

  setWakePhrases(phrases) {
    this.wakePhrases = phrases.filter(Boolean);
    if (this.vocab) this.buildSpotter();
  }

  /** Feed microphone audio (16 kHz mono Float32Array). */
  feed(samples) {
    if (this.state === 'off') return;
    if (this.state === 'idle') {
      if (!this.wakeEnabled) return;
      // Keep the last few seconds: words said right after "Hey Ray" arrive before the spotter is sure.
      this.ring.push(samples);
      this.ringLen += samples.length;
      while (this.ringLen - this.ring[0].length > SR * 4) this.ringLen -= this.ring.shift().length;
      this.fed += samples.length;
      this.kwsStream.acceptWaveform({ samples, sampleRate: SR });
      while (this.kws.isReady(this.kwsStream)) {
        this.kws.decode(this.kwsStream);
        const r = this.kws.getResult(this.kwsStream);
        if (r && r.keyword) {
          // Where the wake phrase ended (token start times are relative to the last reset).
          const ts = Array.isArray(r.timestamps) && r.timestamps.length ? r.timestamps[r.timestamps.length - 1] : null;
          const endAbs = ts !== null ? this.resetAt + Math.round((ts - 0.05) * SR) : this.fed;
          const tail = this.tailFrom(endAbs);
          this.kws.reset(this.kwsStream);
          this.resetAt = this.fed;
          this.emit('wake', r.keyword.replace(/_/g, ' '));
          this.startListening('command', { pushToTalk: false });
          if (tail.length) this.feed(tail);
          return;
        }
      }
      return;
    }
    // listening
    this.buffer.push(samples);
    this.bufferLen += samples.length;
    this.vad.acceptWaveform(samples);
    const speaking = this.vad.isDetected();
    while (!this.vad.isEmpty()) this.vad.pop();
    if (speaking) {
      this.heardSpeech = true;
      this.silentFor = 0;
    } else this.silentFor += samples.length / SR;
    const secs = this.bufferLen / SR;
    // Live words while Ray is still talking.
    if (this.heardSpeech && Date.now() - this.lastPartialAt > 700) {
      this.lastPartialAt = Date.now();
      const partial = this.stripWake(this.transcribe(this.joined()));
      if (partial) this.emit('partial', partial, this.mode);
    }
    if (!this.pushToTalk) {
      const endOfSpeech = this.heardSpeech && this.silentFor > (this.mode === 'dictate' ? 1.4 : 0.9);
      const nothingSaid = !this.heardSpeech && secs > 5;
      if (endOfSpeech || nothingSaid || secs > 30) this.finish();
    } else if (secs > 120) this.finish();
  }

  /** Audio from absolute sample index `from` up to now (from the idle ring). */
  tailFrom(from) {
    const startAbs = this.fed - this.ringLen;
    const all = new Float32Array(this.ringLen);
    let o = 0;
    for (const b of this.ring) {
      all.set(b, o);
      o += b.length;
    }
    const i = Math.max(0, Math.min(all.length, from - startAbs));
    return all.subarray(i);
  }

  joined() {
    const out = new Float32Array(this.bufferLen);
    let o = 0;
    for (const b of this.buffer) {
      out.set(b, o);
      o += b.length;
    }
    return out;
  }

  startListening(mode = 'command', { pushToTalk = false } = {}) {
    this.state = 'listening';
    this.mode = mode;
    this.pushToTalk = pushToTalk;
    this.buffer = [];
    this.bufferLen = 0;
    this.heardSpeech = false;
    this.silentFor = 0;
    this.lastPartialAt = 0;
    this.vad.reset();
    this.emit('listening', mode);
  }

  /** End the utterance now (push-to-talk released, or Ray tapped stop). */
  finish() {
    if (this.state !== 'listening') return;
    const audio = this.joined();
    const mode = this.mode;
    const heard = this.heardSpeech;
    this.state = 'idle';
    this.mode = null;
    this.buffer = [];
    this.bufferLen = 0;
    if (this.kwsStream) this.kws.reset(this.kwsStream);
    this.ring = [];
    this.ringLen = 0;
    this.resetAt = this.fed;
    const text = heard || this.pushToTalk ? this.stripWake(this.transcribe(audio)) : '';
    this.emit('final', text, mode);
  }

  cancel() {
    if (this.state === 'listening') {
      this.state = 'idle';
      this.buffer = [];
      this.bufferLen = 0;
      this.emit('final', '', this.mode);
      this.mode = null;
    }
  }

  /** Recording starts a little before the wake phrase ends; drop any echo of it ("…Ray, what time"). */
  stripWake(text) {
    let t = String(text || '');
    for (const p of this.wakePhrases) {
      const words = String(p).toLowerCase().split(/\s+/).filter(Boolean);
      for (let k = words.length; k >= 1; k--) {
        const tail = words.slice(words.length - k).join('[\\s,.!?]+');
        const re = new RegExp('^\\W*' + tail + '\\b[\\s,.!?]*', 'i');
        if (re.test(t)) {
          t = t.replace(re, '');
          break;
        }
      }
    }
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
  }

  transcribe(samples) {
    if (!samples || samples.length < SR * 0.3) return '';
    const s = this.asr.createStream();
    s.acceptWaveform({ samples, sampleRate: SR });
    this.asr.decode(s);
    const r = this.asr.getResult(s);
    return String((r && r.text) || '').trim();
  }

  /** RAY's offline voice. Returns { samples: Float32Array, sampleRate }. */
  speak(text) {
    return this.tts.generate({ text: String(text || '').slice(0, 800), sid: 0, speed: this.speechRate });
  }
}

module.exports = { VoiceEngine, SR };
