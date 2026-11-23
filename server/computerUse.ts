/**
 * Computer use — RAY gets a mouse and keyboard.
 *
 * Loop: screenshot (PC, or Android phone through ADB on the PC bridge) → a free vision model
 * decides ONE next step → the bridge performs it → repeat until done.
 *  - mode "do":    complete the task.
 *  - mode "teach": glide the pointer to each target, explain the step out loud, then do it
 *                  slowly — so Ray learns how.
 * Safety: requires "Screen Control" armed + one Approve per task; Ray can stop it any time
 * (Stop button / "RAY stop"); max steps; never types passwords or pays on its own.
 * Self-learning: finished tasks are saved as "Skills/…" notes and reused as hints next time.
 */
import crypto from 'crypto';
import { Type } from '@google/genai';
import type { FunctionDeclaration } from '@google/genai';
import { createConfirmationRequest } from './capabilities.ts';
import {
  broadcastHudSound,
  broadcastRoomEvent,
  dispatchBridgeProxyCall,
  getRoomBrainNotes,
  isRoomInterrupted,
  isRoomScreenControlArmed,
  pickExecutorDevice,
  setRoomInterrupted,
  upsertRoomBrainNote,
} from './hub.ts';
import { visionComplete } from './engines/router.ts';
import type { ConfirmationRequest } from '../src/types/relay.ts';

interface AgentStepAction {
  action: 'click' | 'double_click' | 'right_click' | 'type' | 'hotkey' | 'key' | 'scroll' | 'open_app' | 'wait' | 'done' | 'ask_user';
  x?: number;
  y?: number;
  text?: string;
  keys?: string;
  deltaY?: number;
  app?: string;
}

interface AgentPlanStep {
  thought: string;
  say?: string;
  action: AgentStepAction;
}

const running = new Map<string, { taskId: string; task: string }>();

const SYSTEM = `You control a real computer/phone for Ray, one step at a time, by looking at screenshots.
Reply with ONLY JSON: {"thought":"<what you see and why>","say":"<one short sentence to tell Ray, for teaching>","action":{...}}
Actions:
 {"action":"click","x":<int>,"y":<int>}  {"action":"double_click","x":..,"y":..}  {"action":"right_click","x":..,"y":..}
 {"action":"type","text":"..."}  {"action":"hotkey","keys":"ctrl+l"}  {"action":"key","keys":"enter|back|home|tab|escape"}
 {"action":"scroll","x":..,"y":..,"deltaY":600}  {"action":"open_app","app":"chrome"}  {"action":"wait"}
 {"action":"done","text":"<result for Ray>"}  {"action":"ask_user","text":"<question>"}
Rules: coordinates are pixels in THIS screenshot (origin top-left). Click the CENTER of the target.
Prefer keyboard shortcuts and open_app when faster. Never type passwords, card numbers or OTPs, never confirm payments,
never delete data — use ask_user instead. Use "done" as soon as the goal is visibly achieved.`;

function parsePlan(text: string): AgentPlanStep | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as AgentPlanStep;
    if (!j.action || typeof j.action.action !== 'string') return null;
    return j;
  } catch {
    return null;
  }
}

function findSkill(roomId: string, task: string): string {
  const words = task.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
  const skills = getRoomBrainNotes(roomId).filter((n) => n.folder === 'Skills');
  let best: { score: number; content: string } | null = null;
  for (const n of skills) {
    const t = `${n.title} ${n.content}`.toLowerCase();
    const score = words.filter((w) => t.includes(w)).length;
    if (score >= 2 && (!best || score > best.score)) best = { score, content: n.content.slice(0, 1200) };
  }
  return best ? `\nA similar task worked before like this (use as a hint, the screen may differ):\n${best.content}` : '';
}

