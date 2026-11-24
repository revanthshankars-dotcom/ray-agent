import React from 'react';
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
    sub: 'Tap RAY to talk',
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
        {/* Nixi-style face: a black notch with two eyes that react to the voice state. */}
        <div
          className={`relative bg-[#0a0a0b] dark:ring-1 dark:ring-white/10 rounded-full flex items-center justify-center shadow-xl shadow-black/10 transition-transform group-hover:scale-105 motion-reduce:transform-none ${
            compact ? 'w-[76px] h-[38px] gap-2.5' : 'w-[168px] h-[80px] gap-5'
          }`}
        >
          {voiceState === 'speaking' ? (
            <span className={`flex items-center ${compact ? 'gap-1' : 'gap-1.5'}`}>
              {[0, 1, 2, 3, 4].map((i) => (
                <span
                  key={i}
                  className={`rounded-full bg-white ray-bar ${compact ? 'w-[3px]' : 'w-[6px]'}`}
                  style={{ height: compact ? 14 : 30, animationDelay: `${i * 0.12}s` }}
                />
              ))}
            </span>
          ) : (
            [0, 1].map((i) => (
              <span
                key={i}
                className={`rounded-full bg-white ${
                  voiceState === 'thinking' || voiceState === 'connecting'
                    ? 'ray-look'
                    : voiceState === 'listening'
                    ? 'ray-listen'
                    : voiceState === 'interrupted'
                    ? 'opacity-50'
                    : 'ray-eye'
                } ${voiceState === 'standby' ? 'shadow-[0_0_12px_rgba(255,255,255,0.7)]' : ''}`}
                style={{ width: compact ? 8 : 16, height: compact ? 16 : voiceState === 'listening' ? 38 : 32 }}
              />
            ))
          )}
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
              Local brain: {ollamaRunning ? 'Ready' : 'Standby'}
            </span>
            {engineLabel && <span className="truncate max-w-[160px]">{engineLabel}</span>}
          </div>
        )}
      </div>
    </div>
  );
};
