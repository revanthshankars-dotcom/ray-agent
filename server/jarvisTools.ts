/**
 * JARVIS layer — one place that wires browser hands, daily learning, self-repair and the RAY
 * pop-up into the assistant's tool set.
 */
import { Type } from '@google/genai';
import type { FunctionDeclaration } from '@google/genai';
import { dispatchDeviceCommand } from './hub.ts';
import { browserToolDeclarations, executeBrowserTool } from './browserAgent.ts';
import { executeLearningTool, learningToolDeclarations } from './learning.ts';
import { executeRepairTool, repairToolDeclarations } from './repair.ts';
import type { ConfirmationRequest } from '../src/types/relay.ts';

export const jarvisToolDeclarations: FunctionDeclaration[] = [
  ...browserToolDeclarations,
  ...learningToolDeclarations,
  ...repairToolDeclarations,
  {
    name: 'show_ray',
    description: 'Pop the RAY window up on a device (PC opens a RAY app window, phone opens RAY) so Ray can talk to it there. Use for "open RAY on my PC/phone", "show yourself", or when a task needs his attention on that device.',
    parameters: { type: Type.OBJECT, properties: { device: { type: Type.STRING, description: '"pc", "phone", a name, or "all".' }, reason: { type: Type.STRING } } },
  },
];

export const JARVIS_TOOL_NAMES = new Set(jarvisToolDeclarations.map((d) => d.name || ''));

export async function executeJarvisTool(
  roomId: string,
  name: string,
  args: Record<string, unknown>,
  opts: { confirmed: boolean }
): Promise<{ result: string; confirmation?: ConfirmationRequest } | null> {
  if (!JARVIS_TOOL_NAMES.has(name)) return null;
  if (name === 'show_ray') {
    const out = await dispatchDeviceCommand({
      roomId,
      type: 'wake',
      targetQuery: String(args.device || 'pc'),
      source: 'assistant',
      payload: { popup: true, reason: String(args.reason || '') },
      waitForAckMs: 6000,
    });
    return { result: out.summary };
  }
  return (
    (await executeBrowserTool(roomId, name, args, opts)) ||
    (await executeLearningTool(roomId, name, args)) ||
    (await executeRepairTool(roomId, name, args, opts))
  );
}
