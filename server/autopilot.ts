/**
 * AUTONOMY CLAUSE — Autopilot, self-learning and self-healing.
 *
 * Autopilot (self-thinking): every N minutes RAY looks at what is happening (messages, battery,
 * devices, tasks, scheduled calls, failures, memory) and decides whether to act. Levels:
 *   off      – never runs.
 *   observe  – thinks and writes suggestions to the Autopilot Journal + a notification.
 *   assist   – also does SAFE things on its own: notifications, speaking reminders (not in quiet
 *              hours), creating tasks, writing Second Brain notes, waking devices, reading
 *              messages/files to brief Ray.
 * It NEVER on its own: sends messages, places phone calls, writes/deletes files, closes apps,
 * uses the mouse, or runs coding agents. Those always need Ray's command.
 *
 * Self-learning: after conversations RAY extracts durable facts (people, preferences, routines,
 * projects) into "Memory/About Ray" and uses them in every answer; computer-use runs become
 * "Skills/…" notes.
 * Self-healing: a watchdog re-wakes devices with stuck commands, retries offline bridges, notices
 * failing engines and writes a System Health note, alerting Ray only when something changes.
 */
import { dispatchDeviceCommand, getIncomingMessages, getRoomBrainNotes, getRoomDevices, getRoomSnapshot, listRoomIds, upsertRoomBrainNote } from './hub.ts';
import { loadJson, scheduleSave } from './persistence.ts';
import { getEngineStatus } from './engines/providers.ts';
import { quickComplete } from './engines/router.ts';
import { listScheduledCalls } from './calls.ts';
import { autoUpdateBridges } from './repair.ts';

export type AutopilotLevel = 'off' | 'observe' | 'assist';
export interface AutopilotSettings {
  level: AutopilotLevel;
  intervalMin: number;
  quietStart: number; // local hour
  quietEnd: number;
  lastRunAt?: number;
  lastSummary?: string;
}

const DEFAULTS: AutopilotSettings = { level: 'assist', intervalMin: 30, quietStart: 23, quietEnd: 7 };
const settings = new Map<string, AutopilotSettings>();
const SAFE_TOOLS = new Set([
  'send_device_notification',
  'speak_on_device',
  'manage_shared_task',
  'upsert_brain_note',
  'wake_device',
  'read_incoming_messages',
  'search_file_index',
  'get_device_telemetry',
  'diagnose_device',
  'learn_about',
  'read_web_page',
  'web_search',
]);

function tzOffsetMin(): number {
  return Number(process.env.RAY_TZ_OFFSET_MINUTES ?? 330);
}
function localNow(): Date {
  return new Date(Date.now() + tzOffsetMin() * 60_000);
}
function inQuietHours(s: AutopilotSettings): boolean {
  const h = localNow().getUTCHours();
  return s.quietStart > s.quietEnd ? h >= s.quietStart || h < s.quietEnd : h >= s.quietStart && h < s.quietEnd;
}

export async function getAutopilot(roomId: string): Promise<AutopilotSettings> {
  if (!settings.has(roomId)) {
    const stored = await loadJson<AutopilotSettings & Record<string, unknown>>(`autopilot-${roomId}`);
    settings.set(roomId, { ...DEFAULTS, ...(stored || {}) });
  }
  return settings.get(roomId)!;
}

export async function setAutopilot(roomId: string, patch: Partial<AutopilotSettings>): Promise<AutopilotSettings> {
  const cur = await getAutopilot(roomId);
  const next: AutopilotSettings = {
    ...cur,
    ...(patch.level && ['off', 'observe', 'assist'].includes(patch.level) ? { level: patch.level } : {}),
    ...(patch.intervalMin ? { intervalMin: Math.max(10, Math.min(240, Number(patch.intervalMin))) } : {}),
    ...(patch.quietStart != null ? { quietStart: Math.max(0, Math.min(23, Number(patch.quietStart))) } : {}),
    ...(patch.quietEnd != null ? { quietEnd: Math.max(0, Math.min(23, Number(patch.quietEnd))) } : {}),
  };
  settings.set(roomId, next);
  scheduleSave(`autopilot-${roomId}`, () => ({ ...next }), 500);
  return next;
}

