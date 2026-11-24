/**
 * Records one spoken utterance with simple voice-activity detection: measures the room's noise for
 * a moment, starts when Ray speaks, and stops after ~1.1 s of silence (or 25 s). Pauses mid-sentence
 * don't cut him off the way the browser recogniser does.
 */
export interface Utterance {
  blob: Blob | null;
  mimeType: string;
  spoke: boolean;
  ms: number;
}

export function pickRecorderMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const m of ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4']) {
    if (MediaRecorder.isTypeSupported?.(m)) return m;
  }
  return '';
}

export async function recordUtterance(
  stream: MediaStream,
  opts: { isActive: () => boolean; silenceMs?: number; maxMs?: number; startTimeoutMs?: number; onLevel?: (level: number, speaking: boolean) => void }
): Promise<Utterance> {
  const silenceMs = opts.silenceMs ?? 1100;
  const maxMs = opts.maxMs ?? 25000;
  const startTimeoutMs = opts.startTimeoutMs ?? 7000;
  const mimeType = pickRecorderMime();
  const rec = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 32000 } : undefined);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data);
  };
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctx();
  // Started without a tap (e.g. woken by another device) the browser may keep audio suspended;
  // then the level meter reads silence, so the caller falls back to the browser recogniser.
  if (ctx.state !== 'running') await Promise.race([ctx.resume().catch(() => undefined), new Promise((r) => setTimeout(r, 600))]);
  if (ctx.state !== 'running') {
    void ctx.close();
    throw new Error('audio-suspended');
  }
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  src.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  const rms = () => {
    analyser.getFloatTimeDomainData(buf);
    let s = 0;
    for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
    return Math.sqrt(s / buf.length);
  };

  const started = performance.now();
  rec.start(250);
  let noise = 0;
  let noiseFrames = 0;
  let spoke = false;
  let loudFrames = 0;
  let lastVoice = 0;

  await new Promise<void>((resolve) => {
    const tick = window.setInterval(() => {
      const now = performance.now();
      const elapsed = now - started;
      const level = rms();
      if (elapsed < 300) {
        noise += level;
        noiseFrames++;
      } else {
        const floor = noiseFrames ? noise / noiseFrames : 0.005;
        const threshold = Math.max(0.012, floor * 2.8);
        if (level > threshold) {
          loudFrames++;
          if (loudFrames >= 2) {
            spoke = true;
            lastVoice = now;
          }
        } else {
          loudFrames = 0;
        }
        opts.onLevel?.(Math.min(1, level / (threshold * 3)), level > threshold);
      }
      const done =
        !opts.isActive() ||
        elapsed > maxMs ||
        (spoke && now - lastVoice > silenceMs) ||
        (!spoke && elapsed > startTimeoutMs);
      if (done) {
        window.clearInterval(tick);
        resolve();
      }
    }, 50);
  });

  const stopped = new Promise<void>((r) => (rec.onstop = () => r()));
  try {
    rec.stop();
  } catch {
    // already stopped
  }
  await stopped;
  try {
    src.disconnect();
    void ctx.close();
  } catch {
    // ignore
  }
  return { blob: spoke && chunks.length ? new Blob(chunks, { type: rec.mimeType || mimeType || 'audio/webm' }) : null, mimeType: rec.mimeType || mimeType || 'audio/webm', spoke, ms: performance.now() - started };
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