async function runLoop(roomId: string, taskId: string, task: string, target: 'pc' | 'phone', mode: 'do' | 'teach', bridgeId: string) {
  const emit = (data: Record<string, unknown>) => broadcastRoomEvent(roomId, 'agent:update', { taskId, task, target, mode, ...data });
  const history: string[] = [];
  const maxSteps = mode === 'teach' ? 20 : 30;
  setRoomInterrupted(roomId, false);
  emit({ status: 'running', step: 0 });
  const skillHint = findSkill(roomId, task);
  let finalText = '';
  let success = false;

  for (let step = 1; step <= maxSteps; step++) {
    if (isRoomInterrupted(roomId) || !isRoomScreenControlArmed(roomId)) {
      finalText = 'Stopped by Ray.';
      break;
    }
    const shot = await dispatchBridgeProxyCall(roomId, { action: 'agent_screenshot', target }, 30000, bridgeId);
    const img = shot.data as { dataUrl?: string; width?: number; height?: number; screenW?: number; screenH?: number } | undefined;
    if (!shot.ok || !img?.dataUrl) {
      finalText = `Could not see the ${target} screen: ${shot.error}`;
      break;
    }
    let plan: AgentPlanStep | null = null;
    let engine = '';
    try {
      const v = await visionComplete(
        SYSTEM,
        `Task: ${task}\nMode: ${mode === 'teach' ? 'TEACH Ray (explain each step clearly in "say")' : 'do it'}\nDevice: ${target}\nScreenshot size: ${img.width}x${img.height}\nStep ${step}/${maxSteps}.\nPrevious steps:\n${history.slice(-8).join('\n') || '(none)'}${skillHint}`,
        img.dataUrl
      );
      plan = parsePlan(v.text);
      engine = v.engine;
    } catch (err) {
      finalText = `Vision engine error: ${err instanceof Error ? err.message : err}`;
      break;
    }
    if (!plan) {
      history.push(`${step}. (unreadable plan — retrying)`);
      continue;
    }
    const a = plan.action;
    // Map image coordinates → real screen coordinates.
    const sx = (img.screenW || img.width || 1) / (img.width || 1);
    const sy = (img.screenH || img.height || 1) / (img.height || 1);
    const mapped = { ...a, x: a.x != null ? Math.round(a.x * sx) : undefined, y: a.y != null ? Math.round(a.y * sy) : undefined };
    emit({ status: 'running', step, thought: plan.thought, say: plan.say, action: a, engine, screenshot: img.dataUrl.length < 600_000 ? img.dataUrl : undefined });

    if (a.action === 'done') {
      finalText = a.text || 'Done.';
      success = true;
      break;
    }
    if (a.action === 'ask_user') {
      finalText = `I need you: ${a.text || 'please take over for this step.'}`;
      break;
    }
    if (mode === 'teach') {
      if (plan.say) await dispatchBridgeProxyCall(roomId, { action: 'speak', text: `Step ${step}. ${plan.say}` }, 30000, bridgeId);
      if (mapped.x != null && target === 'pc') {
        await dispatchBridgeProxyCall(roomId, { action: 'agent_act', target, step: { action: 'glide', x: mapped.x, y: mapped.y } }, 10000, bridgeId);
        await new Promise((r) => setTimeout(r, 900));
      }
    }
    if (a.action === 'wait') {
      await new Promise((r) => setTimeout(r, 1500));
      history.push(`${step}. waited`);
      continue;
    }
    const res = await dispatchBridgeProxyCall(roomId, { action: 'agent_act', target, step: mapped }, 20000, bridgeId);
    history.push(`${step}. ${a.action}${a.x != null ? ` (${a.x},${a.y})` : ''}${a.text ? ` "${a.text.slice(0, 40)}"` : ''}${a.keys ? ` ${a.keys}` : ''}${a.app ? ` ${a.app}` : ''} → ${res.ok ? 'ok' : `failed: ${res.error}`} — ${plan.thought.slice(0, 120)}`);
    await new Promise((r) => setTimeout(r, mode === 'teach' ? 1800 : 900));
  }

  if (!finalText) finalText = `Stopped after ${maxSteps} steps without finishing.`;
  emit({ status: success ? 'done' : 'stopped', result: finalText, steps: history });
  broadcastHudSound(roomId, success ? 'affirmative' : 'alert');
  running.delete(roomId);

  // Self-learning: remember how this task was done.
  if (success && history.length) {
    upsertRoomBrainNote(roomId, {
      title: `Skill: ${task.slice(0, 80)}`,
      folder: 'Skills',
      content: `# Skill: ${task}\n\nDevice: ${target} · learned ${new Date().toISOString().slice(0, 10)}\n\n## Steps that worked\n${history.map((h) => `- ${h}`).join('\n')}\n\nResult: ${finalText}\n\n#skill #computer-use`,
      source: 'jarvis',
    });
  }
}

