import crypto from 'crypto';
import type {
  CapabilityMeta,
  ConfirmationRequest,
  ProtocolName,
  ProtocolResult,
  SafetyLevel,
} from '../src/types/relay.ts';
import {
  broadcastHudSound,
  clearCompletedTasks,
  clearStaleHandoffs,
  dispatchDeviceCommand,
  getRoomSnapshot,
  setRoomVeronicaMode,
} from './hub.ts';

const CONFIRMATION_TTL_MS = 5 * 60 * 1000;

export const CAPABILITIES_CATALOG: CapabilityMeta[] = [
  {
    name: 'open_application',
    description: 'Launch an application on the connected Desktop OS Bridge (Brave, Chrome, Notion, Obsidian, WhatsApp, VS Code, etc.).',
    category: 'application',
    safetyLevel: 'safe',
    requiresConfirmation: false,
    parameters: [{ name: 'app_name', type: 'string', required: true, description: 'App name (brave, chrome, notion, obsidian, whatsapp, vscode, etc.)' }],
  },
  {
    name: 'close_application',
    description: 'Gracefully close a non-protected application on the Desktop OS Bridge.',
    category: 'application',
    safetyLevel: 'moderate',
    requiresConfirmation: false,
    parameters: [{ name: 'app_name', type: 'string', required: true, description: 'Application name to close' }],
  },
  {
    name: 'kill_process',
    description: 'Terminate a process by name or PID (safelist-enforced, requires confirmation).',
    category: 'application',
    safetyLevel: 'sensitive',
    requiresConfirmation: true,
    parameters: [{ name: 'process_identifier', type: 'string', required: true, description: 'Process name or PID' }],
  },
  {
    name: 'capture_screen_snapshot',
    description: 'Capture a live desktop screenshot from the Desktop OS Bridge for RAY screen vision.',
    category: 'screen',
    safetyLevel: 'safe',
    requiresConfirmation: false,
    parameters: [{ name: 'reason', type: 'string', required: false, description: 'Why screen inspection was requested' }],
  },
  {
    name: 'control_screen_input',
    description: 'Execute guarded mouse move/click, scroll, keyboard typing, or hotkey on Ray’s screen (requires Armed switch + confirmation).',
    category: 'screen',
    safetyLevel: 'sensitive',
    requiresConfirmation: true,
    parameters: [
      { name: 'action', type: 'string', required: true, description: 'mouse_move | mouse_click | mouse_double_click | scroll_screen | type_text | press_hotkey | focus_window' },
      { name: 'x', type: 'number', required: false, description: 'X coordinate' },
      { name: 'y', type: 'number', required: false, description: 'Y coordinate' },
      { name: 'text', type: 'string', required: false, description: 'Text to type' },
      { name: 'keys', type: 'string', required: false, description: 'Hotkey combo e.g. ctrl+c' },
    ],
  },
  {
    name: 'inspect_active_screen_and_window',
    description: 'Capture live desktop screenshot along with active foreground window title and running processes.',
    category: 'screen',
    safetyLevel: 'safe',
    requiresConfirmation: false,
    parameters: [{ name: 'reason', type: 'string', required: false, description: 'Why screen/window inspection is needed' }],
  },
  {
    name: 'list_system_files',
    description: 'List files and folders inside sandboxed desktop directories (Desktop, Documents, Downloads, Second Brain Vault).',
    category: 'files',
    safetyLevel: 'safe',
    requiresConfirmation: false,
    parameters: [{ name: 'dirPath', type: 'string', required: false, description: 'Directory path or root alias (desktop | documents | downloads | vault)' }],
  },
  {
    name: 'search_system_files',
    description: 'Search filenames and file text inside sandboxed desktop directories (secrets like .env/.ssh automatically blocked).',
    category: 'files',
    safetyLevel: 'safe',
    requiresConfirmation: false,
    parameters: [
      { name: 'query', type: 'string', required: true, description: 'Filename or text query' },
      { name: 'dirPath', type: 'string', required: false, description: 'Optional root directory to search' },
    ],
  },
  {
    name: 'read_system_file',
    description: 'Read a text/code/markdown file inside allowed desktop directories (secrets & symlink escapes blocked).',
    category: 'files',
    safetyLevel: 'safe',
    requiresConfirmation: false,
    parameters: [
      { name: 'filePath', type: 'string', required: true, description: 'Absolute or sandbox-relative file path' },
      { name: 'startLine', type: 'number', required: false, description: 'Optional 1-indexed start line' },
      { name: 'endLine', type: 'number', required: false, description: 'Optional 1-indexed end line' },
    ],
  },
  {
    name: 'write_system_file',
    description: 'Create or update a file inside allowed desktop directories (strictly confirmation-gated HITL approval).',
    category: 'files',
    safetyLevel: 'sensitive',
    requiresConfirmation: true,
    parameters: [
      { name: 'filePath', type: 'string', required: true, description: 'Target file path inside allowed directories' },
      { name: 'content', type: 'string', required: true, description: 'UTF-8 file content to write' },
    ],
  },
  {
    name: 'search_second_brain',
    description: 'Search Ray’s Obsidian-style Second Brain vault by keyword, tag, or folder.',
    category: 'brain',
    safetyLevel: 'safe',
    requiresConfirmation: false,
    parameters: [{ name: 'query', type: 'string', required: true, description: 'Search keywords or #tag' }],
  },
  {
    name: 'read_brain_note',
    description: 'Read a specific note and its backlinks from the Second Brain vault.',
    category: 'brain',
    safetyLevel: 'safe',
    requiresConfirmation: false,
    parameters: [{ name: 'titleOrId', type: 'string', required: true, description: 'Note title, slug, or ID' }],
  },
  {
    name: 'upsert_brain_note',
    description: 'Create or update a Markdown note in the Second Brain vault with [[wikilinks]] and #tags.',
    category: 'brain',
    safetyLevel: 'safe',
    requiresConfirmation: false,
    parameters: [
      { name: 'title', type: 'string', required: true, description: 'Note title' },
      { name: 'content', type: 'string', required: true, description: 'Markdown content' },
      { name: 'folder', type: 'string', required: false, description: 'Optional folder name' },
    ],
  },
  {
    name: 'link_brain_notes',
    description: 'Link two Second Brain notes via [[wikilink]] inside the Knowledge Graph.',
    category: 'brain',
    safetyLevel: 'safe',
    requiresConfirmation: false,
    parameters: [
      { name: 'sourceTitle', type: 'string', required: true, description: 'Source note title' },
      { name: 'targetTitle', type: 'string', required: true, description: 'Target note title to link' },
    ],
  },
  {
    name: 'google_workspace_action',
    description: 'Read or manage Gmail, Google Calendar, Google Drive, Google Docs, Google Sheets, Google Tasks, and Contacts (mutations require confirmation).',
    category: 'workspace',
    safetyLevel: 'moderate',
    requiresConfirmation: false,
    parameters: [
      { name: 'action', type: 'string', required: true, description: 'Action key (e.g., gmail_list_messages, gmail_send_email, calendar_list_events, calendar_create_event, drive_search_files, drive_create_doc, sheets_read_range, tasks_list_tasks, contacts_search)' },
      { name: 'argsJson', type: 'string', required: false, description: 'JSON object string of action arguments' },
    ],
  },
  {
    name: 'invoke_app_connector',
    description: 'Invoke a connected external or custom app (Brave, Notion, Notebook, WhatsApp, Instagram, or user-added webhook/launcher).',
    category: 'connector',
    safetyLevel: 'moderate',
    requiresConfirmation: false,
    parameters: [
      { name: 'connectorName', type: 'string', required: true, description: 'Connector name or ID' },
      { name: 'queryOrPayload', type: 'string', required: false, description: 'Search query, message text, or JSON payload' },
    ],
  },
  {
    name: 'list_connected_devices',
    description: 'List every paired device in the workspace mesh with online status and capabilities.',
    category: 'system',
    safetyLevel: 'safe',
    requiresConfirmation: false,
    parameters: [],
  },
  {
    name: 'get_device_telemetry',
    description: 'Refresh and read battery, CPU load, memory, network, display, and top processes.',
    category: 'system',
    safetyLevel: 'safe',
    requiresConfirmation: false,
    parameters: [{ name: 'targetDevice', type: 'string', required: true, description: 'Device name, ID, type, or "all"' }],
  },
  {
    name: 'adjust_volume',
    description: 'Adjust speaker volume level on the Desktop OS Bridge (0–100).',
    category: 'system',
    safetyLevel: 'safe',
    requiresConfirmation: false,
    parameters: [{ name: 'level', type: 'number', required: true, description: 'Volume percentage (0-100)' }],
  },
  {
    name: 'optimize_system',
    description: 'Inspect resource hogs and purge non-critical workspace clutter (requires confirmation).',
    category: 'system',
    safetyLevel: 'sensitive',
    requiresConfirmation: true,
    parameters: [{ name: 'targetDevice', type: 'string', required: false, description: 'Bridge device or "bridge"' }],
  },
  {
    name: 'set_device_timer',
    description: 'Start a synchronized countdown timer across target devices.',
    category: 'system',
    safetyLevel: 'safe',
    requiresConfirmation: false,
    parameters: [
      { name: 'targetDevice', type: 'string', required: true, description: 'Target device or "all"' },
      { name: 'durationSeconds', type: 'number', required: true, description: 'Duration in seconds' },
      { name: 'label', type: 'string', required: true, description: 'Timer label' },
    ],
  },
  {
    name: 'request_device_snapshot',
    description: 'Trigger camera snapshot capture on a paired phone, tablet, or desktop browser.',
    category: 'gui',
    safetyLevel: 'safe',
    requiresConfirmation: false,
    parameters: [
      { name: 'targetDevice', type: 'string', required: true, description: 'Target device name or type' },
      { name: 'reason', type: 'string', required: true, description: 'Purpose of visual capture' },
    ],
  },
  {
    name: 'open_url_on_device',
    description: 'Open a URL in the OS browser or launch card on connected devices.',
    category: 'browser',
    safetyLevel: 'safe',
    requiresConfirmation: false,
    parameters: [
      { name: 'targetDevice', type: 'string', required: true, description: 'Target device or "all"' },
      { name: 'url', type: 'string', required: true, description: 'Full https:// URL' },
    ],
  },
  {
    name: 'push_clipboard_handoff',
    description: 'Copy text, code, or links to a connected device clipboard and shared Handoff feed.',
    category: 'browser',
    safetyLevel: 'safe',
    requiresConfirmation: false,
    parameters: [
      { name: 'targetDevice', type: 'string', required: true, description: 'Target device or "all"' },
      { name: 'label', type: 'string', required: true, description: 'Handoff label' },
      { name: 'content', type: 'string', required: true, description: 'Text, URL, or code snippet' },
    ],
  },
  {
    name: 'send_device_notification',
    description: 'Dispatch an alert notification and HUD chime to connected devices.',
    category: 'notification',
    safetyLevel: 'safe',
    requiresConfirmation: false,
    parameters: [
      { name: 'targetDevice', type: 'string', required: true, description: 'Target device or "all"' },
      { name: 'title', type: 'string', required: true, description: 'Notification title' },
      { name: 'message', type: 'string', required: true, description: 'Notification body' },
    ],
  },
  {
    name: 'speak_on_device',
    description: 'Synthesize RAY speech and play aloud on connected device speakers.',
    category: 'notification',
    safetyLevel: 'safe',
    requiresConfirmation: false,
    parameters: [
      { name: 'targetDevice', type: 'string', required: true, description: 'Target device or "all"' },
      { name: 'text', type: 'string', required: true, description: 'Spoken text' },
    ],
  },
  {
    name: 'manage_shared_task',
    description: 'Create or complete tasks in the cross-device shared queue.',
    category: 'protocol',
    safetyLevel: 'safe',
    requiresConfirmation: false,
    parameters: [
      { name: 'action', type: 'string', required: true, description: '"create" or "complete"' },
      { name: 'title', type: 'string', required: true, description: 'Task title or match string' },
    ],
  },
  {
    name: 'execute_protocol',
    description: 'Execute movie protocols: clean_slate (sensitive), house_party, sentry_mode, or veronica.',
    category: 'protocol',
    safetyLevel: 'moderate',
    requiresConfirmation: false,
    parameters: [{ name: 'protocol_name', type: 'string', required: true, description: 'clean_slate | house_party | sentry_mode | veronica' }],
  },
];

