export type DeviceType = 'desktop' | 'mobile' | 'tablet' | 'bridge';

export interface ProcessMetric {
  pid: number;
  name: string;
  cpuPercent: number;
  memoryPercent: number;
}

export interface DeviceTelemetry {
  batteryLevel?: number;
  batteryCharging?: boolean;
  networkType?: string;
  downlinkMbps?: number;
  screenWidth?: number;
  screenHeight?: number;
  timezone?: string;
  localTime?: string;
  latitude?: number;
  longitude?: number;
  platform?: string;
  cpuUsage?: string;
  cpuPercent?: number;
  memoryPercent?: number;
  memoryFreeMb?: number;
  memoryTotalMb?: number;
  uptimeMinutes?: number;
  activeWindow?: string;
  diskSummary?: string;
  topProcesses?: ProcessMetric[];
  /** Local Ollama status reported by a Desktop/Android bridge. */
  ollamaRunning?: boolean;
  ollamaModels?: string[];
  /** Number of installed apps the bridge can launch. */
  installedAppCount?: number;
  /** Open browser tabs reported by the RAY Tabs extension. */
  openTabCount?: number;
}

export interface DeviceInfo {
  id: string;
  name: string;
  type: DeviceType;
  os: string;
  browser: string;
  capabilities: string[];
  online: boolean;
  lastSeen: number;
  telemetry: DeviceTelemetry;
  /** MAC address reported by a bridge so another bridge on the LAN can Wake-on-LAN it. */
  macAddress?: string;
  /** True when this device registered a Web Push subscription (can be woken while closed). */
  pushEnabled?: boolean;
  /** Commands waiting for this device to come back online. */
  queuedCount?: number;
}

export type CommandType =
  | 'notify'
  | 'speak'
  | 'clipboard'
  | 'open_url'
  | 'set_timer'
  | 'request_snapshot'
  | 'refresh_telemetry'
  | 'bridge_command'
  | 'wake'
  | 'call';

export interface CommandExecutionResult {
  deviceId: string;
  deviceName: string;
  status: 'acknowledged' | 'completed' | 'failed';
  message: string;
  timestamp: number;
  data?: Record<string, unknown>;
}

export interface DeviceCommand {
  id: string;
  roomId: string;
  type: CommandType;
  targetDeviceId: string; // 'all' or specific deviceId
  targetDeviceLabel: string;
  source: 'assistant' | 'user' | 'routine' | 'protocol';
  payload: Record<string, unknown>;
  createdAt: number;
  status: 'dispatched' | 'acknowledged' | 'completed' | 'failed' | 'queued';
  results: CommandExecutionResult[];
}

export type TaskCategory = 'coding' | 'system' | 'research' | 'personal' | 'workflow' | 'general';
export type TaskPriority = 'critical' | 'high' | 'medium' | 'low';
export type SafetyLevel = 'safe' | 'moderate' | 'sensitive';

export interface SharedTask {
  id: string;
  title: string;
  completed: boolean;
  assignedDevice: string;
  category?: TaskCategory;
  priority?: TaskPriority;
  effortMinutes?: number;
  analysisId?: string;
  createdAt: number;
}

export interface HandoffItem {
  id: string;
  label: string;
  content: string;
  kind: 'text' | 'link' | 'code' | 'image';
  sourceDevice: string;
  targetDevice: string;
  createdAt: number;
}

export interface SyncTimer {
  id: string;
  label: string;
  durationSeconds: number;
  endsAt: number;
  targetDevice: string;
  createdAt: number;
}

export interface RoutineStep {
  toolName: string;
  targetDevice: string;
  description: string;
  args: Record<string, unknown>;
}

export interface RoutinePlan {
  id: string;
  title: string;
  goal: string;
  steps: RoutineStep[];
  createdAt: number;
}

export interface BrainNote {
  id: string;
  title: string;
  slug: string;
  folder: string;
  content: string;
  tags: string[];
  links: string[];
  source: 'user' | 'jarvis' | 'obsidian_local';
  createdAt: number;
  updatedAt: number;
}

export type AppConnectorCategory =
  | 'google'
  | 'browser'
  | 'notes'
  | 'social'
  | 'productivity'
  | 'automation';

export type AppConnectorType = 'notion' | 'bridge_app' | 'url_template' | 'webhook';

export interface AppConnector {
  id: string;
  name: string;
  category: AppConnectorCategory;
  connectorType: AppConnectorType;
  endpointOrTarget: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'LAUNCH';
  description: string;
  headersJson: string;
  enabled: boolean;
  requiresConfirmation: boolean;
  createdAt: number;
  updatedAt: number;
}

export type AiEngineProvider = 'auto' | 'gemini' | 'openrouter' | 'ollama' | 'groq' | 'anthropic' | 'openai' | 'huggingface';

export type GroundingMode = 'auto' | 'search' | 'maps' | 'url';

export interface TokenUsageStats {
  usedTokens: number;
  limitTokens: number;
  renewalDate: string;
  costOptimized: boolean;
}

