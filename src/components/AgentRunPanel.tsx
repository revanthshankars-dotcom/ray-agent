import { useEffect, useRef, useState } from 'react';
import { Bot, CheckCircle2, ChevronDown, ChevronUp, GraduationCap, Loader2, MousePointer2, Square, X } from 'lucide-react';
import { agentBus } from '../services/callBus';
import { authFetch } from '../utils/roomAuth';

interface AgentStep {
  step: number;
  thought?: string;
  say?: string;
  action?: { action: string; x?: number; y?: number; text?: string; keys?: string; app?: string };
  engine?: string;
}
interface AgentRun {
  taskId: string;
  task: string;
  target: 'pc' | 'phone';
  mode: 'do' | 'teach';
  status: 'running' | 'done' | 'stopped';
  steps: AgentStep[];
  screenshot?: string;
  result?: string;
}

function describe(a?: AgentStep['action']): string {
  if (!a) return '';
  switch (a.action) {
    case 'click':
    case 'double_click':
    case 'right_click':
      return `${a.action.replace('_', ' ')} at ${a.x}, ${a.y}`;
    case 'type':
      return `type “${(a.text || '').slice(0, 40)}”`;
    case 'hotkey':
    case 'key':
      return `press ${a.keys}`;
    case 'open_app':
      return `open ${a.app}`;
    default:
      return a.action;
  }
}

/** Floating live view of RAY's mouse/keyboard agent (screen, steps, Stop). */
export function AgentRunPanel({ roomId }: { roomId: string }) {
  const [run, setRun] = useState<AgentRun | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const listRef = useRef<HTMLOListElement | null>(null);

  useEffect(() => {
    const onUpdate = (e: Event) => {
      const d = (e as CustomEvent).detail as Record<string, unknown>;
      setRun((prev) => {
        const base: AgentRun =
          prev && prev.taskId === d.taskId
            ? prev
            : { taskId: String(d.taskId), task: String(d.task || ''), target: (d.target as 'pc' | 'phone') || 'pc', mode: (d.mode as 'do' | 'teach') || 'do', status: 'running', steps: [] };
        const next: AgentRun = { ...base, status: (d.status as AgentRun['status']) || base.status };
        if (typeof d.screenshot === 'string') next.screenshot = d.screenshot;
        if (typeof d.result === 'string') next.result = d.result;
        if (typeof d.step === 'number' && d.step > 0 && (d.thought || d.action)) {
          next.steps = [...base.steps.filter((s) => s.step !== d.step), { step: d.step as number, thought: d.thought as string, say: d.say as string, action: d.action as AgentStep['action'], engine: d.engine as string }];
        }
        return next;
      });
      setCollapsed(false);
    };
    agentBus.addEventListener('update', onUpdate);
    return () => agentBus.removeEventListener('update', onUpdate);
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [run?.steps.length]);

  if (!run) return null;
  const live = run.status === 'running';
  const stop = () => void authFetch('/api/jarvis/interrupt', roomId, { method: 'POST', body: JSON.stringify({ roomId }) });
  const last = run.steps[run.steps.length - 1];

  return (
    <div className="fixed z-[80] right-3 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] md:bottom-4 w-[min(420px,calc(100vw-1.5rem))] rounded-2xl border border-slate-200 dark:border-slate-700 bg-white/95 dark:bg-slate-900/95 backdrop-blur shadow-2xl overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-slate-100 dark:border-slate-800">
        <span className={`w-7 h-7 rounded-lg flex items-center justify-center text-white ${run.mode === 'teach' ? 'bg-violet-600' : 'bg-blue-600'}`}>
          {run.mode === 'teach' ? <GraduationCap className="w-4 h-4" /> : <MousePointer2 className="w-4 h-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] uppercase tracking-wide text-slate-500">
            RAY Agent · {run.mode === 'teach' ? 'teaching' : 'working'} on your {run.target}
          </p>
          <p className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">{run.task}</p>
        </div>
        {live ? (
          <button type="button" onClick={stop} className="h-8 px-3 inline-flex items-center gap-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-semibold">
            <Square className="w-3 h-3 fill-current" /> Stop
          </button>
        ) : (
          <button type="button" aria-label="Close" onClick={() => setRun(null)} className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600">
            <X className="w-4 h-4" />
          </button>
        )}
        <button type="button" aria-label={collapsed ? 'Expand' : 'Collapse'} onClick={() => setCollapsed((c) => !c)} className="p-1.5 rounded-lg text-slate-400">
          {collapsed ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
      </div>

      {!collapsed && (
        <>
          {run.screenshot && (
            <div className="relative bg-slate-950">
              <img src={run.screenshot} alt="What RAY sees" className="w-full max-h-56 object-contain" />
              {live && last?.action?.x != null && (
                <span className="absolute left-2 top-2 text-[10px] font-mono px-1.5 py-0.5 rounded bg-black/60 text-white">{describe(last.action)}</span>
              )}
            </div>
          )}
          <ol ref={listRef} className="max-h-44 overflow-y-auto px-3 py-2 space-y-2">
            {run.steps.map((s) => (
              <li key={s.step} className="text-xs">
                <p className="text-slate-900 dark:text-slate-100">
                  <span className="font-mono text-slate-400 mr-1">{s.step}.</span>
                  {s.say || describe(s.action)}
                </p>
                {s.thought && <p className="text-[11px] text-slate-500 dark:text-slate-400 line-clamp-2">{s.thought}</p>}
              </li>
            ))}
            {live && (
              <li className="flex items-center gap-2 text-xs text-slate-500">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Looking at the screen…
              </li>
            )}
          </ol>
          {!live && run.result && (
            <div className={`mx-3 mb-3 rounded-lg px-3 py-2 text-xs flex items-start gap-2 ${run.status === 'done' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-amber-500/10 text-amber-700 dark:text-amber-300'}`}>
              {run.status === 'done' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <Bot className="w-4 h-4 shrink-0" />}
              <span>{run.result}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
