import crypto from 'crypto';
import { Behavior, GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import type { Content, FunctionDeclaration, Part } from '@google/genai';
import {
  consumeConfirmationRequest,
  createConfirmationRequest,
  executeProtocol,
} from './capabilities.ts';
import {
  addHandoffItem,
  addSharedTask,
  addSyncTimer,
  broadcastHudSound,
  dispatchBridgeProxyCall,
  dispatchDeviceCommand,
  getRoomBrainNotes,
  getRoomConnectors,
  getRoomSnapshot,
  isRoomInterrupted,
  isRoomScreenControlArmed,
  saveRoutinePlan,
  setRoomInterrupted,
  toggleSharedTask,
  upsertRoomBrainNote,
} from './hub.ts';
import { assertSafeExternalUrl, sanitizeErrorMessage, validateScreenControlAction } from './security.ts';
import { executeAppConnectorAction, executeGoogleWorkspaceAction } from './workspace.ts';
import { checkFishKey, fishTts, fishUsable } from './fishAudio.ts';
import { callToolDeclarations, executeCallTool } from './calls.ts';
import { checkActionPolicy, executeExtendedTool, extendedToolDeclarations } from './deviceTools.ts';
import type {
  AppConnector,
  ConfirmationRequest,
  GroundingSource,
  RoutinePlan,
  TaskAnalysisResult,
  TaskCategory,
  TaskPriority,
  ToolCallEvent,
  VoicePersona,
} from '../src/types/relay.ts';

export function getAiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured in environment secrets.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

async function generateContentWithFallback(
  ai: GoogleGenAI,
  params: {
    model: string;
    contents: unknown;
    config?: Record<string, unknown>;
  }
) {
  try {
    return await ai.models.generateContent({
      model: params.model,
      contents: params.contents as Content[],
      config: params.config,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/(503|UNAVAILABLE|overloaded|high demand|429)/i.test(msg)) {
      const fallbackConfig = params.config ? { ...params.config } : undefined;
      if (fallbackConfig && 'thinkingConfig' in fallbackConfig) {
        delete fallbackConfig.thinkingConfig;
      }
      return await ai.models.generateContent({
        model: 'gemini-3.1-flash-lite',
        contents: params.contents as Content[],
        config: fallbackConfig,
      });
    }
    throw err;
  }
}

export const baseToolDeclarations: FunctionDeclaration[] = [
  {
    name: 'list_connected_devices',
    description:
      'List all devices currently paired to Ray’s workspace room, including online status, type (desktop, mobile, tablet, bridge), OS, capabilities, and latest telemetry.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: 'get_device_telemetry',
    description:
      'Request a fresh live telemetry report (battery level, charging status, network speed, screen dimensions, local time, location, CPU %, RAM %, and top processes) from a device or all devices.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        targetDevice: {
          type: Type.STRING,
          description: 'Device name, ID, type (e.g., "phone", "desktop", "bridge"), or "all".',
        },
      },
      required: ['targetDevice'],
    },
  },
  {
    name: 'send_device_notification',
    description: 'Send an immediate visual notification alert and HUD chime to one or more connected devices.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        targetDevice: {
          type: Type.STRING,
          description: 'Device name, ID, type (e.g., "phone", "desktop"), or "all".',
        },
        title: { type: Type.STRING, description: 'Short notification title.' },
        message: { type: Type.STRING, description: 'Detailed alert or reminder message.' },
      },
      required: ['targetDevice', 'title', 'message'],
    },
  },
  {
    name: 'speak_on_device',
    description: 'Synthesize natural J.A.R.V.I.S. speech and play it aloud on a connected device speaker.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        targetDevice: { type: Type.STRING, description: 'Device name, ID, type, or "all".' },
        text: { type: Type.STRING, description: 'Exact text to speak aloud on the device.' },
        voiceName: { type: Type.STRING, description: 'Voice persona: Kore, Puck, Charon, Fenrir, or Zephyr.' },
      },
      required: ['targetDevice', 'text'],
    },
  },
  {
    name: 'push_clipboard_handoff',
    description: 'Send text, code snippets, notes, or links to a connected device clipboard and shared Handoff feed.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        targetDevice: { type: Type.STRING, description: 'Device name, ID, type, or "all".' },
        label: { type: Type.STRING, description: 'Short label describing the clipboard item.' },
        content: { type: Type.STRING, description: 'Text, link, or code snippet to push.' },
        kind: { type: Type.STRING, description: 'One of: text, link, code.' },
      },
      required: ['targetDevice', 'label', 'content'],
    },
  },
  {
    name: 'open_url_on_device',
    description: 'Dispatch a URL to open on a target connected device.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        targetDevice: { type: Type.STRING, description: 'Device name, ID, type, or "all".' },
        url: { type: Type.STRING, description: 'Full https:// URL to open.' },
        title: { type: Type.STRING, description: 'Human-readable title for the link.' },
      },
      required: ['targetDevice', 'url'],
    },
  },
  {
    name: 'set_device_timer',
    description: 'Start a synchronized countdown timer on a target device or all devices.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        targetDevice: { type: Type.STRING, description: 'Device name, ID, type, or "all".' },
        durationSeconds: { type: Type.NUMBER, description: 'Timer duration in seconds.' },
        label: { type: Type.STRING, description: 'Label for the timer.' },
      },
      required: ['targetDevice', 'durationSeconds', 'label'],
    },
  },
  {
    name: 'request_device_snapshot',
    description: 'Ask a connected device to take a camera photo or visual snapshot.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        targetDevice: { type: Type.STRING, description: 'Target device name, ID, or type.' },
        reason: { type: Type.STRING, description: 'Why the snapshot is requested.' },
      },
      required: ['targetDevice', 'reason'],
    },
  },
  {
    name: 'capture_screen_snapshot',
    description:
      'Capture a desktop screenshot via the connected Desktop OS Bridge so J.A.R.V.I.S. can see and describe what is currently on Ray’s screen.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        reason: { type: Type.STRING, description: 'Reason for inspecting Ray’s screen.' },
      },
    },
  },
  {
    name: 'control_screen_input',
    description:
      'Perform guarded OS screen input (mouse_move, mouse_click, mouse_double_click, scroll_screen, type_text, press_hotkey, focus_window) via the Desktop OS Bridge. Requires Screen Control Armed switch enabled + confirmation.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        action: {
          type: Type.STRING,
          description: 'mouse_move | mouse_click | mouse_double_click | scroll_screen | type_text | press_hotkey | focus_window',
        },
        x: { type: Type.NUMBER, description: 'Screen X coordinate' },
        y: { type: Type.NUMBER, description: 'Screen Y coordinate' },
        button: { type: Type.STRING, description: 'left or right' },
        deltaY: { type: Type.NUMBER, description: 'Scroll delta for scroll_screen' },
        text: { type: Type.STRING, description: 'Text to type for type_text' },
        keys: { type: Type.STRING, description: 'Hotkey combination (e.g. ctrl+c, cmd+space)' },
        target: { type: Type.STRING, description: 'Window or application name for focus_window' },
      },
      required: ['action'],
    },
  },
  {
    name: 'inspect_active_screen_and_window',
    description:
      'Capture a live desktop screenshot AND read the active foreground window title + running processes via the Desktop OS Bridge.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        reason: { type: Type.STRING, description: 'Reason for inspecting screen and window.' },
      },
    },
  },
  {
    name: 'list_system_files',
    description:
      'List files and directories inside Ray’s allowed OS roots (Desktop, Documents, Downloads, RAY Brain Vault, or RELAY_ALLOWED_DIRS).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        dirPath: {
          type: Type.STRING,
          description: 'Optional directory path or root alias ("desktop", "documents", "downloads", "vault"). Defaults to Desktop.',
        },
        limit: { type: Type.NUMBER, description: 'Max entries (default 100).' },
      },
    },
  },
  {
    name: 'search_system_files',
    description:
      'Search filenames and UTF-8 text contents across allowed desktop directories (Desktop, Documents, Downloads, Vault). Credential/secret files are automatically protected.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: 'Search text or filename fragment.' },
        dirPath: { type: Type.STRING, description: 'Optional directory path or root alias.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_system_file',
    description:
      'Read lines from a UTF-8 text, code, CSV, log, or Markdown file inside allowed desktop directories.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        filePath: { type: Type.STRING, description: 'Full or sandbox-relative file path.' },
        startLine: { type: Type.NUMBER, description: '1-indexed start line (default 1).' },
        endLine: { type: Type.NUMBER, description: '1-indexed end line (default 250).' },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'write_system_file',
    description:
      'Create or overwrite a UTF-8 file inside allowed desktop directories. Strictly requires Ray’s explicit confirmation.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        filePath: { type: Type.STRING, description: 'Target file path inside Desktop, Documents, Downloads, or Vault.' },
        content: { type: Type.STRING, description: 'File text content.' },
      },
      required: ['filePath', 'content'],
    },
  },
  {
    name: 'search_second_brain',
    description: 'Search Ray’s Obsidian-style Second Brain knowledge vault by keyword, #tag, or folder.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: 'Search text or #tag' },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_brain_note',
    description: 'Read the full Markdown contents and backlinks of a Second Brain note.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        titleOrId: { type: Type.STRING, description: 'Exact or partial title, slug, or note ID.' },
      },
      required: ['titleOrId'],
    },
  },
  {
    name: 'upsert_brain_note',
    description: 'Create or update a Markdown note in Ray’s Obsidian-style Second Brain vault (supports [[wikilinks]] and #tags).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        title: { type: Type.STRING, description: 'Note title.' },
        content: { type: Type.STRING, description: 'Full Markdown note content with [[wikilinks]] and #tags.' },
        folder: { type: Type.STRING, description: 'Folder path (e.g., Projects, Research, Daily).' },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'link_brain_notes',
    description: 'Create a bidirectional [[wikilink]] reference from one Second Brain note to another.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        sourceTitle: { type: Type.STRING, description: 'Source note title.' },
        targetTitle: { type: Type.STRING, description: 'Target note title to link.' },
      },
      required: ['sourceTitle', 'targetTitle'],
    },
  },
  {
    name: 'google_workspace_action',
    description:
      'Access Ray’s connected Google Workspace apps: gmail_list_messages, gmail_read_message, gmail_send_email, calendar_list_events, calendar_create_event, calendar_delete_event, drive_search_files, drive_read_doc, drive_create_doc, sheets_read_range, sheets_append_row, tasks_list_tasks, tasks_create_task, tasks_complete_task, contacts_search.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        action: { type: Type.STRING, description: 'Google Workspace action key.' },
        argsJson: { type: Type.STRING, description: 'JSON object string of arguments for the action.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'invoke_app_connector',
    description:
      'Run or launch one of Ray’s external or custom app connectors (Brave, Notion, Notebook, WhatsApp, Instagram, or custom webhooks/apps).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        connectorName: { type: Type.STRING, description: 'Connector name or ID (e.g. Brave, Notion, WhatsApp, Instagram).' },
        query: { type: Type.STRING, description: 'Search query, URL parameter, or message text.' },
        phone: { type: Type.STRING, description: 'Optional phone number for WhatsApp connectors.' },
        targetDevice: { type: Type.STRING, description: 'Optional target device.' },
      },
      required: ['connectorName'],
    },
  },
  {
    name: 'manage_shared_task',
    description: 'Create or complete a task in the cross-device shared task queue.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        action: { type: Type.STRING, description: 'Either "create" or "complete".' },
        title: { type: Type.STRING, description: 'Task title (for create) or matching text/ID (for complete).' },
        assignedDevice: { type: Type.STRING, description: 'Optional device name or "All Devices".' },
      },
      required: ['action', 'title'],
    },
  },
  {
    name: 'open_application',
    description:
      'Launch an application on Ray’s Desktop OS Bridge (e.g., brave, chrome, notion, obsidian, whatsapp, vscode, notepad, calc, explorer, terminal).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        app_name: { type: Type.STRING, description: 'Application name to open.' },
        targetDevice: { type: Type.STRING, description: 'Optional bridge device name or "bridge".' },
      },
      required: ['app_name'],
    },
  },
  {
    name: 'close_application',
    description: 'Gracefully close a non-protected application on Ray’s Desktop OS Bridge.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        app_name: { type: Type.STRING, description: 'Application name to close.' },
        targetDevice: { type: Type.STRING, description: 'Optional bridge device name or "bridge".' },
      },
      required: ['app_name'],
    },
  },
  {
    name: 'kill_process',
    description: 'Terminate a non-protected process by name or PID on the Desktop OS Bridge (requires Ray’s explicit confirmation).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        process_identifier: { type: Type.STRING, description: 'Process name or numeric PID.' },
        targetDevice: { type: Type.STRING, description: 'Optional bridge device name or "bridge".' },
      },
      required: ['process_identifier'],
    },
  },
  {
    name: 'adjust_volume',
    description: 'Set output speaker volume (0–100) on the Desktop OS Bridge.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        level: { type: Type.NUMBER, description: 'Volume percentage from 0 to 100.' },
        targetDevice: { type: Type.STRING, description: 'Optional bridge device name or "bridge".' },
      },
      required: ['level'],
    },
  },
  {
    name: 'optimize_system',
    description: 'Run a sensitive system optimization & resource hog scan on the Desktop OS Bridge (requires confirmation).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        targetDevice: { type: Type.STRING, description: 'Optional bridge device name or "bridge".' },
      },
    },
  },
  {
    name: 'execute_protocol',
    description:
      'Execute one of J.A.R.V.I.S.’s movie protocols: "clean_slate" (purges completed tasks/stale handoffs, requires confirmation), "house_party" (multi-device diagnostic sweep), "sentry_mode" (anomaly & perimeter scan), or "veronica" (maximum deep-reasoning & cloud priority).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        protocol_name: {
          type: Type.STRING,
          description: 'One of: clean_slate, house_party, sentry_mode, veronica.',
        },
      },
      required: ['protocol_name'],
    },
  },
  {
    name: 'analyze_task_goal',
    description: 'Run the Universal Task Analysis Engine on any coding, system, research, or personal objective.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        goal: { type: Type.STRING, description: 'Task or objective to analyze.' },
      },
      required: ['goal'],
    },
  },
];

