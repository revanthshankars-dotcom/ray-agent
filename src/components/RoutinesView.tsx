import React, { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Circle,
  ListPlus,
  Play,
  Plus,
  SearchCode,
  Timer,
  Trash2,
  Zap,
} from 'lucide-react';
import type {
  AppConnector,
  DeviceInfo,
  EngineSettings,
  RoutinePlan,
  SharedTask,
  SyncTimer,
  TaskAnalysisResult,
} from '../types/relay';
import { playHudSound } from '../utils/hudAudio';
import { authFetch } from '../utils/roomAuth';

interface RoutinesViewProps {
  roomId: string;
  localDeviceName: string;
  devices: DeviceInfo[];
  tasks: SharedTask[];
  timers: SyncTimer[];
  routines: RoutinePlan[];
  analyses: TaskAnalysisResult[];
  engineSettings: EngineSettings;
  googleAccessToken: string | null;
  notionToken: string;
  customConnectors: AppConnector[];
  onCreateTask: (
    title: string,
    assignedDevice: string,
    meta?: Pick<SharedTask, 'category' | 'priority' | 'effortMinutes' | 'analysisId'>
  ) => void;
  onToggleTask: (id: string) => void;
  onDeleteTask: (id: string) => void;
  onCreateTimer: (label: string, durationSeconds: number, targetDevice: string) => void;
  onCancelTimer: (id: string) => void;
  onDeleteRoutine: (id: string) => void;
  onSaveAnalysis: (analysis: TaskAnalysisResult) => void;
  onDeleteAnalysis: (id: string) => void;
}