const pendingConfirmations = new Map<string, ConfirmationRequest>();

function purgeExpiredConfirmations(): void {
  const now = Date.now();
  for (const [id, req] of pendingConfirmations.entries()) {
    if (req.expiresAt && now > req.expiresAt) {
      pendingConfirmations.delete(id);
    }
  }
}

export function createConfirmationRequest(params: {
  roomId: string;
  toolName: string;
  safetyLevel: SafetyLevel;
  summary: string;
  targetDevice: string;
  args: Record<string, unknown>;
}): ConfirmationRequest {
  purgeExpiredConfirmations();
  const now = Date.now();
  // Reuse the pending request for the same action instead of piling up duplicates on retries.
  const argsKey = JSON.stringify(params.args);
  for (const existing of pendingConfirmations.values()) {
    if (existing.roomId === params.roomId && existing.toolName === params.toolName && JSON.stringify(existing.args) === argsKey) {
      return existing;
    }
  }
  const req: ConfirmationRequest = {
    id: crypto.randomUUID(),
    roomId: params.roomId,
    toolName: params.toolName,
    safetyLevel: params.safetyLevel,
    summary: params.summary,
    targetDevice: params.targetDevice,
    args: params.args,
    createdAt: now,
    expiresAt: now + CONFIRMATION_TTL_MS,
  };
  pendingConfirmations.set(req.id, req);
  return req;
}