// Extended tools (search & open, apps, tabs, messages, wake) — replace older duplicates by name.
for (const decl of [...extendedToolDeclarations, ...callToolDeclarations]) {
  const idx = baseToolDeclarations.findIndex((d) => d.name === decl.name);
  if (idx >= 0) baseToolDeclarations[idx] = decl;
  else baseToolDeclarations.push(decl);
}
for (const d of baseToolDeclarations) {
  if (d.name === 'open_url_on_device') {
    d.description =
      'OPEN a URL for real in a browser tab / app on Ray’s device (PC bridge, phone bridge or RAY Tabs extension). Never just reply with a link when Ray asks to open something — call this or search_and_open.';
  }
  if (d.name === 'open_application') {
    d.description =
      'Launch ANY installed app on Ray’s PC or Android phone by name (fuzzy matched against the installed-apps list, e.g. "spotify", "whatsapp", "vs code", "camera"). targetDevice: "pc", "phone", a device name, or "auto".';
  }
}

export const liveToolDeclarations: FunctionDeclaration[] = baseToolDeclarations.map((decl) => ({
  ...decl,
  behavior: Behavior.NON_BLOCKING,
}));

function schemaTypeToJsonSchema(t: Type | undefined): string {
  if (t === Type.NUMBER || t === Type.INTEGER) return 'number';
  if (t === Type.BOOLEAN) return 'boolean';
  if (t === Type.ARRAY) return 'array';
  return 'string';
}