function memoryExcerpt(roomId: string, lines = 25): string {
  const mem = getRoomBrainNotes(roomId).find((n) => n.folder === 'Memory' && /about ray/i.test(n.title));
  if (!mem) return '';
  return mem.content
    .split('\n')
    .filter((l) => l.startsWith('- '))
    .slice(0, lines)
    .join('\n');
}

export { memoryExcerpt };

async function buildContext(roomId: string): Promise<{ text: string; signals: string[] }> {
  const snap = getRoomSnapshot(roomId);
  const signals: string[] = [];
  const devices = snap.devices.map((d) => {
    const b = d.telemetry?.batteryLevel;
    if (d.online && b != null && b <= 15 && !d.telemetry?.batteryCharging) signals.push(`${d.name} battery ${b}%`);
    if ((d.queuedCount || 0) > 0) signals.push(`${d.name} has ${d.queuedCount} queued command(s)`);
    return `- ${d.name} (${d.type}) ${d.online ? 'online' : 'offline'}${b != null ? ` battery ${b}%` : ''}`;
  });
  const unread = getIncomingMessages(roomId, { unreadOnly: true, limit: 8 });
  if (unread.length) signals.push(`${unread.length} unread message(s)`);
  const tasks = snap.tasks.filter((t) => !t.completed).slice(0, 10);
  const calls = (await listScheduledCalls(roomId)).slice(0, 5);
  const failing = getEngineStatus().filter((e) => e.configured && e.failuresToday >= 5 && e.requestsToday === 0);
  if (failing.length) signals.push(`engines failing: ${failing.map((e) => e.id).join(', ')}`);
  const local = localNow();
  const hour = local.getUTCHours();
  if (hour >= 7 && hour < 9) signals.push('morning');
  const text = `Local time: ${local.toISOString().replace('T', ' ').slice(0, 16)}
Devices:\n${devices.join('\n') || 'none'}
Unread messages:\n${unread.map((m) => `- [${m.app}] ${m.from}: ${m.text.slice(0, 120)}`).join('\n') || 'none'}
Open tasks:\n${tasks.map((t) => `- ${t.title} (${t.priority})`).join('\n') || 'none'}
Scheduled calls:\n${calls.map((c) => `- ${new Date(c.nextAt).toISOString()} ${c.message}`).join('\n') || 'none'}
Known about Ray:\n${memoryExcerpt(roomId, 15) || 'nothing yet'}`;
  return { text, signals };
}