export const RoutinesView: React.FC<RoutinesViewProps> = ({
  roomId,
  localDeviceName,
  devices,
  tasks,
  timers,
  routines,
  analyses,
  engineSettings,
  googleAccessToken,
  notionToken,
  customConnectors,
  onCreateTask,
  onToggleTask,
  onDeleteTask,
  onCreateTimer,
  onCancelTimer,
  onDeleteRoutine,
  onSaveAnalysis,
  onDeleteAnalysis,
}) => {
  const [analysisInput, setAnalysisInput] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [activeAnalysis, setActiveAnalysis] = useState<TaskAnalysisResult | null>(null);
  const [analysisStatus, setAnalysisStatus] = useState<string | null>(null);
  const [runningAnalysisSteps, setRunningAnalysisSteps] = useState(false);

  const [goalInput, setGoalInput] = useState('');
  const [planning, setPlanning] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [routineStatus, setRoutineStatus] = useState<string | null>(null);

  const [taskTitle, setTaskTitle] = useState('');
  const [taskDevice, setTaskDevice] = useState('All Devices');

  const [timerLabel, setTimerLabel] = useState('Focus Block');
  const [timerMinutes, setTimerMinutes] = useState(15);
  const [timerTarget, setTimerTarget] = useState('all');
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (timers.length === 0) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [timers.length]);

  const runTaskAnalysis = async (taskText: string) => {
    const clean = taskText.trim();
    if (!clean || analyzing) return;
    setAnalyzing(true);
    setAnalysisStatus(null);
    playHudSound('blip');
    try {
      const res = await authFetch('/api/ai/analyze-task', roomId, {
        method: 'POST',
        body: JSON.stringify({ roomId, goal: clean, engine: engineSettings }),
      });
      const data = (await res.json()) as Partial<TaskAnalysisResult> & {
        analysis?: TaskAnalysisResult;
        error?: string;
      };
      const resolved = data.analysis || (data.id ? (data as TaskAnalysisResult) : undefined);
      if (!res.ok || !resolved) {
        throw new Error(data.error || 'Task analysis failed');
      }
      setActiveAnalysis(resolved);
      onSaveAnalysis(resolved);
      playHudSound('affirmative');
    } catch (err) {
      setAnalysisStatus(err instanceof Error ? err.message : 'Failed to analyze task');
    } finally {
      setAnalyzing(false);
    }
  };

  const handleAnalyzeSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void runTaskAnalysis(analysisInput);
  };

  const handlePromoteSubtasks = (analysis: TaskAnalysisResult) => {
    const items = analysis.subtasks.length > 0 ? analysis.subtasks : [analysis.goal];
    const perTaskMinutes = Math.max(5, Math.round(analysis.effortMinutes / Math.max(1, items.length)));
    items.forEach((sub) => {
      onCreateTask(sub, analysis.recommendedDevice || 'All Devices', {
        category: analysis.category,
        priority: analysis.priority,
        effortMinutes: perTaskMinutes,
        analysisId: analysis.id,
      });
    });
    playHudSound('affirmative');
    setAnalysisStatus(`Added ${items.length} analyzed sub-tasks to the Shared Task Queue.`);
  };

  const handleExecuteAnalysisSteps = async (analysis: TaskAnalysisResult) => {
    if (analysis.executableSteps.length === 0 || runningAnalysisSteps) return;
    setRunningAnalysisSteps(true);
    setAnalysisStatus(null);
    try {
      const steps = analysis.executableSteps.map((s) => {
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = JSON.parse(s.argsJson || '{}') as Record<string, unknown>;
        } catch {
          parsedArgs = {};
        }
        return {
          toolName: s.toolName,
          targetDevice: s.targetDevice,
          description: s.description,
          args: parsedArgs,
        };
      });

      const res = await authFetch(
        '/api/routines/run',
        roomId,
        {
          method: 'POST',
          body: JSON.stringify({
            roomId,
            sourceDeviceName: localDeviceName,
            steps,
            customConnectors,
          }),
        },
        { googleAccessToken, notionToken }
      );
      const data = (await res.json()) as { results?: string[]; error?: string };
      if (!res.ok) throw new Error(data.error || 'Execution failed');
      playHudSound('affirmative');
      setAnalysisStatus(`Executed steps: ${(data.results || []).join(' · ')}`);
    } catch (err) {
      setAnalysisStatus(err instanceof Error ? err.message : 'Step execution failed');
    } finally {
      setRunningAnalysisSteps(false);
    }
  };

  const handlePlanRoutine = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!goalInput.trim() || planning) return;
    setPlanning(true);
    setRoutineStatus(null);
    try {
      const res = await authFetch('/api/ai/plan-routine', roomId, {
        method: 'POST',
        body: JSON.stringify({ roomId, goal: goalInput.trim() }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error || 'Could not generate routine');
      setGoalInput('');
      playHudSound('affirmative');
    } catch (err) {
      setRoutineStatus(err instanceof Error ? err.message : 'Failed to create routine');
    } finally {
      setPlanning(false);
    }
  };

  const handleRunRoutine = async (routine: RoutinePlan) => {
    setRunningId(routine.id);
    setRoutineStatus(null);
    try {
      const res = await authFetch(
        '/api/routines/run',
        roomId,
        {
          method: 'POST',
          body: JSON.stringify({
            roomId,
            sourceDeviceName: localDeviceName,
            steps: routine.steps,
            customConnectors,
          }),
        },
        { googleAccessToken, notionToken }
      );
      const data = (await res.json()) as { results?: string[]; error?: string };
      if (!res.ok) throw new Error(data.error || 'Failed to run routine');
      playHudSound('affirmative');
      setRoutineStatus(`Executed "${routine.title}": ${(data.results || []).join(' · ')}`);
    } catch (err) {
      setRoutineStatus(err instanceof Error ? err.message : 'Routine execution failed');
    } finally {
      setRunningId(null);
    }
  };

  const handleAddTask = (e: React.FormEvent) => {
    e.preventDefault();
    if (!taskTitle.trim()) return;
    onCreateTask(taskTitle.trim(), taskDevice);
    setTaskTitle('');
  };

  const handleStartTimer = (e: React.FormEvent) => {
    e.preventDefault();
    onCreateTimer(timerLabel.trim() || 'Timer', Math.max(5, Math.round(timerMinutes * 60)), timerTarget);
  };

  const displayedAnalysis = activeAnalysis || analyses[0] || null;

  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6 space-y-8">
      <div>
        <h1 className="font-display text-xl font-bold text-slate-900 dark:text-slate-100">
          Task Analysis Engine, Routines & Timers
        </h1>
        <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
          Evaluate any task with RAY — coding, system ops, research, personal, or cross-device workflows — then promote sub-tasks or execute automated steps.
        </p>
      </div>

      {/* Universal Task Analysis Engine */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Universal Task Analysis Engine
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Submit any goal or task. RAY evaluates domain, priority, effort estimate, blockers, safety level, and cross-device actionability.
          </p>
        </div>

        <form onSubmit={handleAnalyzeSubmit} className="flex flex-col sm:flex-row gap-2">
          <input
            type="text"
            value={analysisInput}
            onChange={(e) => setAnalysisInput(e.target.value)}
            placeholder="e.g. Audit Docker memory spikes, refactor OAuth refresh flow, or prep tomorrow's architecture review"
            className="flex-1 px-3 py-2 text-sm bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100"
          />
          <button
            type="submit"
            disabled={!analysisInput.trim() || analyzing}
            className="inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            <SearchCode className="w-3.5 h-3.5" />
            <span>{analyzing ? 'Analyzing...' : 'Analyze Task'}</span>
          </button>
        </form>

        {analysisStatus && (
          <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-xs text-slate-700 dark:text-slate-300">
            {analysisStatus}
          </div>
        )}

        {displayedAnalysis && (
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 p-4 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
              <div>
                <div className="text-[11px] font-mono uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  {displayedAnalysis.category} · {displayedAnalysis.priority} priority ·{' '}
                  <span className="tabular-nums">{displayedAnalysis.effortMinutes}m est.</span> ·{' '}
                  {displayedAnalysis.recommendedDevice} · safety: {displayedAnalysis.safetyLevel}
                </div>
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mt-1">
                  {displayedAnalysis.goal}
                </h3>
                <p className="text-xs text-slate-600 dark:text-slate-400 mt-1 leading-relaxed">
                  {displayedAnalysis.summary}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => handlePromoteSubtasks(displayedAnalysis)}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg whitespace-nowrap"
                >
                  <ListPlus className="w-3.5 h-3.5" />
                  <span>Promote Sub-tasks</span>
                </button>
                {displayedAnalysis.executableSteps.length > 0 && (
                  <button
                    type="button"
                    disabled={runningAnalysisSteps}
                    onClick={() => void handleExecuteAnalysisSteps(displayedAnalysis)}
                    className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 hover:opacity-90 disabled:opacity-50 rounded-lg whitespace-nowrap"
                  >
                    <Play className="w-3.5 h-3.5" />
                    <span>{runningAnalysisSteps ? 'Executing...' : 'Execute Steps'}</span>
                  </button>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2 border-t border-slate-200 dark:border-slate-800 text-xs">
              <div>
                <div className="font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                  Actionable Sub-tasks
                </div>
                <ol className="space-y-1 text-slate-600 dark:text-slate-400">
                  {displayedAnalysis.subtasks.map((s, idx) => (
                    <li key={idx}>
                      <span className="font-mono text-slate-500">{idx + 1}.</span> {s}
                    </li>
                  ))}
                </ol>
              </div>

              <div className="space-y-3">
                {displayedAnalysis.blockers.length > 0 && (
                  <div>
                    <div className="font-semibold text-slate-700 dark:text-slate-300 mb-1">
                      Risks & Blockers
                    </div>
                    <ul className="space-y-1 text-slate-600 dark:text-slate-400">
                      {displayedAnalysis.blockers.map((b, idx) => (
                        <li key={idx}>· {b}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {displayedAnalysis.executableSteps.length > 0 && (
                  <div>
                    <div className="font-semibold text-slate-700 dark:text-slate-300 mb-1">
                      Device Steps ({displayedAnalysis.executableSteps.length})
                    </div>
                    <ul className="space-y-1 text-slate-600 dark:text-slate-400">
                      {displayedAnalysis.executableSteps.map((step, idx) => (
                        <li key={idx}>
                          <span className="font-mono text-slate-500">{step.toolName}</span> · {step.description}{' '}
                          <span className="text-slate-400">({step.targetDevice})</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {analyses.length > 1 && (
          <div className="pt-2 border-t border-slate-100 dark:border-slate-800 space-y-1.5">
            <div className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">
              Recent Analysis Dossiers
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {analyses.slice(0, 6).map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-800 text-xs"
                >
                  <button
                    type="button"
                    onClick={() => setActiveAnalysis(item)}
                    className="text-left min-w-0 flex-1 hover:text-blue-600 dark:hover:text-blue-400"
                  >
                    <div className="font-medium text-slate-900 dark:text-slate-100 truncate">
                      {item.goal}
                    </div>
                    <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                      {item.category} · {item.priority} · {item.effortMinutes}m
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (displayedAnalysis?.id === item.id) setActiveAnalysis(null);
                      onDeleteAnalysis(item.id);
                    }}
                    aria-label={`Delete analysis ${item.goal}`}
                    className="p-1 text-slate-400 hover:text-red-600 shrink-0"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* AI Routine Builder */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            AI Routine Builder
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Describe a multi-device workflow and RAY will compile executable device steps.
          </p>
        </div>

        <form onSubmit={handlePlanRoutine} className="flex flex-col sm:flex-row gap-2">
          <input
            type="text"
            value={goalInput}
            onChange={(e) => setGoalInput(e.target.value)}
            placeholder="e.g. Notify my phone to step away, start a 10 minute break timer, and read a stretch reminder aloud"
            className="flex-1 px-3 py-2 text-sm bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100"
          />
          <button
            type="submit"
            disabled={!goalInput.trim() || planning}
            className="inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            <Zap className="w-3.5 h-3.5" />
            <span>{planning ? 'Generating...' : 'Generate Routine'}</span>
          </button>
        </form>

        {routineStatus && (
          <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-xs text-slate-700 dark:text-slate-300">
            {routineStatus}
          </div>
        )}

        {routines.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2">
            {routines.map((routine) => (
              <div
                key={routine.id}
                className="rounded-lg border border-slate-200 dark:border-slate-800 p-4 flex flex-col justify-between gap-3"
              >
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      {routine.title}
                    </h3>
                    <button
                      type="button"
                      onClick={() => onDeleteRoutine(routine.id)}
                      aria-label={`Delete routine ${routine.title}`}
                      className="text-slate-400 hover:text-red-600 p-1 rounded"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <ol className="mt-2 space-y-1 text-xs text-slate-600 dark:text-slate-400">
                    {routine.steps.map((step, i) => (
                      <li key={i}>
                        <span className="font-mono text-slate-500">{i + 1}.</span>{' '}
                        {step.description}{' '}
                        <span className="text-slate-400">({step.targetDevice})</span>
                      </li>
                    ))}
                  </ol>
                </div>

                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => handleRunRoutine(routine)}
                    disabled={runningId === routine.id}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-slate-900 dark:bg-slate-100 dark:text-slate-900 hover:opacity-90 disabled:opacity-50 rounded-lg whitespace-nowrap shrink-0"
                  >
                    <Play className="w-3 h-3" />
                    <span>{runningId === routine.id ? 'Running...' : 'Run Routine'}</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Shared Task Queue */}
        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Shared Task Queue ({tasks.filter((t) => !t.completed).length} open)
          </h2>

          <form onSubmit={handleAddTask} className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              value={taskTitle}
              onChange={(e) => setTaskTitle(e.target.value)}
              placeholder="Add a cross-device task..."
              className="flex-1 px-3 py-2 text-sm bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100"
            />
            <select
              value={taskDevice}
              onChange={(e) => setTaskDevice(e.target.value)}
              aria-label="Assign task to device"
              className="px-2.5 py-2 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100"
            >
              <option value="All Devices">All Devices</option>
              {devices.map((d) => (
                <option key={d.id} value={d.name}>
                  {d.name}
                </option>
              ))}
            </select>
            <button
              type="submit"
              disabled={!taskTitle.trim()}
              className="inline-flex items-center justify-center gap-1 px-3 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg whitespace-nowrap shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add</span>
            </button>
          </form>

          {tasks.length === 0 ? (
            <p className="text-xs text-slate-500 dark:text-slate-400 py-4 text-center">
              No tasks yet. Add one above or ask RAY to add tasks for you.
            </p>
          ) : (
            <ul className="divide-y divide-slate-200 dark:divide-slate-800">
              {tasks.map((task) => (
                <li key={task.id} className="py-2.5 flex items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => onToggleTask(task.id)}
                    className="flex items-start gap-2.5 text-left min-w-0 flex-1"
                  >
                    {task.completed ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 mt-0.5 shrink-0" />
                    ) : (
                      <Circle className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" />
                    )}
                    <span className="min-w-0">
                      <span
                        className={`block text-sm ${
                          task.completed
                            ? 'line-through text-slate-400 dark:text-slate-500'
                            : 'text-slate-900 dark:text-slate-100'
                        }`}
                      >
                        {task.title}
                      </span>
                      <span className="block text-xs text-slate-500 dark:text-slate-400 font-mono">
                        {task.assignedDevice}
                        {task.priority ? ` · ${task.priority}` : ''}
                        {task.effortMinutes ? ` · ${task.effortMinutes}m` : ''}
                      </span>
                    </span>
                  </button>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      disabled={analyzing}
                      onClick={() => {
                        setAnalysisInput(task.title);
                        void runTaskAnalysis(task.title);
                      }}
                      title="Analyze task with RAY"
                      className="px-2 py-1 text-[11px] font-medium border border-slate-200 dark:border-slate-700 rounded text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
                    >
                      Analyze
                    </button>
                    <button
                      type="button"
                      onClick={() => onDeleteTask(task.id)}
                      aria-label={`Delete task ${task.title}`}
                      className="p-1 text-slate-400 hover:text-red-600 rounded"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Synchronized Timers */}
        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Synchronized Device Timers
          </h2>

          <form onSubmit={handleStartTimer} className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <input
              type="text"
              value={timerLabel}
              onChange={(e) => setTimerLabel(e.target.value)}
              placeholder="Timer label"
              className="px-3 py-2 text-sm bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100"
            />
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                min={0.1}
                max={480}
                step={0.5}
                value={timerMinutes}
                onChange={(e) => setTimerMinutes(Number(e.target.value))}
                aria-label="Duration in minutes"
                className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100"
              />
              <span className="text-xs text-slate-500 shrink-0">min</span>
            </div>
            <button
              type="submit"
              className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg whitespace-nowrap shrink-0"
            >
              <Timer className="w-3.5 h-3.5" />
              <span>Start Timer</span>
            </button>
          </form>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-slate-500">Target:</span>
            <select
              value={timerTarget}
              onChange={(e) => setTimerTarget(e.target.value)}
              aria-label="Timer target device"
              className="px-2.5 py-1 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100"
            >
              <option value="all">All Online Devices</option>
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            {[1, 5, 15, 25].map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setTimerMinutes(m)}
                className="px-2.5 py-1 text-xs font-mono border border-slate-200 dark:border-slate-700 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300"
              >
                {m}m
              </button>
            ))}
          </div>

          {timers.length === 0 ? (
            <p className="text-xs text-slate-500 dark:text-slate-400 py-4 text-center">
              No active timers running.
            </p>
          ) : (
            <ul className="divide-y divide-slate-200 dark:divide-slate-800">
              {timers.map((t) => {
                const remaining = Math.max(0, Math.ceil((t.endsAt - now) / 1000));
                const mins = Math.floor(remaining / 60);
                const secs = remaining % 60;
                return (
                  <li key={t.id} className="py-2.5 flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                        {t.label}
                      </div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">
                        Target: {t.targetDevice}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="font-mono text-base font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                        {remaining === 0
                          ? 'Done'
                          : `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`}
                      </span>
                      <button
                        type="button"
                        onClick={() => onCancelTimer(t.id)}
                        className="px-2 py-1 text-xs border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-100 dark:hover:bg-slate-800"
                      >
                        Cancel
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
};