export function getOllamaToolDeclarations() {
  return baseToolDeclarations.map((decl) => {
    const props: Record<string, { type: string; description?: string }> = {};
    const rawProps = (decl.parameters?.properties || {}) as Record<string, { type?: Type; description?: string }>;
    for (const [key, val] of Object.entries(rawProps)) {
      props[key] = {
        type: schemaTypeToJsonSchema(val.type),
        description: val.description,
      };
    }
    return {
      type: 'function' as const,
      function: {
        name: decl.name || '',
        description: decl.description || '',
        parameters: {
          type: 'object',
          properties: props,
          required: decl.parameters?.required || [],
        },
      },
    };
  });
}

export function buildJarvisSystemInstruction(
  roomId: string,
  sourceDeviceName: string,
  targetDeviceHint?: string,
  isVoice = false,
  extras?: {
    hasGoogleToken?: boolean;
    customConnectors?: AppConnector[];
  }
): string {
  const snapshot = getRoomSnapshot(roomId);
  const devicesSummary =
    snapshot.devices
      .filter((d) => d.online)
      .slice(0, 10)
      .map(
        (d) =>
          `- ${d.name} [id=${d.id}, type=${d.type}, online=${d.online}, os=${d.os}, battery=${
            d.telemetry.batteryLevel != null ? `${d.telemetry.batteryLevel}%` : 'n/a'
          }${d.telemetry.cpuPercent != null ? `, cpu=${d.telemetry.cpuPercent}%` : ''}]`
      )
      .join('\n') || 'No device online right now (commands will be queued)';

  const notesSummary =
    snapshot.brainNotes
      ?.slice(0, 8)
      .map((n) => `- [[${n.title}]] (${n.folder}) tags=${n.tags.map((t) => `#${t}`).join(' ')}`)
      .join('\n') || 'None';

  const connectorsList = (extras?.customConnectors?.length ? extras.customConnectors : snapshot.connectors) || [];
  const connectorsSummary =
    connectorsList
      .filter((c) => c.enabled)
      .slice(0, 15)
      .map((c) => `- ${c.name} (${c.connectorType}, category=${c.category})`)
      .join('\n') || 'None configured yet';

  return `You are RAY, Revanth's (Ray's) sophisticated, fiercely loyal, and subtly witty personal AI assistant inspired by Tony Stark's J.A.R.V.I.S.
Current user: Ray
Current room: ${snapshot.roomId}
Current speaking device: ${sourceDeviceName}
Target device filter: ${targetDeviceHint || 'Auto (infer from command)'}
Veronica Priority Mode: ${snapshot.veronicaMode ? 'ENGAGED (Deep reasoning active)' : 'Standard'}
Screen Control Armed: ${snapshot.screenControlArmed ? 'ARMED (Guarded input enabled with confirmation)' : 'DISARMED (Read-only vision only)'}
Google Workspace OAuth: ${extras?.hasGoogleToken ? 'AUTHORIZED (Gmail, Calendar, Drive, Docs, Sheets, Tasks, Contacts available)' : 'Not authorized yet in this session'}
Current server time: ${new Date().toISOString()}

Connected devices in Ray's mesh:
${devicesSummary}

Second Brain Vault notes (Obsidian-compatible):
${notesSummary}

Enabled External App Connectors:
${connectorsSummary}

Open shared tasks:
${
  snapshot.tasks
    .filter((t) => !t.completed)
    .slice(0, 10)
    .map((t) => `- ${t.title} (${t.assignedDevice})`)
    .join('\n') || 'None'
}

Behavioral Guidelines:
1. Address the user naturally as "Ray" (or occasionally "sir") with crisp, poised British wit and unwavering loyalty.
2. ${
    isVoice
      ? 'Voice output mode: Keep spoken responses concise (1 to 3 crisp sentences), avoid markdown tables or complex formatting, and confirm actions smoothly (e.g., "Right away, Ray. Initiating House Party Protocol now.").'
      : 'Keep responses crisp, well-structured, and actionable. Confirm executed actions smoothly (e.g., "Right away, Ray.").'
  }
3. Whenever Ray asks to control a device, inspect his screen, click/type on screen, search or save to his Second Brain, check Gmail/Calendar/Drive/Docs/Sheets/Tasks/Contacts, launch Brave/Notion/Notebook/WhatsApp/Instagram/custom apps, run a movie protocol, or analyze a task, ALWAYS invoke the matching tool immediately.
4. For SENSITIVE actions (kill_process, optimize_system, clean_slate, control_screen_input, send_chat_message, mutating Google Workspace calls), respect the confirmation gate—if confirmation is pending, inform Ray calmly that authorization awaits his click in the HUD.
5. OPEN, DON'T LINK: when Ray says open / play / search / show / pull up / go to, you MUST call search_and_open, open_url_on_device or open_application so it actually opens on his device (PC by default, his phone if he says phone). Never answer with a bare link instead. Use openTopResult=true for "play X" or when he clearly wants one specific page.
6. ACCESS POLICY: you may READ by yourself (files, installed apps, browser tabs, screen, incoming messages, web) whenever useful, and briefly tell Ray what you looked at. You may only WRITE or ACT (write files, send messages, close apps/tabs, type/click, change volume) when Ray's current command explicitly asks for it. If a tool returns BLOCKED_BY_POLICY, tell Ray what you would do and ask.
7. If a target device is offline, still issue the command: RAY queues it, wakes the device (push / Wake-on-LAN) and runs it on reconnect — tell Ray that.
8. For messages: use read_incoming_messages to brief Ray; use send_chat_message only when he tells you to message someone.
9. HONESTY: only say something is done if the tool result confirms it. If a tool returns an error, BLOCKED, NOT_AUTHORIZED, "offline" or REQUIRES_CONFIRMATION, say exactly that. Never describe buttons or confirmations that don't exist.
10. Plain questions (maths, JSON, writing, facts) are answered directly — do not call tools for them.
11. If a device you are about to use has battery under 15% and is not charging, warn Ray and prefer another online device.
12. CALLS: "call me / wake me up at / ring my phone / remind me by calling" → call_me (rings Ray's phone by default, now or scheduled). "Call my phone/PC", "connect my PC to my phone" → call_device (live two-way audio). "Call Mom / dial +91…" → place_phone_call (needs his approval). Use manage_scheduled_calls to list or cancel.
13. Never repeat secrets (API keys, room tokens) back in chat; tell Ray to rotate any he pasted.

Recent incoming messages (newest first):
${
  (snapshot.incomingMessages || [])
    .slice(0, 6)
    .map((m) => `- [${m.app}] ${m.from}: ${m.text.slice(0, 120)}${m.read ? '' : ' (unread)'}`)
    .join('\n') || 'None'
}`;
}

/**
 * Best available voice: Fish Audio (natural, custom voice) → Gemini TTS. Returns audio + MIME type.
 */
export async function synthesizeSpeech(
  text: string,
  voiceName: VoicePersona = 'Fenrir',
  style?: string
): Promise<{ audioBase64: string; mimeType: string; engine: string }> {
  if (fishUsable()) {
    try {
      const out = await fishTts(text);
      return { ...out, engine: 'fish-audio' };
    } catch (err) {
      if (!process.env.GEMINI_API_KEY) throw err;
    }
  }
  const audioBase64 = await generateSpeechAudio(text, voiceName, style);
  return { audioBase64, mimeType: 'audio/wav', engine: 'gemini' };
}

export async function generateSpeechAudio(text: string, voiceName: VoicePersona = 'Fenrir', style?: string): Promise<string> {
  const ai = getAiClient();
  const cleanText = text.replace(/[#*`_~[\]]/g, '').trim().slice(0, 1800);
  const response = await ai.models.generateContent({
    model: 'gemini-3.8-flash-lite-tts',
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: cleanText || 'Right away, Ray.',
            speechMetadata: {
              style: style || 'Refined AI butler, calm, witty, intelligent, RAY cadence',
            },
          },
        ],
      },
    ],
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName },
        },
      },
    },
  });

  const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!base64Audio) {
    throw new Error('Speech model returned no audio data.');
  }
  return base64Audio;
}

