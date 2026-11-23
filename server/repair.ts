/**
 * SELF-HEALING CLAUSE — RAY repairs itself, Ray's devices, apps and files.
 *
 *  diagnose_device  (read-only)  disk, memory, internet, frozen apps, recent app crashes, temp
 *                                files, battery, RAY bridge + Ollama health.
 *  repair_device    one command → diagnose → a plan from a fixed catalogue of safe fixes →
 *                   ONE approval → run each fix → re-check → report what changed (System/Repairs).
 *  restore_file     RAY backs up every file before it overwrites it; roll back any version.
 * Things the catalogue can't fix are handed on: UI problems → operate_computer (mouse),
 * broken code → run_coding_agents, website problems → browse_web.
 * RAY's own bridges update themselves automatically when the server has a newer version.
 */
import fs from 'fs';
import path from 'path';
import { Type } from '@google/genai';
import type { FunctionDeclaration } from '@google/genai';
import { createConfirmationRequest } from './capabilities.ts';
import { broadcastHudSound, broadcastRoomEvent, dispatchBridgeProxyCall, getRoomBrainNotes, getRoomDevices, upsertRoomBrainNote } from './hub.ts';
import { quickComplete } from './engines/router.ts';
import type { ConfirmationRequest, DeviceInfo } from '../src/types/relay.ts';

const FIX_CATALOG: Record<string, string> = {
  clear_temp: 'Delete temporary files older than 2 days (frees disk space)',
  flush_dns: 'Flush the DNS cache (fixes sites not loading)',
  renew_ip: 'Renew the network address (Windows; fixes "no internet")',
  kill_not_responding: 'Close apps that are frozen / not responding (Windows)',
  restart_explorer: 'Restart Windows Explorer (frozen taskbar/desktop)',
  restart_app: 'Restart one app (target = app name)',
  update_app: 'Update/reinstall one app via winget/brew/pkg (target = app name)',
  restart_ollama: 'Restart the local Ollama AI server',
  restart_bridge: 'Restart the RAY bridge on that device',
  self_update: 'Update the RAY bridge to the latest version',
  restore_file: 'Restore a file to its previous version (target = file path)',
};

let latestBridgeVersion = '';
export function getLatestBridgeVersion(): string {
  if (latestBridgeVersion) return latestBridgeVersion;
  try {
    const src = fs.readFileSync(path.join(process.cwd(), 'server', 'bridge', 'relay-bridge.mjs'), 'utf8');
    latestBridgeVersion = src.match(/BRIDGE_VERSION = '([^']+)'/)?.[1] || '';
  } catch {
    latestBridgeVersion = '';
  }
  return latestBridgeVersion;
}

function pickBridge(roomId: string, query: string): DeviceInfo | undefined {
  const bridges = getRoomDevices(roomId).filter((d) => d.online && d.type === 'bridge');
  const q = query.toLowerCase();
  if (!q || q === 'auto' || q === 'pc' || q === 'computer' || q === 'laptop') return bridges.find((d) => !/android/i.test(d.os)) || bridges[0];
  if (/phone|mobile|android/.test(q)) return bridges.find((d) => /android/i.test(d.os));
  return bridges.find((d) => d.name.toLowerCase().includes(q) || d.id.toLowerCase().includes(q)) || bridges[0];
}

function journal(roomId: string, entry: string) {
  const note = getRoomBrainNotes(roomId).find((n) => n.folder === 'System' && n.title === 'Repairs');
  const old = note ? note.content.split('\n').filter((l) => l.startsWith('- ')).slice(0, 80) : [];
  upsertRoomBrainNote(roomId, {
    title: 'Repairs',
    folder: 'System',
    content: `# Repairs\n\nEverything RAY diagnosed and fixed (newest first).\n\n${[`- ${new Date().toISOString().slice(0, 16).replace('T', ' ')} — ${entry}`, ...old].join('\n')}\n\n#system #self-healing`,
    source: 'jarvis',
  });
}

