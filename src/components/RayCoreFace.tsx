import React, { useMemo } from 'react';
import { Mic, Radio } from 'lucide-react';
import type { LiveVoiceState } from '../types/relay';

interface RayCoreFaceProps {
  voiceState: LiveVoiceState;
  compact?: boolean;
  bridgeConnected?: boolean;
  ollamaRunning?: boolean;
  engineLabel?: string;
  onToggleVoice?: () => void;
}

const STATE_COPY: Record<
  LiveVoiceState,
  { label: string; sub: string; ringClass: string; coreGlowClass: string }
> = {
  off: {
    label: 'Core Standby',
    sub: 'Tap orb to engage RAY Live Voice',
    ringClass: 'text-blue-600 dark:text-blue-400',
    coreGlowClass: 'bg-blue-600/10 dark:bg-blue-500/15 border-blue-600/35 dark:border-blue-400/35',
  },
  standby: {
    label: 'Wake Armed · "Hey Ray"',
    sub: 'Hands-off acoustic trigger listening',
    ringClass: 'text-emerald-600 dark:text-emerald-400',
    coreGlowClass: 'bg-emerald-600/10 dark:bg-emerald-500/15 border-emerald-500/45',
  },
  connecting: {
    label: 'Synchronizing...',
    sub: 'Linking voice stream & room tools',
    ringClass: 'text-sky-500 dark:text-sky-400',
    coreGlowClass: 'bg-sky-500/15 border-sky-400/50',
  },
  listening: {
    label: 'Listening',
    sub: 'Speak naturally — say "Ray, stop" anytime',
    ringClass: 'text-blue-600 dark:text-blue-400',
    coreGlowClass: 'bg-blue-600/20 dark:bg-blue-500/25 border-blue-500 shadow-lg shadow-blue-600/20',
  },
  thinking: {
    label: 'Reasoning',
    sub: 'Orchestrating tools & knowledge graph',
    ringClass: 'text-sky-600 dark:text-sky-300',
    coreGlowClass: 'bg-sky-600/20 border-sky-400 shadow-md shadow-sky-500/20',
  },
  speaking: {
    label: 'RAY Speaking',
    sub: 'Live audio response active',
    ringClass: 'text-blue-500 dark:text-blue-300',
    coreGlowClass: 'bg-blue-600/25 border-blue-400 shadow-xl shadow-blue-500/25',
  },
  interrupted: {
    label: 'Standing Down',
    sub: 'Execution halted on command',
    ringClass: 'text-amber-600 dark:text-amber-400',
    coreGlowClass: 'bg-amber-500/15 border-amber-500/50',
  },
};