export function getConfirmationRequest(id: string): ConfirmationRequest | undefined {
  purgeExpiredConfirmations();
  return pendingConfirmations.get(id);
}

export function consumeConfirmationRequest(id: string, roomId: string): ConfirmationRequest | undefined {
  purgeExpiredConfirmations();
  const req = pendingConfirmations.get(id);
  if (!req) return undefined;
  if (req.roomId !== roomId) return undefined;
  pendingConfirmations.delete(id);
  if (req.expiresAt && Date.now() > req.expiresAt) return undefined;
  return req;
}

export function getCapabilityMeta(name: string): CapabilityMeta | undefined {
  return CAPABILITIES_CATALOG.find((c) => c.name === name);
}

export async function executeProtocol(
  roomId: string,
  protocolName: string,
  confirmed = false
): Promise<ProtocolResult> {
  const normalized = protocolName.trim().toLowerCase().replace(/[\s-]+/g, '_') as ProtocolName;
  const now = Date.now();

  switch (normalized) {
    case 'clean_slate': {
      if (!confirmed) {
        const req = createConfirmationRequest({
          roomId,
          toolName: 'execute_protocol',
          safetyLevel: 'sensitive',
          summary:
            'Initiate Protocol Clean Slate: purge completed tasks, clear stale handoffs (>1h), and scan non-protected OS Bridge processes while keeping critical system/browser apps safelisted.',
          targetDevice: 'all',
          args: { protocol_name: 'clean_slate' },
        });
        return {
          success: false,
          requiresConfirmation: true,
          confirmationId: req.id,
          protocol: 'Protocol Clean Slate',
          protocolKey: 'clean_slate',
          speechResponse:
            'Protocol Clean Slate is classified as sensitive, Ray. Please confirm authorization before I purge completed workspace items and non-protected processes.',
          details: { pendingConfirmationId: req.id },
          executedAt: now,
        };
      }

      const clearedTasks = clearCompletedTasks(roomId);
      const clearedHandoffs = clearStaleHandoffs(roomId, 3_600_000);
      const bridgeResult = await dispatchDeviceCommand({
        roomId,
        type: 'bridge_command',
        targetQuery: 'bridge',
        source: 'protocol',
        payload: { action: 'clean_slate' },
        waitForAckMs: 2200,
      });

      broadcastHudSound(roomId, 'clean_slate');
      return {
        success: true,
        protocol: 'Protocol Clean Slate',
        protocolKey: 'clean_slate',
        speechResponse: `Protocol Clean Slate complete, Ray. Purged ${clearedTasks} completed tasks and ${clearedHandoffs} stale handoffs while keeping all protected system processes intact.`,
        details: {
          clearedTasks,
          clearedHandoffs,
          bridgeSummary: bridgeResult.summary,
        },
        executedAt: now,
      };
    }

    case 'house_party': {
      await dispatchDeviceCommand({
        roomId,
        type: 'refresh_telemetry',
        targetQuery: 'all',
        source: 'protocol',
        payload: {},
        waitForAckMs: 2000,
      });

      const snapshot = getRoomSnapshot(roomId);
      const online = snapshot.devices.filter((d) => d.online);
      const offline = snapshot.devices.filter((d) => !d.online);

      const telemetrySummary = online.map((d) => ({
        name: d.name,
        type: d.type,
        battery: d.telemetry.batteryLevel ?? null,
        cpuPercent: d.telemetry.cpuPercent ?? null,
        memoryPercent: d.telemetry.memoryPercent ?? null,
        network: d.telemetry.networkType || 'connected',
      }));

      broadcastHudSound(roomId, 'protocol');
      return {
        success: true,
        protocol: 'House Party Protocol',
        protocolKey: 'house_party',
        speechResponse: `House Party Protocol engaged, Ray. ${online.length} device${
          online.length === 1 ? '' : 's'
        } reporting online across room ${snapshot.roomId} with ${snapshot.tasks.filter((t) => !t.completed).length} open tasks and ${snapshot.timers.length} active timer${snapshot.timers.length === 1 ? '' : 's'}.`,
        details: {
          onlineCount: online.length,
          offlineCount: offline.length,
          devices: telemetrySummary,
          openTasks: snapshot.tasks.filter((t) => !t.completed).length,
          activeTimers: snapshot.timers.length,
        },
        executedAt: now,
      };
    }

    case 'sentry_mode': {
      const snapshot = getRoomSnapshot(roomId);
      const anomalies: string[] = [];

      for (const dev of snapshot.devices) {
        if (!dev.online) {
          anomalies.push(`${dev.name} is offline`);
        }
        if (typeof dev.telemetry.cpuPercent === 'number' && dev.telemetry.cpuPercent > 75) {
          anomalies.push(`${dev.name} CPU elevated (${dev.telemetry.cpuPercent}%)`);
        }
        if (typeof dev.telemetry.memoryPercent === 'number' && dev.telemetry.memoryPercent > 85) {
          anomalies.push(`${dev.name} memory elevated (${dev.telemetry.memoryPercent}%)`);
        }
        for (const proc of dev.telemetry.topProcesses || []) {
          if (proc.cpuPercent > 50 || proc.memoryPercent > 30) {
            anomalies.push(`${dev.name} process ${proc.name} (${proc.cpuPercent}% CPU, ${proc.memoryPercent}% RAM)`);
          }
        }
      }

      const securityStatus: 'SECURE' | 'ELEVATED' = anomalies.length > 0 ? 'ELEVATED' : 'SECURE';
      broadcastHudSound(roomId, anomalies.length > 0 ? 'alert' : 'affirmative');

      return {
        success: true,
        protocol: 'Sentry Mode',
        protocolKey: 'sentry_mode',
        securityStatus,
        speechResponse:
          securityStatus === 'SECURE'
            ? `Sentry Mode scan complete, Ray. Perimeter is SECURE across ${snapshot.devices.filter((d) => d.online).length} active devices with zero anomalies.`
            : `Sentry Mode alert, Ray. Status is ELEVATED: ${anomalies.slice(0, 3).join('; ')}.`,
        details: {
          securityStatus,
          scannedDevices: snapshot.devices.length,
          anomalies,
        },
        executedAt: now,
      };
    }

    case 'veronica': {
      setRoomVeronicaMode(roomId, true);
      broadcastHudSound(roomId, 'protocol');
      return {
        success: true,
        protocol: 'Protocol Veronica',
        protocolKey: 'veronica',
        mode: 'CLOUD_DELEGATION_PRIORITY',
        speechResponse:
          'Protocol Veronica deployed, Ray. Deep reasoning and cloud delegation are now locked at maximum priority.',
        details: {
          mode: 'CLOUD_DELEGATION_PRIORITY',
          thinkingLevel: 'HIGH',
          searchGrounding: true,
        },
        executedAt: now,
      };
    }

    default:
      return {
        success: false,
        protocol: protocolName,
        protocolKey: 'house_party',
        speechResponse: `Unknown protocol "${protocolName}", Ray. Available protocols are clean_slate, house_party, sentry_mode, and veronica.`,
        details: {},
        executedAt: now,
      };
  }
}