export interface EngineSettings {
  provider: AiEngineProvider;
  /** Auto-router mode: 'auto' | 'swarm' | a provider id to pin (groq, cerebras, gemini…). */
  routerMode?: string;
  settingsVersion?: number;
  ollamaUrl: string;
  ollamaModel: string;
  openrouterModel: string;
  groqModel: string;
  anthropicModel: string;
  openaiModel: string;
  hfModel: string;
  useBridgeProxy: boolean;
  tokenUsage: TokenUsageStats;
}

export interface RoomSnapshot {
  roomId: string;
  devices: DeviceInfo[];
  commands: DeviceCommand[];
  tasks: SharedTask[];
  handoffs: HandoffItem[];
  timers: SyncTimer[];
  routines: RoutinePlan[];
  brainNotes?: BrainNote[];
  connectors?: AppConnector[];
  veronicaMode?: boolean;
  interrupted?: boolean;
  screenControlArmed?: boolean;
  incomingMessages?: IncomingMessage[];
}

export interface IncomingMessage {
  id: string;
  app: string; // whatsapp | instagram | messenger | sms | telegram | ...
  from: string;
  text: string;
  receivedAt: number;
  viaDevice: string;
  read?: boolean;
}

/** A ring sent to a device: either RAY calling Ray, or another device starting a live call. */
export interface CallPayload {
  callId: string;
  kind: 'ray' | 'peer';
  fromName: string;
  /** For kind 'peer': the device that is calling (WebRTC caller). */
  fromDeviceId?: string;
  /** For kind 'ray': what RAY says when you answer. */
  message?: string;
  createdAt: number;
}

export interface ScheduledCall {
  id: string;
  targetDevice: string;
  message: string;
  nextAt: number;
  repeat: 'none' | 'daily' | 'weekdays';
  createdAt: number;
}

export interface BrowserTabInfo {
  id: number;
  windowId: number;
  title: string;
  url: string;
  active: boolean;
  audible?: boolean;
  lastAccessed?: number;
}

export interface ToolCallEvent {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: 'running' | 'completed' | 'error' | 'awaiting_confirmation';
  result?: string;
}

export interface GroundingSource {
  title: string;
  uri: string;
}

export interface ChatAttachment {
  id: string;
  name: string;
  mimeType: string;
  dataUrl: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  attachments?: ChatAttachment[];
  toolCalls?: ToolCallEvent[];
  sources?: GroundingSource[];
  createdAt: number;
  thinkingMode?: 'fast' | 'deep';
  /** Which engine/model produced this reply (e.g. "Groq · openai/gpt-oss-120b"). */
  engineLabel?: string;
  /** error replies are shown as errors, not saved as normal answers. */
  kind?: 'normal' | 'error';
}

export type VoicePersona = 'Kore' | 'Puck' | 'Charon' | 'Fenrir' | 'Zephyr';

export type CapabilityCategory =
  | 'application'
  | 'system'
  | 'gui'
  | 'browser'
  | 'notification'
  | 'protocol'
  | 'screen'
  | 'brain'
  | 'files'
  | 'workspace'
  | 'connector';

export interface CapabilityMeta {
  name: string;
  description: string;
  category: CapabilityCategory;
  safetyLevel: SafetyLevel;
  requiresConfirmation: boolean;
  parameters: Array<{ name: string; type: string; required: boolean; description: string }>;
}

export type ProtocolName = 'clean_slate' | 'house_party' | 'sentry_mode' | 'veronica';

export interface ProtocolResult {
  success: boolean;
  requiresConfirmation?: boolean;
  confirmationId?: string;
  protocol: string;
  protocolKey: ProtocolName;
  speechResponse: string;
  mode?: string;
  securityStatus?: 'SECURE' | 'ELEVATED';
  details: Record<string, unknown>;
  executedAt: number;
}

export interface ConfirmationRequest {
  id: string;
  roomId: string;
  toolName: string;
  safetyLevel: SafetyLevel;
  summary: string;
  targetDevice: string;
  args: Record<string, unknown>;
  createdAt: number;
  expiresAt?: number;
  /** When set, the approval card shows a masked input (password / one-time code) with this label. */
  secretPrompt?: string;
}

export interface ExecutableAnalysisStep {
  toolName: string;
  targetDevice: string;
  description: string;
  argsJson: string;
}

export interface TaskAnalysisResult {
  id: string;
  goal: string;
  category: TaskCategory;
  priority: TaskPriority;
  effortMinutes: number;
  recommendedDevice: string;
  safetyLevel: SafetyLevel;
  summary: string;
  blockers: string[];
  subtasks: string[];
  executableSteps: ExecutableAnalysisStep[];
  createdAt: number;
}

export type HudSoundType = 'wake' | 'affirmative' | 'blip' | 'alert' | 'protocol' | 'clean_slate';

export type LiveVoiceState =
  | 'off'
  | 'standby'
  | 'connecting'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'interrupted';

export interface UserProfile {
  userId: string;
  email: string;
  displayName: string;
  photoURL: string;
  preferredVoice: VoicePersona;
  wakeEnabled: boolean;
  wakeSensitivity: number;
}