function appendJournal(roomId: string, entry: string) {
  const existing = getRoomBrainNotes(roomId).find((n) => n.title === 'Autopilot Journal');
  const header = '# Autopilot Journal\n\nWhat RAY noticed and did on its own. Settings: Connections → Autopilot.\n\n';
  const body = existing ? existing.content.replace(/^# Autopilot Journal[\s\S]*?\n\n(?=## )/m, '') : '';
  const entries = (`## ${localNow().toISOString().replace('T', ' ').slice(0, 16)}\n${entry}\n\n` + body).split(/(?=^## )/m).slice(0, 40).join('');
  upsertRoomBrainNote(roomId, { title: 'Autopilot Journal', folder: 'System', content: header + entries + '\n#autopilot', source: 'jarvis' });
}

/** One Autopilot cycle. Returns what happened (for the UI "Run now"). */
export async function runAutopilot(roomId: string, opts: { force?: boolean } = {}): Promise<string> {
  const s = await getAutopilot(roomId);
  if (s.level === 'off' && !opts.force) return 'Autopilot is off.';
  const { text, signals } = await buildContext(roomId);
  s.lastRunAt = Date.now();
  if (!signals.length && !opts.force) {
    s.lastSummary = 'All quiet — nothing needed.';
    scheduleSave(`autopilot-${roomId}`, () => ({ ...s }), 2000);
    return s.lastSummary;
  }
  const quiet = inQuietHours(s);
  let raw = '';
  try {
    raw = await quickComplete(
      `${text}\n\nSignals: ${signals.join('; ') || 'none'}\nQuiet hours now: ${quiet ? 'YES (no speaking, only silent notifications)' : 'no'}\n\nDecide what RAY should proactively do for Ray right now. Reply ONLY JSON:\n{"thoughts":"<1-2 sentences>","actions":[{"tool":"send_device_notification|speak_on_device|manage_shared_task|upsert_brain_note|wake_device","args":{...},"reason":"..."}]}\nUse at most 3 actions, [] if nothing is worth interrupting Ray for. Morning: a short brief (unread messages, tasks, calls, battery) as one notification. Never message other people or call anyone.`,
      'You are RAY’s autopilot: proactive but never noisy. Only act when it clearly helps Ray.',
      'chat'
    );
  } catch (err) {
    s.lastSummary = `Could not think this round: ${err instanceof Error ? err.message : err}`;
    return s.lastSummary;
  }
  let plan: { thoughts?: string; actions?: Array<{ tool: string; args?: Record<string, unknown>; reason?: string }> } = {};
  try {
    plan = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || '{}');
  } catch {
    plan = { thoughts: raw.slice(0, 200), actions: [] };
  }
  const done: string[] = [];
  const suggested: string[] = [];
  const { executeDeviceTool } = await import('./gemini.ts');
  for (const a of (plan.actions || []).slice(0, 3)) {
    if (!SAFE_TOOLS.has(a.tool)) {
      suggested.push(`(not allowed on its own) ${a.tool}: ${a.reason || ''}`);
      continue;
    }
    if (quiet && a.tool === 'speak_on_device') continue;
    if (s.level === 'observe') {
      suggested.push(`${a.tool} — ${a.reason || JSON.stringify(a.args).slice(0, 100)}`);
      continue;
    }
    try {
      const out = await executeDeviceTool(roomId, 'RAY Autopilot', a.tool, a.args || {}, 'Fenrir', {});
      done.push(`${a.tool} — ${a.reason || ''} → ${out.result.slice(0, 120)}`);
    } catch (err) {
      done.push(`${a.tool} failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (s.level === 'observe' && suggested.length) {
    await dispatchDeviceCommand({
      roomId,
      type: 'notify',
      targetQuery: 'all',
      source: 'assistant',
      payload: { title: 'RAY suggests', message: suggested.slice(0, 2).join(' · ').slice(0, 200) },
      waitForAckMs: 300,
    });
  }
  const summary = `${plan.thoughts || 'Checked in.'}${done.length ? `\nDid:\n${done.map((d) => `- ${d}`).join('\n')}` : ''}${suggested.length ? `\nSuggested:\n${suggested.map((d) => `- ${d}`).join('\n')}` : ''}`;
  appendJournal(roomId, `Signals: ${signals.join('; ') || 'none'}\n${summary}`);
  s.lastSummary = summary.slice(0, 500);
  scheduleSave(`autopilot-${roomId}`, () => ({ ...s }), 2000);
  return summary;
}

// ---------------------------------------------------------------------------
// Self-learning: extract durable facts about Ray from conversations
// ---------------------------------------------------------------------------

const LEARN_HINT = /\b(i|i'm|im|my|me|mine|remember|prefer|always|never|call me|mom|dad|mother|father|wife|husband|brother|sister|friend|boss|birthday|work|office|college|live|favou?rite|allergic|usually)\b/i;
const lastLearnAt = new Map<string, number>();

export function learnFromTurn(roomId: string, userText: string, reply: string): void {
  if (!userText || userText.length < 12 || !LEARN_HINT.test(userText)) return;
  const now = Date.now();
  if (now - (lastLearnAt.get(roomId) || 0) < 20_000 && !/remember/i.test(userText)) return;
  lastLearnAt.set(roomId, now);
  void (async () => {
    try {
      const out = await quickComplete(
        `User said: "${userText.slice(0, 1200)}"\nAssistant replied: "${reply.slice(0, 600)}"\n\nList NEW durable facts about the user worth remembering for months (people & relationships, phone numbers they gave, preferences, routines, projects, places). Not one-off requests, not secrets/passwords/OTPs. Reply ONLY a JSON array of short strings, or [] if none.`,
        'You maintain a careful long-term memory for a personal assistant.',
        'quick'
      );
      const facts = (JSON.parse(out.match(/\[[\s\S]*\]/)?.[0] || '[]') as unknown[]).map(String).filter((f) => f.length > 3 && f.length < 200).slice(0, 5);
      if (!facts.length) return;
      const note = getRoomBrainNotes(roomId).find((n) => n.folder === 'Memory' && /about ray/i.test(n.title));
      const existing = note ? note.content.split('\n').filter((l) => l.startsWith('- ')) : [];
      const lower = new Set(existing.map((l) => l.toLowerCase()));
      const fresh = facts.map((f) => `- ${f}`).filter((l) => !lower.has(l.toLowerCase()));
      if (!fresh.length) return;
      const lines = [...fresh, ...existing].slice(0, 150);
      upsertRoomBrainNote(roomId, {
        title: 'About Ray',
        folder: 'Memory',
        content: `# About Ray\n\nWhat RAY has learned from conversations (newest first). Edit or delete any line — RAY follows this note.\n\n${lines.join('\n')}\n\n#memory`,
        source: 'jarvis',
      });
    } catch {
      // learning is best-effort
    }
  })();
}