export const RayCoreFace: React.FC<RayCoreFaceProps> = ({
  voiceState,
  compact = false,
  bridgeConnected = false,
  ollamaRunning = false,
  engineLabel,
  onToggleVoice,
}) => {
  const meta = STATE_COPY[voiceState] || STATE_COPY.off;
  const activeMotion =
    voiceState === 'listening' ||
    voiceState === 'thinking' ||
    voiceState === 'speaking' ||
    voiceState === 'connecting';

  const radialTicks = useMemo(() => {
    const count = compact ? 24 : 36;
    return Array.from({ length: count }, (_, idx) => {
      const deg = (idx / count) * 360;
      const major = idx % 3 === 0;
      return { deg, major, idx };
    });
  }, [compact]);

  const sizePx = compact ? 76 : 164;

  return (
    <div
      className={
        compact
          ? 'flex items-center gap-3.5'
          : 'rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 sm:p-5 flex flex-col items-center justify-between gap-3.5 text-center'
      }
    >
      {!compact && (
        <div className="w-full flex items-center justify-between text-[11px] font-mono uppercase tracking-widest text-slate-500 dark:text-slate-400 border-b border-slate-100 dark:border-slate-800 pb-2">
          <span>Think</span>
          <span className="text-slate-300 dark:text-slate-700">·</span>
          <span>Plan</span>
          <span className="text-slate-300 dark:text-slate-700">·</span>
          <span>Automate</span>
          <span className="text-slate-300 dark:text-slate-700">·</span>
          <span>Execute</span>
        </div>
      )}

      <button
        type="button"
        onClick={onToggleVoice}
        aria-label={voiceState === 'off' ? 'Activate RAY Voice Core' : 'Toggle RAY Voice Core'}
        className="group relative flex items-center justify-center focus-visible:outline-2 focus-visible:outline-blue-600 rounded-full shrink-0"
      >
        <div className="relative flex items-center justify-center">
          <svg
            width={sizePx}
            height={sizePx}
            viewBox="0 0 200 200"
            className={`${meta.ringClass} overflow-visible`}
            aria-hidden="true"
          >
            {/* Outer segmented ring */}
            <circle
              cx="100"
              cy="100"
              r="90"
              fill="none"
              stroke="currentColor"
              strokeOpacity="0.22"
              strokeWidth="2"
              strokeDasharray="16 8 4 8"
              className={`origin-center ${
                activeMotion
                  ? 'animate-[spin_8s_linear_infinite]'
                  : 'animate-[spin_28s_linear_infinite]'
              } motion-reduce:animate-none`}
            />

            {/* Counter-rotating arc ring */}
            <circle
              cx="100"
              cy="100"
              r="76"
              fill="none"
              stroke="currentColor"
              strokeOpacity={activeMotion ? '0.85' : '0.45'}
              strokeWidth="3.5"
              strokeLinecap="round"
              strokeDasharray="72 44 28 44"
              className={`origin-center ${
                voiceState === 'thinking' || voiceState === 'connecting'
                  ? 'animate-[spin_4s_linear_infinite_reverse]'
                  : 'animate-[spin_16s_linear_infinite_reverse]'
              } motion-reduce:animate-none`}
            />

            {/* Radial HUD ticks */}
            <g className="origin-center">
              {radialTicks.map((t) => (
                <line
                  key={t.idx}
                  x1="100"
                  y1={t.major ? '28' : '32'}
                  x2="100"
                  y2={activeMotion && t.idx % 2 === 0 ? '38' : '36'}
                  stroke="currentColor"
                  strokeOpacity={t.major ? '0.6' : '0.28'}
                  strokeWidth={t.major ? '2' : '1.2'}
                  transform={`rotate(${t.deg} 100 100)`}
                />
              ))}
            </g>

            {/* Inner crisp harmonic ring */}
            <circle
              cx="100"
              cy="100"
              r="54"
              fill="none"
              stroke="currentColor"
              strokeOpacity={voiceState === 'speaking' || voiceState === 'listening' ? '0.9' : '0.4'}
              strokeWidth={voiceState === 'speaking' ? '2.5' : '1.5'}
              className={
                voiceState === 'speaking' || voiceState === 'listening'
                  ? 'animate-pulse motion-reduce:animate-none'
                  : ''
              }
            />
          </svg>

          {/* Center Holographic RAY Core Wordmark */}
          <div
            className={`absolute rounded-full border flex flex-col items-center justify-center transition-all group-hover:scale-105 motion-reduce:transform-none ${
              compact ? 'w-11 h-11' : 'w-24 h-24'
            } ${meta.coreGlowClass}`}
          >
            <span
              className={`font-display font-bold tracking-[0.18em] text-slate-900 dark:text-slate-100 select-none ${
                compact ? 'text-[11px] pl-[0.18em]' : 'text-lg pl-[0.18em]'
              }`}
            >
              RAY
            </span>
            {!compact && (
              <span className="mt-0.5 text-[10px] font-mono text-slate-600 dark:text-slate-300 flex items-center gap-1">
                {activeMotion ? (
                  <Radio className="w-2.5 h-2.5 animate-pulse" />
                ) : (
                  <Mic className="w-2.5 h-2.5" />
                )}
                <span>{voiceState === 'off' ? 'VOICE' : voiceState.toUpperCase()}</span>
              </span>
            )}
          </div>
        </div>
      </button>

      <div className={compact ? 'min-w-0 text-left' : 'space-y-1 w-full'}>
        <div className="text-xs font-semibold text-slate-900 dark:text-slate-100 flex items-center justify-center sm:justify-start gap-1.5">
          {compact ? (
            <span className="truncate">{meta.label}</span>
          ) : (
            <span className="mx-auto">{meta.label}</span>
          )}
        </div>
        <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-snug">
          {meta.sub}
        </p>
        {!compact && (
          <div className="pt-2 border-t border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[11px] font-mono text-slate-500 dark:text-slate-400">
            <span className={bridgeConnected ? 'text-emerald-600 dark:text-emerald-400' : ''}>
              Bridge: {bridgeConnected ? 'Active' : 'Idle'}
            </span>
            <span className={ollamaRunning ? 'text-emerald-600 dark:text-emerald-400' : ''}>
              Ollama: {ollamaRunning ? 'Ready' : 'Standby'}
            </span>
            {engineLabel && <span className="truncate max-w-[160px]">{engineLabel}</span>}
          </div>
        )}
      </div>
    </div>
  );
};