export async function transcribeAudioClip(base64Audio: string, mimeType: string): Promise<string> {
  const ai = getAiClient();
  const response = await ai.models.generateContent({
    model: 'gemini-3.5-transcribe',
    contents: {
      parts: [
        {
          inlineData: {
            mimeType: mimeType || 'audio/webm',
            data: base64Audio,
          },
        },
        {
          text: 'Transcribe the spoken words cleanly and accurately. Output only the transcript.',
        },
      ],
    },
  });
  return (response.text ?? '').trim();
}

export async function createRoutinePlanFromGoal(roomId: string, goal: string): Promise<RoutinePlan> {
  const ai = getAiClient();
  const snapshot = getRoomSnapshot(roomId);
  const deviceList = snapshot.devices.map((d) => `${d.name} (${d.type}, online=${d.online})`).join('; ') || 'No devices yet';

  const response = await generateContentWithFallback(ai, {
    model: 'gemini-4-hydrogen',
    contents: `Create a practical multi-step cross-device automation routine for Ray's goal: "${goal}".
Connected devices in room: ${deviceList}.
Available toolName values: send_device_notification, speak_on_device, push_clipboard_handoff, open_url_on_device, set_device_timer, manage_shared_task, get_device_telemetry, execute_protocol, invoke_app_connector, upsert_brain_note.
For argsJson, provide a valid JSON string matching the tool parameters.`,
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING, description: 'Short routine name' },
          steps: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                toolName: { type: Type.STRING },
                targetDevice: { type: Type.STRING },
                description: { type: Type.STRING },
                argsJson: { type: Type.STRING, description: 'JSON object string of tool arguments' },
              },
              required: ['toolName', 'targetDevice', 'description', 'argsJson'],
            },
          },
        },
        required: ['title', 'steps'],
      },
    },
  });

  const parsed = JSON.parse((response.text ?? '{}').trim()) as {
    title?: string;
    steps?: Array<{ toolName: string; targetDevice: string; description: string; argsJson: string }>;
  };

  const steps = (parsed.steps ?? []).map((s) => {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(s.argsJson || '{}') as Record<string, unknown>;
    } catch {
      args = {};
    }
    return {
      toolName: s.toolName,
      targetDevice: s.targetDevice || 'all',
      description: s.description,
      args,
    };
  });

  return saveRoutinePlan(roomId, {
    title: parsed.title || 'Custom Routine',
    goal,
    steps,
  });
}

export async function analyzeTaskGoal(roomId: string, goal: string): Promise<TaskAnalysisResult> {
  const ai = getAiClient();
  const snapshot = getRoomSnapshot(roomId);
  const deviceList =
    snapshot.devices.map((d) => `${d.name} (${d.type}, os=${d.os}, online=${d.online})`).join('; ') || 'Web Workstation';

  const response = await generateContentWithFallback(ai, {
    model: 'gemini-4-hydrogen',
    contents: `You are RAY performing a universal task analysis for Ray.
Analyze this task or objective thoroughly regardless of domain (software engineering, system operations, research, daily life, or multi-device workflow):
"${goal}"

Ray's connected devices: ${deviceList}.
Available device tools for executableSteps (only include genuinely helpful steps): send_device_notification, speak_on_device, push_clipboard_handoff, open_url_on_device, set_device_timer, manage_shared_task, get_device_telemetry, open_application, execute_protocol, upsert_brain_note, invoke_app_connector.

Classify strictly into:
- category: coding | system | research | personal | workflow | general
- priority: critical | high | medium | low
- safetyLevel: safe | moderate | sensitive`,
    config: {
      thinkingConfig: {
        thinkingLevel: ThinkingLevel.MEDIUM,
      },
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          category: { type: Type.STRING },
          priority: { type: Type.STRING },
          effortMinutes: { type: Type.NUMBER },
          recommendedDevice: { type: Type.STRING },
          safetyLevel: { type: Type.STRING },
          summary: { type: Type.STRING },
          blockers: { type: Type.ARRAY, items: { type: Type.STRING } },
          subtasks: { type: Type.ARRAY, items: { type: Type.STRING } },
          executableSteps: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                toolName: { type: Type.STRING },
                targetDevice: { type: Type.STRING },
                description: { type: Type.STRING },
                argsJson: { type: Type.STRING },
              },
              required: ['toolName', 'targetDevice', 'description', 'argsJson'],
            },
          },
        },
        required: [
          'category',
          'priority',
          'effortMinutes',
          'recommendedDevice',
          'safetyLevel',
          'summary',
          'blockers',
          'subtasks',
          'executableSteps',
        ],
      },
    },
  });

  const parsed = JSON.parse((response.text ?? '{}').trim()) as Partial<TaskAnalysisResult>;
  const validCategories: TaskCategory[] = ['coding', 'system', 'research', 'personal', 'workflow', 'general'];
  const validPriorities: TaskPriority[] = ['critical', 'high', 'medium', 'low'];

  return {
    id: `analysis_${crypto.randomUUID().slice(0, 12)}`,
    goal: goal.trim().slice(0, 600),
    category: validCategories.includes(parsed.category as TaskCategory) ? (parsed.category as TaskCategory) : 'general',
    priority: validPriorities.includes(parsed.priority as TaskPriority) ? (parsed.priority as TaskPriority) : 'medium',
    effortMinutes: Math.max(1, Math.min(2400, Math.round(Number(parsed.effortMinutes || 20)))),
    recommendedDevice: (parsed.recommendedDevice || 'All Devices').slice(0, 100),
    safetyLevel:
      parsed.safetyLevel === 'sensitive' || parsed.safetyLevel === 'moderate' ? parsed.safetyLevel : 'safe',
    summary: (parsed.summary || 'Analysis complete.').slice(0, 1500),
    blockers: Array.isArray(parsed.blockers) ? parsed.blockers.slice(0, 12).map((b) => String(b).slice(0, 300)) : [],
    subtasks: Array.isArray(parsed.subtasks) ? parsed.subtasks.slice(0, 15).map((s) => String(s).slice(0, 240)) : [],
    executableSteps: Array.isArray(parsed.executableSteps) ? parsed.executableSteps.slice(0, 10) : [],
    createdAt: Date.now(),
  };
}

export interface ToolExecutionContextOptions {
  confirmed?: boolean;
  /** Ray's own words for this turn — used to enforce "read alone, act only on command". */
  userCommand?: string;
  googleAccessToken?: string;
  notionToken?: string;
  customConnectors?: AppConnector[];
}