// ---------------------------------------------------------------------------
// Self-healing watchdog
// ---------------------------------------------------------------------------

const lastHealth = new Map<string, string>();
const bridgeSeen = new Map<string, number>();

async function watchdog(roomId: string) {
  const issues: string[] = [];
  const snap = getRoomSnapshot(roomId);
  for (const d of snap.devices) {
    if (d.online && d.type === 'bridge') bridgeSeen.set(d.id, Date.now());
    const seen = bridgeSeen.get(d.id);
    if (!d.online && d.type === 'bridge' && seen && Date.now() - seen < 24 * 3600_000 && Date.now() - d.lastSeen > 15 * 60_000) {
      issues.push(`${d.name} has been offline for ${Math.round((Date.now() - d.lastSeen) / 60000)} min`);
      // Heal: try to wake it (push / Wake-on-LAN through another bridge).
      void dispatchDeviceCommand({ roomId, type: 'wake', targetQuery: d.id, source: 'assistant', payload: {}, waitForAckMs: 300 });
    }
    if ((d.queuedCount || 0) > 0 && Date.now() - d.lastSeen > 60 * 60_000) issues.push(`${d.name}: ${d.queuedCount} command(s) waiting over an hour`);
  }
  // Heal RAY itself: outdated bridges update themselves to the server's version.
  try {
    for (const u of await autoUpdateBridges(roomId)) issues.push(`Updated RAY bridge ${u}`);
  } catch {
    /* best-effort */
  }
  for (const e of getEngineStatus()) {
    if (e.configured && e.failuresToday >= 5 && e.requestsToday === 0) {
      issues.push(`AI engine ${e.label} keeps failing (${e.failuresToday} errors)${e.lastError ? `: ${e.lastError.message.slice(0, 100)}` : ''} — RAY routes around it automatically`);
    }
  }
  const key = issues.join('|');
  if (key === (lastHealth.get(roomId) || '')) return;
  const isNew = issues.filter((i) => !(lastHealth.get(roomId) || '').includes(i.split(' ')[0]));
  lastHealth.set(roomId, key);
  upsertRoomBrainNote(roomId, {
    title: 'System Health',
    folder: 'System',
    content: `# System Health\n\nChecked ${localNow().toISOString().replace('T', ' ').slice(0, 16)} by RAY's self-healing watchdog.\n\n${issues.length ? issues.map((i) => `- ⚠️ ${i}`).join('\n') : '- ✅ Everything is healthy.'}\n\n#system #health`,
    source: 'jarvis',
  });
  if (isNew.length) {
    await dispatchDeviceCommand({
      roomId,
      type: 'notify',
      targetQuery: 'all',
      source: 'assistant',
      payload: { title: 'RAY self-check', message: isNew.slice(0, 2).join(' · ').slice(0, 200) },
      waitForAckMs: 300,
    });
  }
}

let started = false;
export function startAutonomy(): void {
  if (started) return;
  started = true;
  setInterval(async () => {
    for (const roomId of listRoomIds()) {
      if (!getRoomDevices(roomId).length) continue;
      try {
        await watchdog(roomId);
        const s = await getAutopilot(roomId);
        if (s.level !== 'off' && Date.now() - (s.lastRunAt || 0) >= s.intervalMin * 60_000) await runAutopilot(roomId);
      } catch (err) {
        console.warn('[RAY autonomy]', err instanceof Error ? err.message : err);
      }
    }
  }, 5 * 60_000).unref();
}
