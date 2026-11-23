import type { HudSoundType } from '../types/relay';

let sharedAudioCtx: AudioContext | null = null;

function getAudioCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  if (!sharedAudioCtx || sharedAudioCtx.state === 'closed') {
    sharedAudioCtx = new Ctx();
  }
  if (sharedAudioCtx.state === 'suspended') {
    void sharedAudioCtx.resume();
  }
  return sharedAudioCtx;
}

function scheduleTone(
  ctx: AudioContext,
  freq: number,
  startOffset: number,
  duration: number,
  volume = 0.08,
  type: OscillatorType = 'sine',
  endFreq?: number
) {
  const now = ctx.currentTime + startOffset;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, now);
  if (endFreq && endFreq !== freq) {
    osc.frequency.exponentialRampToValueAtTime(endFreq, now + duration);
  }
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(volume, now + Math.min(0.025, duration * 0.25));
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + duration + 0.02);
}

/**
 * Zero-dependency Web Audio HUD sound synthesizer inspired by J.A.R.V.I.S. 2.0.
 */
export function playHudSound(sound: HudSoundType): void {
  try {
    const ctx = getAudioCtx();
    if (!ctx) return;

    switch (sound) {
      case 'wake':
        // Ascending holographic triad chime
        scheduleTone(ctx, 523.25, 0, 0.14, 0.09, 'sine');
        scheduleTone(ctx, 659.25, 0.08, 0.16, 0.09, 'sine');
        scheduleTone(ctx, 987.77, 0.16, 0.26, 0.1, 'triangle');
        break;

      case 'affirmative':
        // Crisp two-tone confirmation click
        scheduleTone(ctx, 740, 0, 0.09, 0.08, 'triangle');
        scheduleTone(ctx, 1108.73, 0.08, 0.16, 0.09, 'sine');
        break;

      case 'blip':
        // Subtle processing telemetry blip
        scheduleTone(ctx, 1320, 0, 0.06, 0.05, 'sine', 880);
        break;

      case 'alert':
        // Sentry / warning double-pulse klaxon
        scheduleTone(ctx, 620, 0, 0.16, 0.1, 'sawtooth', 440);
        scheduleTone(ctx, 620, 0.2, 0.16, 0.1, 'sawtooth', 440);
        break;

      case 'protocol':
        // Harmonic activation sweep for House Party / Veronica
        scheduleTone(ctx, 329.63, 0, 0.25, 0.08, 'triangle', 659.25);
        scheduleTone(ctx, 493.88, 0.12, 0.28, 0.08, 'sine', 987.77);
        scheduleTone(ctx, 987.77, 0.26, 0.34, 0.07, 'sine');
        break;

      case 'clean_slate':
        // Descending power-purge chord followed by clear chime
        scheduleTone(ctx, 880, 0, 0.26, 0.08, 'sine', 220);
        scheduleTone(ctx, 659.25, 0.08, 0.26, 0.07, 'triangle', 196);
        scheduleTone(ctx, 1046.5, 0.3, 0.22, 0.08, 'sine');
        break;
    }
  } catch {
    // Ignore audio errors prior to user interaction
  }
}