export const repairToolDeclarations: FunctionDeclaration[] = [
  {
    name: 'diagnose_device',
    description: 'Health check of Ray’s PC or phone: disk, memory, internet, frozen apps, recent app crashes, temp files, battery, RAY bridge. Read-only. Use for "why is my PC slow", "check my phone", "is everything ok".',
    parameters: { type: Type.OBJECT, properties: { device: { type: Type.STRING, description: '"pc" (default), "phone" or a device name.' } } },
  },
  {
    name: 'repair_device',
    description:
      'Fix problems on Ray’s PC/phone from ONE command ("fix my PC", "my internet is broken", "Chrome keeps freezing", "free up space"): diagnoses, plans safe fixes (clear temp, flush DNS, renew IP, close frozen apps, restart Explorer/an app, update an app, restart Ollama/RAY bridge, restore a file), asks Ray once, runs them, re-checks and reports.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        problem: { type: Type.STRING, description: 'What is wrong, in Ray’s words.' },
        device: { type: Type.STRING, description: '"pc" (default), "phone" or a device name.' },
      },
      required: ['problem'],
    },
  },
  {
    name: 'restore_file',
    description: 'Undo RAY’s change to a file: list saved versions (action "list") or restore the latest/a given version (action "restore"). RAY keeps the last 10 versions of every file it overwrote.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        path: { type: Type.STRING, description: 'File path on the device.' },
        action: { type: Type.STRING, description: '"list" (default) or "restore".' },
        version: { type: Type.STRING, description: 'Optional version id from the list.' },
        device: { type: Type.STRING, description: 'Device name (default PC).' },
      },
      required: ['path'],
    },
  },
];