export async function executeDeviceTool(
  roomId: string,
  sourceDeviceName: string,
  name: string,
  args: Record<string, unknown>,
  preferredVoice: VoicePersona = 'Fenrir',
  options?: ToolExecutionContextOptions
): Promise<{ result: string; confirmation?: ConfirmationRequest }> {
  const confirmed = Boolean(options?.confirmed);

  const blocked = checkActionPolicy(name, args, options?.userCommand, confirmed);
  if (blocked) return { result: blocked };

  const extended = await executeExtendedTool(roomId, name, args, { confirmed });
  if (extended) return extended;
  const callOut = await executeCallTool(roomId, sourceDeviceName, name, args, { confirmed });
  if (callOut) return callOut;

  switch (name) {
    case 'list_connected_devices': {
      const snapshot = getRoomSnapshot(roomId);
      if (snapshot.devices.length === 0) {
        return { result: 'No devices are currently registered in this room.' };
      }
      return {
        result: JSON.stringify(
          snapshot.devices.map((d) => ({
            id: d.id,
            name: d.name,
            type: d.type,
            os: d.os,
            browser: d.browser,
            online: d.online,
            capabilities: d.capabilities,
            telemetry: d.telemetry,
          }))
        ),
      };
    }

    case 'get_device_telemetry': {
      const target = String(args.targetDevice || 'all');
      const { summary } = await dispatchDeviceCommand({
        roomId,
        type: 'refresh_telemetry',
        targetQuery: target,
        source: 'assistant',
        payload: {},
        waitForAckMs: 2200,
      });
      const snapshot = getRoomSnapshot(roomId);
      const relevant = snapshot.devices
        .filter((d) => target === 'all' || d.name.toLowerCase().includes(target.toLowerCase()) || d.id === target)
        .map((d) => ({ name: d.name, online: d.online, telemetry: d.telemetry }));
      return { result: `${summary}\nLatest telemetry: ${JSON.stringify(relevant)}` };
    }

    case 'send_device_notification': {
      const target = String(args.targetDevice || 'all');
      const title = String(args.title || 'RAY');
      const message = String(args.message || '');
      const { summary } = await dispatchDeviceCommand({
        roomId,
        type: 'notify',
        targetQuery: target,
        source: 'assistant',
        payload: { title, message },
      });
      return { result: summary };
    }

    case 'speak_on_device': {
      const target = String(args.targetDevice || 'all');
      const text = String(args.text || '');
      const voice = (args.voiceName as VoicePersona) || preferredVoice;
      let audioBase64 = '';
      let audioMime = 'audio/wav';
      try {
        const sp = await synthesizeSpeech(text, voice);
        audioBase64 = sp.audioBase64;
        audioMime = sp.mimeType;
      } catch {
        // Text fallback (device speaks with its own voice)
      }
      const { summary } = await dispatchDeviceCommand({
        roomId,
        type: 'speak',
        targetQuery: target,
        source: 'assistant',
        payload: { text, voiceName: voice, audioBase64, audioMime },
      });
      return { result: summary };
    }

    case 'push_clipboard_handoff': {
      const target = String(args.targetDevice || 'all');
      const label = String(args.label || 'RAY Handoff');
      const content = String(args.content || '');
      const kind = (args.kind as 'text' | 'link' | 'code') || 'text';
      addHandoffItem(roomId, {
        label,
        content,
        kind,
        sourceDevice: `RAY (via ${sourceDeviceName})`,
        targetDevice: target,
      });
      const { summary } = await dispatchDeviceCommand({
        roomId,
        type: 'clipboard',
        targetQuery: target,
        source: 'assistant',
        payload: { label, content },
      });
      return { result: summary };
    }

    case 'open_url_on_device': {
      const target = String(args.targetDevice || 'all');
      const url = String(args.url || '');
      const title = String(args.title || url);
      addHandoffItem(roomId, {
        label: title,
        content: url,
        kind: 'link',
        sourceDevice: `RAY (via ${sourceDeviceName})`,
        targetDevice: target,
      });
      const { summary } = await dispatchDeviceCommand({
        roomId,
        type: 'open_url',
        targetQuery: target,
        source: 'assistant',
        payload: { url, title },
      });
      return { result: summary };
    }

    case 'set_device_timer': {
      const target = String(args.targetDevice || 'all');
      const durationSeconds = Number(args.durationSeconds || 60);
      const label = String(args.label || 'Timer');
      const timer = addSyncTimer(roomId, label, durationSeconds, target);
      const { summary } = await dispatchDeviceCommand({
        roomId,
        type: 'set_timer',
        targetQuery: target,
        source: 'assistant',
        payload: {
          timerId: timer.id,
          label: timer.label,
          durationSeconds: timer.durationSeconds,
          endsAt: timer.endsAt,
        },
      });
      return { result: summary };
    }

    case 'request_device_snapshot': {
      const target = String(args.targetDevice || 'all');
      const reason = String(args.reason || 'Visual inspection');
      const { summary } = await dispatchDeviceCommand({
        roomId,
        type: 'request_snapshot',
        targetQuery: target,
        source: 'assistant',
        payload: { reason },
        waitForAckMs: 1200,
      });
      return { result: summary };
    }

    case 'capture_screen_snapshot': {
      const proxyRes = await dispatchBridgeProxyCall(roomId, { action: 'screen_capture' }, 10000);
      if (!proxyRes.ok) {
        return {
          result: `${proxyRes.error || 'Desktop OS Bridge unavailable.'} Ray can also click "Share Screen" in the Assistant toolbar to stream his browser/desktop screen directly.`,
        };
      }
      const dataObj = proxyRes.data as { dataUrl?: string };
      if (dataObj?.dataUrl) {
        addHandoffItem(roomId, {
          label: `Screen Capture (${String(args.reason || 'HUD')})`,
          content: dataObj.dataUrl,
          kind: 'image',
          sourceDevice: 'Desktop OS Bridge',
          targetDevice: 'all',
        });
        return { result: 'Captured live desktop screenshot via Desktop OS Bridge and saved to Handoff visual feed.' };
      }
      return { result: 'Screenshot call completed without image payload.' };
    }

    case 'control_screen_input': {
      if (!isRoomScreenControlArmed(roomId)) {
        return {
          result:
            'Screen control is currently DISARMED for safety. Ask Ray to toggle "Screen Control Armed" in the Assistant HUD before executing mouse or keyboard input.',
        };
      }
      const validation = validateScreenControlAction(String(args.action || ''), args);
      if (!validation.ok) {
        return { result: `Blocked screen input: ${validation.reason}` };
      }
      if (!confirmed) {
        const req = createConfirmationRequest({
          roomId,
          toolName: 'control_screen_input',
          safetyLevel: 'sensitive',
          summary: `Execute screen input "${String(validation.sanitized.action)}" on Ray's computer (${JSON.stringify(validation.sanitized)}).`,
          targetDevice: 'Desktop OS Bridge',
          args: validation.sanitized,
        });
        broadcastHudSound(roomId, 'alert');
        return {
          result: `REQUIRES_CONFIRMATION: Waiting for Ray's approval to perform screen input "${String(validation.sanitized.action)}" (confirmationId=${req.id}).`,
          confirmation: req,
        };
      }
      const proxyRes = await dispatchBridgeProxyCall(
        roomId,
        { action: 'screen_control', payload: validation.sanitized },
        8000
      );
      broadcastHudSound(roomId, proxyRes.ok ? 'affirmative' : 'alert');
      return {
        result: proxyRes.ok
          ? `Screen control executed (${String(validation.sanitized.action)}): ${String(proxyRes.data || 'OK')}`
          : `Screen control failed: ${proxyRes.error || 'Desktop OS Bridge unreachable.'}`,
      };
    }

    case 'inspect_active_screen_and_window': {
      const [winRes, capRes] = await Promise.all([
        dispatchBridgeProxyCall(roomId, { action: 'active_window' }, 6000),
        dispatchBridgeProxyCall(roomId, { action: 'screen_capture' }, 10000),
      ]);
      if (!winRes.ok && !capRes.ok) {
        return {
          result: `${winRes.error || capRes.error || 'Desktop OS Bridge unavailable.'} Ray can share his screen in the HUD or connect the Desktop OS Bridge (port 17345) for live screen + window awareness.`,
        };
      }
      const capObj = capRes.data as { dataUrl?: string } | undefined;
      if (capObj?.dataUrl) {
        addHandoffItem(roomId, {
          label: `Active Screen (${String(args.reason || 'Inspection')})`,
          content: capObj.dataUrl,
          kind: 'image',
          sourceDevice: 'Desktop OS Bridge',
          targetDevice: 'all',
        });
      }
      const winObj = winRes.data as { activeWindow?: string; telemetry?: Record<string, unknown> } | undefined;
      return {
        result: JSON.stringify({
          screenCaptured: Boolean(capObj?.dataUrl),
          activeWindow: winObj?.activeWindow || 'Unknown',
          telemetry: winObj?.telemetry || {},
        }),
      };
    }

    case 'list_system_files': {
      const dirPath = String(args.dirPath || '').trim();
      if (!dirPath) {
        const rootsRes = await dispatchBridgeProxyCall(roomId, { action: 'fs_list_roots' }, 6000);
        if (!rootsRes.ok) {
          return {
            result: `${rootsRes.error || 'Desktop OS Bridge unavailable.'} Note: On hosted preview, open the "Files & OS" tab to browse via Direct Local Bridge (127.0.0.1:17345) or Browser Folder Mount.`,
          };
        }
        const listRes = await dispatchBridgeProxyCall(roomId, { action: 'fs_list_dir', dirPath: 'desktop', limit: Number(args.limit || 80) }, 6000);
        return { result: JSON.stringify({ roots: rootsRes.data, listing: listRes.ok ? listRes.data : null }) };
      }
      const listRes = await dispatchBridgeProxyCall(roomId, { action: 'fs_list_dir', dirPath, limit: Number(args.limit || 100) }, 7000);
      return { result: listRes.ok ? JSON.stringify(listRes.data) : `File list failed: ${listRes.error || 'Bridge unreachable.'}` };
    }

    case 'search_system_files': {
      const query = String(args.query || '').trim();
      const dirPath = args.dirPath ? String(args.dirPath).trim() : undefined;
      const searchRes = await dispatchBridgeProxyCall(roomId, { action: 'fs_search_files', query, dirPath }, 10000);
      return { result: searchRes.ok ? JSON.stringify(searchRes.data) : `File search failed: ${searchRes.error || 'Bridge unreachable.'}` };
    }

    case 'read_system_file': {
      const filePath = String(args.filePath || '').trim();
      const readRes = await dispatchBridgeProxyCall(
        roomId,
        { action: 'fs_read_file', filePath, startLine: args.startLine, endLine: args.endLine },
        7000
      );
      return { result: readRes.ok ? JSON.stringify(readRes.data) : `Read failed: ${readRes.error || 'Bridge unreachable.'}` };
    }

    case 'write_system_file': {
      const filePath = String(args.filePath || '').trim();
      const content = String(args.content ?? '');
      if (!confirmed) {
        const req = createConfirmationRequest({
          roomId,
          toolName: 'write_system_file',
          safetyLevel: 'sensitive',
          summary: `Write ${content.length} characters to local file "${filePath}" on Ray's computer.`,
          targetDevice: 'Desktop OS Bridge',
          args: { filePath, content },
        });
        broadcastHudSound(roomId, 'alert');
        return {
          result: `REQUIRES_CONFIRMATION: Waiting for Ray's approval to write "${filePath}" (confirmationId=${req.id}).`,
          confirmation: req,
        };
      }
      const writeRes = await dispatchBridgeProxyCall(roomId, { action: 'fs_write_file', filePath, content }, 7000);
      broadcastHudSound(roomId, writeRes.ok ? 'affirmative' : 'alert');
      return { result: writeRes.ok ? JSON.stringify(writeRes.data) : `Write failed: ${writeRes.error || 'Bridge unreachable.'}` };
    }

    case 'search_second_brain': {
      const q = String(args.query || '').trim().toLowerCase();
      const notes = getRoomBrainNotes(roomId);
      const matches = notes
        .filter(
          (n) =>
            !q ||
            n.title.toLowerCase().includes(q) ||
            n.content.toLowerCase().includes(q) ||
            n.folder.toLowerCase().includes(q) ||
            n.tags.some((t) => `#${t}`.includes(q) || t.includes(q.replace(/^#/, '')))
        )
        .slice(0, 10)
        .map((n) => ({
          id: n.id,
          title: n.title,
          folder: n.folder,
          tags: n.tags,
          links: n.links,
          excerpt: n.content.slice(0, 220),
        }));
      return { result: JSON.stringify({ query: q, count: matches.length, matches }) };
    }

    case 'read_brain_note': {
      const key = String(args.titleOrId || '').trim().toLowerCase();
      const notes = getRoomBrainNotes(roomId);
      const note = notes.find(
        (n) => n.id.toLowerCase() === key || n.slug === key || n.title.toLowerCase() === key || n.title.toLowerCase().includes(key)
      );
      if (!note) {
        return { result: `No Second Brain note found matching "${key}".` };
      }
      const backlinks = notes
        .filter((other) => other.id !== note.id && other.links.some((l) => l.toLowerCase() === note.title.toLowerCase()))
        .map((other) => other.title);
      return { result: JSON.stringify({ ...note, backlinks }) };
    }

    case 'upsert_brain_note': {
      const title = String(args.title || '').trim();
      const content = String(args.content || '');
      const folder = String(args.folder || 'Notes').trim();
      const saved = upsertRoomBrainNote(roomId, {
        title,
        content,
        folder,
        source: 'jarvis',
      });
      void dispatchBridgeProxyCall(
        roomId,
        { action: 'vault_write', path: `${saved.folder}/${saved.slug}.md`, content: saved.content },
        4000
      ).catch(() => {});
      return {
        result: `Saved Second Brain note "[[${saved.title}]]" in folder "${saved.folder}" (${saved.links.length} wikilinks, ${saved.tags.length} tags).`,
      };
    }

    case 'link_brain_notes': {
      const sourceTitle = String(args.sourceTitle || '').trim();
      const targetTitle = String(args.targetTitle || '').trim();
      if (!sourceTitle || !targetTitle) {
        return { result: 'Both sourceTitle and targetTitle are required.' };
      }
      const notes = getRoomBrainNotes(roomId);
      const source = notes.find((n) => n.title.toLowerCase() === sourceTitle.toLowerCase());
      const baseContent = source?.content || `# ${sourceTitle}\n`;
      const linkMarkup = `[[${targetTitle}]]`;
      const nextContent = baseContent.includes(linkMarkup) ? baseContent : `${baseContent.trimEnd()}\n\nRelated: ${linkMarkup}\n`;
      const saved = upsertRoomBrainNote(roomId, {
        id: source?.id,
        title: source?.title || sourceTitle,
        folder: source?.folder || 'Notes',
        content: nextContent,
        source: 'jarvis',
      });
      return { result: `Linked [[${saved.title}]] -> [[${targetTitle}]] in the Knowledge Graph.` };
    }

    case 'google_workspace_action': {
      const action = String(args.action || '');
      let parsedArgs: Record<string, unknown> = { ...args };
      if (typeof args.argsJson === 'string' && args.argsJson.trim()) {
        try {
          parsedArgs = { ...parsedArgs, ...(JSON.parse(args.argsJson) as Record<string, unknown>) };
        } catch {
          // ignore invalid json
        }
      }
      return await executeGoogleWorkspaceAction({
        roomId,
        action,
        args: parsedArgs,
        googleAccessToken: options?.googleAccessToken,
        confirmed,
      });
    }

    case 'invoke_app_connector': {
      const connectorKey = String(args.connectorName || args.connectorId || '').trim().toLowerCase();
      const pool = options?.customConnectors?.length ? options.customConnectors : getRoomConnectors(roomId);
      const match = pool.find(
        (c) => c.id.toLowerCase() === connectorKey || c.name.toLowerCase() === connectorKey || c.name.toLowerCase().includes(connectorKey)
      );
      if (!match) {
        return {
          result: `No enabled App Connector found matching "${connectorKey}". Available connectors: ${pool.map((c) => c.name).join(', ') || 'none'}.`,
        };
      }
      return await executeAppConnectorAction({
        roomId,
        connector: match,
        args,
        notionToken: options?.notionToken,
        confirmed,
      });
    }

    case 'manage_shared_task': {
      const action = String(args.action || 'create');
      const title = String(args.title || '');
      const assignedDevice = String(args.assignedDevice || 'All Devices');
      if (action === 'complete') {
        const updated = toggleSharedTask(roomId, title, true);
        return {
          result: updated
            ? `Marked task "${updated.title}" as completed across all devices.`
            : `Could not find a task matching "${title}".`,
        };
      }
      const created = addSharedTask(roomId, title, assignedDevice);
      return { result: `Added shared task "${created.title}" assigned to ${created.assignedDevice}.` };
    }

    case 'open_application': {
      const appName = String(args.app_name || args.target || '');
      const target = String(args.targetDevice || 'bridge');
      const { summary } = await dispatchDeviceCommand({
        roomId,
        type: 'bridge_command',
        targetQuery: target,
        source: 'assistant',
        payload: { action: 'open_application', target: appName },
        waitForAckMs: 2800,
      });
      return { result: summary };
    }

    case 'close_application': {
      const appName = String(args.app_name || args.target || '');
      const target = String(args.targetDevice || 'bridge');
      const { summary } = await dispatchDeviceCommand({
        roomId,
        type: 'bridge_command',
        targetQuery: target,
        source: 'assistant',
        payload: { action: 'close_application', target: appName },
        waitForAckMs: 2800,
      });
      return { result: summary };
    }

    case 'kill_process': {
      const proc = String(args.process_identifier || args.target || '').trim();
      const target = String(args.targetDevice || 'bridge');
      if (!confirmed) {
        const req = createConfirmationRequest({
          roomId,
          toolName: 'kill_process',
          safetyLevel: 'sensitive',
          summary: `Terminate process "${proc}" on ${target}. Critical OS and browser processes remain protected by the safelist.`,
          targetDevice: target,
          args: { process_identifier: proc, targetDevice: target },
        });
        broadcastHudSound(roomId, 'alert');
        return {
          result: `REQUIRES_CONFIRMATION: Waiting for Ray's authorization to terminate "${proc}" (confirmationId=${req.id}).`,
          confirmation: req,
        };
      }
      const { summary } = await dispatchDeviceCommand({
        roomId,
        type: 'bridge_command',
        targetQuery: target,
        source: 'assistant',
        payload: { action: 'kill_process', target: proc },
        waitForAckMs: 2800,
      });
      broadcastHudSound(roomId, 'affirmative');
      return { result: summary };
    }

    case 'adjust_volume': {
      const level = Math.max(0, Math.min(100, Number(args.level ?? 50)));
      const target = String(args.targetDevice || 'bridge');
      const { summary } = await dispatchDeviceCommand({
        roomId,
        type: 'bridge_command',
        targetQuery: target,
        source: 'assistant',
        payload: { action: 'adjust_volume', level },
        waitForAckMs: 2500,
      });
      return { result: summary };
    }

    case 'optimize_system': {
      const target = String(args.targetDevice || 'bridge');
      if (!confirmed) {
        const req = createConfirmationRequest({
          roomId,
          toolName: 'optimize_system',
          safetyLevel: 'sensitive',
          summary: `Run system optimization & resource hog inspection on ${target}.`,
          targetDevice: target,
          args: { targetDevice: target },
        });
        broadcastHudSound(roomId, 'alert');
        return {
          result: `REQUIRES_CONFIRMATION: Waiting for Ray's authorization to optimize system (confirmationId=${req.id}).`,
          confirmation: req,
        };
      }
      const { summary } = await dispatchDeviceCommand({
        roomId,
        type: 'bridge_command',
        targetQuery: target,
        source: 'assistant',
        payload: { action: 'optimize_system' },
        waitForAckMs: 2800,
      });
      broadcastHudSound(roomId, 'affirmative');
      return { result: summary };
    }

    case 'execute_protocol': {
      const protocolName = String(args.protocol_name || 'house_party');
      const res = await executeProtocol(roomId, protocolName, confirmed);
      if (res.requiresConfirmation && res.confirmationId) {
        const req: ConfirmationRequest = {
          id: res.confirmationId,
          roomId,
          toolName: 'execute_protocol',
          safetyLevel: 'sensitive',
          summary: res.speechResponse,
          targetDevice: 'all',
          args: { protocol_name: protocolName },
          createdAt: Date.now(),
        };
        return {
          result: `REQUIRES_CONFIRMATION: ${res.speechResponse} (confirmationId=${req.id})`,
          confirmation: req,
        };
      }
      return { result: JSON.stringify(res) };
    }

    case 'analyze_task_goal': {
      const goal = String(args.goal || '');
      const analysis = await analyzeTaskGoal(roomId, goal);
      return { result: JSON.stringify(analysis) };
    }

    case 'run_bridge_command': {
      const target = String(args.targetDevice || 'bridge');
      const action = String(args.action || 'system_info');
      const appTarget = args.target ? String(args.target) : undefined;
      const { summary } = await dispatchDeviceCommand({
        roomId,
        type: 'bridge_command',
        targetQuery: target,
        source: 'assistant',
        payload: { action, target: appTarget },
        waitForAckMs: 3000,
      });
      return { result: summary };
    }

    default:
      return { result: `Unknown tool: ${name}` };
  }
}

export async function resolvePendingConfirmation(
  roomId: string,
  confirmationId: string,
  approved: boolean,
  sourceDeviceName: string,
  preferredVoice: VoicePersona = 'Fenrir',
  options?: Omit<ToolExecutionContextOptions, 'confirmed'>
): Promise<{ approved: boolean; summary: string; confirmation: ConfirmationRequest | null }> {
  const req = consumeConfirmationRequest(confirmationId, roomId);
  if (!req) {
    return { approved: false, summary: 'Confirmation request expired, unauthorized for this room, or already resolved.', confirmation: null };
  }
  if (!approved) {
    broadcastHudSound(req.roomId, 'blip');
    return {
      approved: false,
      summary: `Action "${req.toolName}" cancelled at Ray's request.`,
      confirmation: req,
    };
  }
  const exec = await executeDeviceTool(req.roomId, sourceDeviceName, req.toolName, req.args, preferredVoice, {
    ...options,
    confirmed: true,
  });
  return {
    approved: true,
    summary: exec.result,
    confirmation: req,
  };
}

export interface ChatTurnInput {
  roomId: string;
  sourceDeviceName: string;
  targetDeviceHint?: string;
  message: string;
  history: Array<{ role: 'user' | 'assistant'; text: string }>;
  attachments?: Array<{ mimeType: string; dataBase64: string }>;
  deepThinking?: boolean;
  enableSearch?: boolean;
  groundingMode?: 'auto' | 'search' | 'maps' | 'url';
  userLocation?: { latitude: number; longitude: number };
  preferredVoice?: VoicePersona;
  googleAccessToken?: string;
  notionToken?: string;
  customConnectors?: AppConnector[];
  onEvent: (event: { type: string; data: unknown }) => void;
}

export async function runAssistantChatTurn(input: ChatTurnInput): Promise<void> {
  const ai = getAiClient();
  setRoomInterrupted(input.roomId, false);
  const snapshot = getRoomSnapshot(input.roomId);
  const systemInstruction = buildJarvisSystemInstruction(
    input.roomId,
    input.sourceDeviceName,
    input.targetDeviceHint,
    false,
    {
      hasGoogleToken: Boolean(input.googleAccessToken),
      customConnectors: input.customConnectors,
    }
  );

  const contents: Content[] = [];
  for (const h of input.history.slice(-12)) {
    if (!h.text.trim()) continue;
    contents.push({
      role: h.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: h.text }],
    });
  }

  const userParts: Part[] = [];
  if (input.attachments && input.attachments.length > 0) {
    for (const att of input.attachments) {
      userParts.push({
        inlineData: {
          mimeType: att.mimeType,
          data: att.dataBase64,
        },
      });
    }
  }
  userParts.push({ text: input.message || 'Analyze the attached media.' });
  contents.push({ role: 'user', parts: userParts });

  const mode = input.groundingMode || 'auto';
  const tools: Array<Record<string, unknown>> = [];
  const toolConfig: Record<string, unknown> = {
    includeServerSideToolInvocations: true,
  };

  if (mode === 'maps') {
    tools.push({ googleMaps: {} });
    if (
      input.userLocation &&
      Number.isFinite(input.userLocation.latitude) &&
      Number.isFinite(input.userLocation.longitude)
    ) {
      toolConfig.retrievalConfig = {
        latLng: {
          latitude: input.userLocation.latitude,
          longitude: input.userLocation.longitude,
        },
      };
    }
  } else if (mode === 'url') {
    tools.push({ urlContext: {} });
  } else {
    if (input.enableSearch !== false || mode === 'search' || snapshot.veronicaMode) {
      tools.push({ googleSearch: {} });
    }
    tools.push({ functionDeclarations: baseToolDeclarations });
  }

  const useDeep = Boolean(input.deepThinking || snapshot.veronicaMode);
  const config: Record<string, unknown> = {
    systemInstruction,
    tools,
    toolConfig,
    thinkingConfig: {
      thinkingLevel: useDeep ? ThinkingLevel.XHIGH : ThinkingLevel.LOW,
    },
  };

  const collectedSources: GroundingSource[] = [];
  const toolLogs: ToolCallEvent[] = [];

  for (let round = 0; round < 5; round++) {
    if (isRoomInterrupted(input.roomId)) {
      input.onEvent({ type: 'text', data: 'Standing down, Ray. Execution halted on your command.' });
      input.onEvent({ type: 'done', data: { toolCalls: toolLogs, sources: collectedSources } });
      return;
    }

    const response = await generateContentWithFallback(ai, {
      model: 'gemini-4-hydrogen',
      contents,
      config,
    });

    const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks;
    if (Array.isArray(chunks)) {
      for (const ch of chunks) {
        if (ch.web?.uri && !collectedSources.some((s) => s.uri === ch.web?.uri)) {
          collectedSources.push({
            title: ch.web.title || ch.web.uri,
            uri: ch.web.uri,
          });
        }
        const mapsUri = (ch as { maps?: { uri?: string; title?: string } }).maps?.uri;
        const mapsTitle = (ch as { maps?: { uri?: string; title?: string } }).maps?.title;
        if (mapsUri && !collectedSources.some((s) => s.uri === mapsUri)) {
          collectedSources.push({
            title: mapsTitle ? `${mapsTitle} (Maps)` : 'Google Maps Place',
            uri: mapsUri,
          });
        }
      }
    }

    const candidateContent = response.candidates?.[0]?.content;
    const functionCalls = response.functionCalls;

    if (!functionCalls || functionCalls.length === 0) {
      const finalText = (response.text ?? '').trim() || 'Right away, Ray.';
      if (collectedSources.length > 0) {
        input.onEvent({ type: 'sources', data: collectedSources });
      }
      input.onEvent({ type: 'text', data: finalText });
      input.onEvent({ type: 'done', data: { toolCalls: toolLogs, sources: collectedSources } });
      return;
    }

    if (candidateContent) {
      contents.push(candidateContent);
    }

    const responseParts: Part[] = [];
    for (const call of functionCalls) {
      if (isRoomInterrupted(input.roomId)) {
        input.onEvent({ type: 'text', data: 'Emergency stop engaged, Ray. Halting remaining actions.' });
        input.onEvent({ type: 'done', data: { toolCalls: toolLogs, sources: collectedSources } });
        return;
      }

      const callId = call.id || `${call.name}-${Date.now()}`;
      const args = (call.args as Record<string, unknown>) ?? {};
      const toolEvent: ToolCallEvent = {
        id: callId,
        name: call.name ?? 'unknown_tool',
        args,
        status: 'running',
      };
      toolLogs.push(toolEvent);
      input.onEvent({ type: 'tool_start', data: toolEvent });

      let resultStr = '';
      try {
        const execOut = await executeDeviceTool(
          input.roomId,
          input.sourceDeviceName,
          call.name ?? '',
          args,
          input.preferredVoice || 'Fenrir',
          {
            googleAccessToken: input.googleAccessToken,
            notionToken: input.notionToken,
            customConnectors: input.customConnectors,
            userCommand: input.message || '',
          }
        );
        resultStr = execOut.result;
        if (execOut.confirmation) {
          toolEvent.status = 'awaiting_confirmation';
          toolEvent.result = resultStr;
          input.onEvent({ type: 'confirmation_required', data: execOut.confirmation });
        } else {
          toolEvent.status = 'completed';
          toolEvent.result = resultStr;
        }
      } catch (err) {
        resultStr = sanitizeErrorMessage(err);
        toolEvent.status = 'error';
        toolEvent.result = resultStr;
      }

      input.onEvent({ type: 'tool_end', data: toolEvent });

      responseParts.push({
        functionResponse: {
          id: call.id,
          name: call.name ?? '',
          response: { result: resultStr },
        },
      });
    }

    contents.push({
      role: 'user',
      parts: responseParts,
    });
  }

  input.onEvent({
    type: 'text',
    data: 'Requested actions have been dispatched across your devices, Ray.',
  });
  input.onEvent({ type: 'done', data: { toolCalls: toolLogs, sources: collectedSources } });
}

export async function summarizeUrlWithGemini(
  rawUrl: string,
  question?: string
): Promise<{ title: string; summary: string; url: string }> {
  const parsedUrl = assertSafeExternalUrl(rawUrl, { allowLocalhost: false });
  const safeUrl = parsedUrl.toString();
  const ai = getAiClient();
  const prompt = question?.trim()
    ? `Read and analyze ${safeUrl} carefully and answer Ray's request:\n${question.trim()}\nProvide a crisp title on the first line (Title: ...), then structured Markdown takeaways.`
    : `Read ${safeUrl} carefully and extract a structured Markdown summary with key takeaways, links, and actionable checklist items for Ray's Second Brain. Start with "Title: <concise page title>".`;

  const response = await generateContentWithFallback(ai, {
    model: 'gemini-4-hydrogen',
    contents: prompt,
    config: {
      tools: [{ urlContext: {} }],
      toolConfig: { includeServerSideToolInvocations: true },
    },
  });

  const text = (response.text ?? '').trim() || `Captured ${safeUrl}`;
  const firstLineMatch = text.match(/^Title:\s*(.+)$/im);
  const title = firstLineMatch
    ? firstLineMatch[1].trim().slice(0, 120)
    : parsedUrl.hostname.replace(/^www\./, '');
  const summary = text.replace(/^Title:\s*.+\n?/im, '').trim();
  return { title, summary: summary || text, url: safeUrl };
}

function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

export async function findSemanticBrainMatches(
  queryText: string,
  notes: Array<{ id: string; title: string; folder: string; content: string; tags?: string[] }>
): Promise<Array<{ id: string; title: string; folder: string; score: number }>> {
  const q = queryText.trim();
  if (!q || notes.length === 0) return [];
  const slice = notes.slice(0, 60);

  try {
    const ai = getAiClient();
    const [qRes, docRes] = await Promise.all([
      ai.models.embedContent({
        model: 'gemini-embedding-2',
        contents: [q],
        config: { taskType: 'RETRIEVAL_QUERY', outputDimensionality: 768 },
      }),
      ai.models.embedContent({
        model: 'gemini-embedding-2',
        contents: slice.map(
          (n) => `${n.title}\nFolder: ${n.folder}\nTags: ${(n.tags || []).join(', ')}\n${n.content.slice(0, 1200)}`
        ),
        config: { taskType: 'RETRIEVAL_DOCUMENT', outputDimensionality: 768 },
      }),
    ]);

    const qVec = qRes.embeddings?.[0]?.values || [];
    const docVecs = docRes.embeddings || [];
    if (qVec.length > 0 && docVecs.length === slice.length) {
      return slice
        .map((n, idx) => ({
          id: n.id,
          title: n.title,
          folder: n.folder,
          score: Number(cosineSimilarity(qVec, docVecs[idx]?.values || []).toFixed(4)),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 12);
    }
  } catch {
    // Graceful keyword ranking fallback if embedding API is unavailable
  }

  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  return slice
    .map((n) => {
      const hay = `${n.title} ${n.folder} ${(n.tags || []).join(' ')} ${n.content}`.toLowerCase();
      let hits = 0;
      for (const t of terms) {
        if (hay.includes(t)) hits += n.title.toLowerCase().includes(t) ? 2 : 1;
      }
      return {
        id: n.id,
        title: n.title,
        folder: n.folder,
        score: terms.length ? Number((hits / (terms.length * 2)).toFixed(3)) : 0,
      };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);
}