export const computerUseToolDeclarations: FunctionDeclaration[] = [
  {
    name: 'operate_computer',
    description:
      'Use the mouse and keyboard to COMPLETE a task on Ray’s PC screen, or on his Android phone (via ADB from the PC). mode "teach" shows him how step by step (moves the pointer, explains each step aloud). Use for "do X in app Y", "fill this form", "teach me / show me how to …". Needs Screen Control armed + his approval.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        task: { type: Type.STRING, description: 'The goal in plain words, e.g. "turn on dark mode in Windows settings".' },
        device: { type: Type.STRING, description: '"pc" (default) or "phone".' },
        mode: { type: Type.STRING, description: '"do" (default) or "teach".' },
      },
      required: ['task'],
    },
  },
  {
    name: 'stop_computer_task',
    description: 'Stop RAY’s running mouse/keyboard task immediately.',
    parameters: { type: Type.OBJECT, properties: {} },
  },
];

export async function executeComputerUseTool(
  roomId: string,
  name: string,
  args: Record<string, unknown>,
  opts: { confirmed: boolean }
): Promise<{ result: string; confirmation?: ConfirmationRequest } | null> {
  if (name === 'stop_computer_task') {
    setRoomInterrupted(roomId, true);
    return { result: 'Stopped the screen task.' };
  }
  if (name !== 'operate_computer') return null;
  const task = String(args.task || '').trim();
  if (!task) return { result: 'What should I do on the screen?' };
  const target = /phone|mobile|android/i.test(String(args.device || '')) ? 'phone' : 'pc';
  const mode = /teach|show/i.test(String(args.mode || '')) ? 'teach' : 'do';
  if (!isRoomScreenControlArmed(roomId)) {
    return { result: 'Screen Control is OFF. Ask Ray to switch on "Screen Control Armed" in the Assistant toolbar, then try again.' };
  }
  const bridge = pickExecutorDevice(roomId, 'pc', 'os');
  if (!bridge || bridge.type !== 'bridge' || /android/i.test(bridge.os)) {
    return { result: 'The PC bridge must be online to see and control the screen (it also controls the phone through ADB).' };
  }
  if (running.has(roomId)) return { result: `Already working on: ${running.get(roomId)!.task}. Say "stop" to cancel it first.` };
  if (!opts.confirmed) {
    const req = createConfirmationRequest({
      roomId,
      toolName: 'operate_computer',
      safetyLevel: 'sensitive',
      summary: `${mode === 'teach' ? 'Teach you' : 'Control the mouse & keyboard'} on your ${target}: "${task}". You can press Stop at any time.`,
      targetDevice: target,
      args: { task, device: target, mode },
    });
    broadcastHudSound(roomId, 'alert');
    return { result: `REQUIRES_CONFIRMATION: Ready to ${mode === 'teach' ? 'show you how' : 'do it'} on your ${target}. Tap Approve to let me use the mouse (confirmationId=${req.id}).`, confirmation: req };
  }
  const taskId = crypto.randomUUID().slice(0, 8);
  running.set(roomId, { taskId, task });
  void runLoop(roomId, taskId, task, target, mode, bridge.id).catch((err) => {
    running.delete(roomId);
    broadcastRoomEvent(roomId, 'agent:update', { taskId, task, status: 'stopped', result: `Error: ${err instanceof Error ? err.message : err}` });
  });
  return { result: `Started (${mode}) on your ${target}: "${task}". Watch the RAY Agent panel; say "stop" any time.` };
}
