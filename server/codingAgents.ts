/**
 * Coding agents on Ray's computers: Claude Code, Codex CLI, Gemini CLI, Aider.
 * RAY starts them on Ray's command (one approval, even for several in parallel), they run in
 * the background on the PC, and RAY notifies every device when each one finishes.
 */
import { Type } from '@google/genai';
import type { FunctionDeclaration } from '@google/genai';
import { createConfirmationRequest } from './capabilities.ts';
import { broadcastHudSound, dispatchBridgeProxyCall, getRoomDevices } from './hub.ts';
import type { ConfirmationRequest, DeviceInfo } from '../src/types/relay.ts';

function codingBridges(roomId: string, deviceQuery?: string): DeviceInfo[] {
  const list = getRoomDevices(roomId).filter((d) => d.online && d.type === 'bridge' && d.capabilities?.includes('coding-agents'));
  const q = String(deviceQuery || '').toLowerCase();
  const named = q && !['auto', 'pc', 'computer'].includes(q) ? list.filter((d) => d.name.toLowerCase().includes(q)) : [];
  return named.length ? named : list;
}

function normAgent(a: string): string {
  const x = a.toLowerCase();
  if (/claude/.test(x)) return 'claude';
  if (/codex|openai/.test(x)) return 'codex';
  if (/gemini/.test(x)) return 'gemini';
  if (/aider/.test(x)) return 'aider';
  return 'claude';
}

export const codingAgentToolDeclarations: FunctionDeclaration[] = [
  {
    name: 'list_coding_agents',
    description: 'Which coding agents (Claude Code, Codex CLI, Gemini CLI, Aider) are installed on Ray’s PCs. Read-only.',
    parameters: { type: Type.OBJECT, properties: { device: { type: Type.STRING, description: 'Optional PC name.' } } },
  },
  {
    name: 'run_coding_agents',
    description:
      'Start one or more coding agents on Ray’s PC IN PARALLEL, each on its own task and folder. Only on Ray’s command. jobs: one job per line as "agent | folder | task", e.g. "claude | Documents/myapp | add unit tests for the login page". agent = claude, codex, gemini or aider.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        jobs: { type: Type.STRING, description: 'One job per line: "agent | folder | task".' },
        device: { type: Type.STRING, description: 'Optional PC name.' },
      },
      required: ['jobs'],
    },
  },
  {
    name: 'coding_agent_status',
    description: 'Progress/output of coding agent jobs RAY started (all recent, or one jobId). Read-only.',
    parameters: { type: Type.OBJECT, properties: { jobId: { type: Type.STRING, description: 'Optional job id.' } } },
  },
];

export async function executeCodingAgentTool(
  roomId: string,
  name: string,
  args: Record<string, unknown>,
  opts: { confirmed: boolean }
): Promise<{ result: string; confirmation?: ConfirmationRequest } | null> {
  if (!['list_coding_agents', 'run_coding_agents', 'coding_agent_status'].includes(name)) return null;
  const bridges = codingBridges(roomId, String(args.device || ''));
  if (!bridges.length) return { result: 'No PC bridge is online (update the bridge to the latest version for coding-agent support).' };
  const pc = bridges[0];

  if (name === 'list_coding_agents') {
    const out = await dispatchBridgeProxyCall(roomId, { action: 'list_coding_agents' }, 15000, pc.id);
    return { result: out.ok ? JSON.stringify(out.data) : `Could not check: ${out.error}` };
  }

  if (name === 'coding_agent_status') {
    const out = await dispatchBridgeProxyCall(roomId, { action: 'coding_agent_status', jobId: args.jobId }, 15000, pc.id);
    return { result: out.ok ? JSON.stringify(out.data).slice(0, 14000) : `Could not read status: ${out.error}` };
  }

  // run_coding_agents
  const jobs = String(args.jobs || '')
    .split(/\n|;;/)
    .map((l) => l.split('|').map((x) => x.trim()))
    .filter((p) => p.length >= 2 && p[p.length - 1])
    .map((p) => (p.length >= 3 ? { agent: normAgent(p[0]), folder: p[1], task: p.slice(2).join(' | ') } : { agent: normAgent(p[0]), folder: '', task: p[1] }))
    .slice(0, 6);
  if (!jobs.length) return { result: 'No jobs given. Format: "agent | folder | task" per line.' };
  if (!opts.confirmed) {
    const req = createConfirmationRequest({
      roomId,
      toolName: 'run_coding_agents',
      safetyLevel: 'sensitive',
      summary: `Run ${jobs.length} coding agent job(s) on ${pc.name}: ${jobs.map((j) => `${j.agent} in ${j.folder || 'Documents'} → ${j.task.slice(0, 60)}`).join('; ')}. They can edit files in those folders.`,
      targetDevice: pc.name,
      args,
    });
    broadcastHudSound(roomId, 'alert');
    return { result: `REQUIRES_CONFIRMATION: Ready to start ${jobs.length} coding agent job(s) in parallel on ${pc.name}. Waiting for Ray to tap Approve (confirmationId=${req.id}).`, confirmation: req };
  }
  const started = await Promise.all(
    jobs.map(async (j) => {
      const out = await dispatchBridgeProxyCall(roomId, { action: 'run_coding_agent', agent: j.agent, prompt: j.task, cwd: j.folder || undefined }, 20000, pc.id);
      const d = out.data as { jobId?: string; agent?: string; cwd?: string } | undefined;
      return out.ok ? `${d?.agent} started (job ${d?.jobId}) in ${d?.cwd}` : `${j.agent}: ${out.error}`;
    })
  );
  return { result: `${started.join('\n')}\nI'll notify every device when each finishes; ask "how are my coding agents doing?" any time.` };
}