export async function executeRepairTool(
  roomId: string,
  name: string,
  args: Record<string, unknown>,
  opts: { confirmed: boolean }
): Promise<{ result: string; confirmation?: ConfirmationRequest } | null> {
  if (!['diagnose_device', 'repair_device', 'restore_file'].includes(name)) return null;
  const dev = pickBridge(roomId, String(args.device || ''));
  if (!dev) return { result: `No RAY bridge is online on ${args.device || 'the PC'} — it must be connected to diagnose or repair it.` };
  if (!dev.capabilities?.includes('diagnose')) {
    return { result: `${dev.name} runs an older RAY bridge. Say "update RAY on ${dev.name}" (or reinstall from Connect) to get self-repair.` };
  }

  if (name === 'diagnose_device') {
    const out = await dispatchBridgeProxyCall(roomId, { action: 'diagnose' }, 60000, dev.id);
    return { result: out.ok ? JSON.stringify(out.data).slice(0, 9000) : `Diagnosis failed: ${out.error}` };
  }

  if (name === 'restore_file') {
    const p = String(args.path || '');
    if (String(args.action || 'list') !== 'restore') {
      const out = await dispatchBridgeProxyCall(roomId, { action: 'file_versions', path: p }, 20000, dev.id);
      return { result: out.ok ? JSON.stringify(out.data) : `Could not list versions: ${out.error}` };
    }
    if (!opts.confirmed) {
      const req = createConfirmationRequest({ roomId, toolName: 'restore_file', safetyLevel: 'sensitive', summary: `Restore ${p} on ${dev.name} to its ${args.version ? `version ${args.version}` : 'previous version'} (the current one is backed up first).`, targetDevice: dev.name, args });
      broadcastHudSound(roomId, 'alert');
      return { result: `REQUIRES_CONFIRMATION: restore ${p} — waiting for Ray's Approve (confirmationId=${req.id}).`, confirmation: req };
    }
    const out = await dispatchBridgeProxyCall(roomId, { action: 'repair', fix: 'restore_file', path: p, version: args.version }, 20000, dev.id);
    if (out.ok) journal(roomId, `Restored ${p} on ${dev.name}`);
    return { result: out.ok ? `Restored: ${JSON.stringify(out.data)}` : `Restore failed: ${out.error}` };
  }

  // repair_device
  const problem = String(args.problem || 'general check-up').slice(0, 400);
  const planned = Array.isArray(args.fixes) ? (args.fixes as Array<{ fix: string; target?: string; why?: string }>) : null;
  if (!opts.confirmed || !planned) {
    const diag = await dispatchBridgeProxyCall(roomId, { action: 'diagnose' }, 60000, dev.id);
    if (!diag.ok) return { result: `Could not diagnose ${dev.name}: ${diag.error}` };
    const report = JSON.stringify(diag.data).slice(0, 7000);
    let plan: { analysis?: string; fixes?: Array<{ fix: string; target?: string; why?: string }>; handoff?: string } = {};
    try {
      const out = await quickComplete(
        `Device: ${dev.name} (${dev.os})\nRay's problem: ${problem}\nDiagnosis:\n${report}\n\nAvailable fixes (use ONLY these ids):\n${Object.entries(FIX_CATALOG).map(([k, v]) => `- ${k}: ${v}`).join('\n')}\n\nThink through every likely cause. Reply ONLY JSON: {"analysis":"<2-3 sentences: likely causes>","fixes":[{"fix":"<id>","target":"<if needed>","why":"<short>"}],"handoff":"<if it needs the mouse (operate_computer), a coding agent or the browser, say what; else empty>"}. Max 5 fixes, least disruptive first; [] if nothing safe applies.`,
        'You are an expert IT technician. Be accurate and conservative.',
        'reasoning',
        { maxTokens: 700 }
      );
      plan = JSON.parse(out.match(/\{[\s\S]*\}/)?.[0] || '{}');
    } catch {
      plan = {};
    }
    const fixes = (plan.fixes || []).filter((f) => f && FIX_CATALOG[f.fix]).slice(0, 5);
    if (!fixes.length) {
      return { result: `Diagnosis of ${dev.name}: ${plan.analysis || 'no obvious fault.'}\n${plan.handoff ? `Next: ${plan.handoff}` : 'No safe automatic fix applies.'}\nRaw: ${report.slice(0, 2500)}` };
    }
    const req = createConfirmationRequest({
      roomId,
      toolName: 'repair_device',
      safetyLevel: 'sensitive',
      summary: `Repair ${dev.name}: ${fixes.map((f) => `${f.fix}${f.target ? ` (${f.target})` : ''}`).join(', ')}. ${plan.analysis || ''}`.slice(0, 480),
      targetDevice: dev.name,
      args: { problem, device: dev.id, fixes },
    });
    broadcastHudSound(roomId, 'alert');
    return {
      result: `REQUIRES_CONFIRMATION: Diagnosis — ${plan.analysis || ''}\nPlanned fixes:\n${fixes.map((f) => `- ${FIX_CATALOG[f.fix]}${f.target ? `: ${f.target}` : ''} — ${f.why || ''}`).join('\n')}${plan.handoff ? `\nAfterwards: ${plan.handoff}` : ''}\nWaiting for Ray to tap Approve (confirmationId=${req.id}).`,
      confirmation: req,
    };
  }

  const results: string[] = [];
  broadcastRoomEvent(roomId, 'agent:update', { taskId: `repair-${Date.now()}`, task: `Repair ${dev.name}: ${problem}`, target: 'repair', status: 'running', step: 0 });
  for (const f of planned.filter((x) => FIX_CATALOG[x.fix]).slice(0, 5)) {
    const out = await dispatchBridgeProxyCall(roomId, { action: 'repair', fix: f.fix, target: f.target, path: f.target }, f.fix === 'update_app' ? 600000 : 90000, dev.id);
    results.push(`${out.ok ? '✅' : '❌'} ${FIX_CATALOG[f.fix]}${f.target ? ` (${f.target})` : ''}: ${out.ok ? JSON.stringify(out.data).slice(0, 200) : out.error}`);
  }
  await new Promise((r) => setTimeout(r, 3000));
  const after = await dispatchBridgeProxyCall(roomId, { action: 'diagnose' }, 60000, dev.id);
  const issues = after.ok ? ((after.data as { issues?: string[] }).issues || []) : [];
  const summary = `${results.join('\n')}\n\nRe-check: ${after.ok ? (issues.length ? `still seeing: ${issues.join('; ')}` : 'no issues detected ✅') : 'device restarting / not reachable yet'}`;
  journal(roomId, `${dev.name} — "${problem}": ${results.map((r) => r.split(':')[0]).join(', ')}`);
  broadcastRoomEvent(roomId, 'agent:update', { taskId: `repair-done-${Date.now()}`, task: `Repair ${dev.name}: ${problem}`, target: 'repair', status: 'done', result: summary.slice(0, 1200) });
  broadcastHudSound(roomId, 'affirmative');
  return { result: summary };
}

/** RAY heals itself: bridges older than the server's version update themselves. */
const updateAttempts = new Map<string, number>();
export async function autoUpdateBridges(roomId: string): Promise<string[]> {
  const latest = getLatestBridgeVersion();
  const done: string[] = [];
  if (!latest) return done;
  for (const d of getRoomDevices(roomId)) {
    const ver = String((d.telemetry as Record<string, unknown> | undefined)?.bridgeVersion || '');
    if (!d.online || d.type !== 'bridge' || !ver || ver === latest || !d.capabilities?.includes('repair')) continue;
    if (Date.now() - (updateAttempts.get(d.id) || 0) < 6 * 3600_000) continue;
    updateAttempts.set(d.id, Date.now());
    const out = await dispatchBridgeProxyCall(roomId, { action: 'repair', fix: 'self_update' }, 60000, d.id);
    if (out.ok) {
      done.push(`${d.name}: ${ver} → ${latest}`);
      journal(roomId, `Self-update: RAY bridge on ${d.name} ${ver} → ${latest}`);
    }
  }
  return done;
}
