import React, { useState } from 'react';
import {
  Activity,
  AppWindow,
  Battery,
  Bell,
  Camera,
  Check,
  Edit2,
  ExternalLink,
  Laptop,
  MapPin,
  RefreshCw,
  ShieldAlert,
  Smartphone,
  Tablet,
  Terminal,
  Trash2,
  Volume2,
  Wifi,
  Phone,
  Video,
} from 'lucide-react';
import type { DeviceCommand, DeviceInfo, ProtocolName, ProtocolResult } from '../types/relay';
import { playHudSound } from '../utils/hudAudio';
import { authFetch } from '../utils/roomAuth';

interface DevicesViewProps {
  roomId: string;
  devices: DeviceInfo[];
  commands: DeviceCommand[];
  localDeviceId: string;
  onRenameDevice: (id: string, name: string) => void;
  onRemoveDevice: (id: string) => void;
  onCallDevice?: (id: string, name: string, video?: boolean) => void;
  onShareLocation: () => Promise<unknown>;
  onOpenPairModal: () => void;
}

function DeviceIcon({ type }: { type: DeviceInfo['type'] }) {
  if (type === 'mobile') return <Smartphone className="w-5 h-5" />;
  if (type === 'tablet') return <Tablet className="w-5 h-5" />;
  if (type === 'bridge') return <Terminal className="w-5 h-5" />;
  return <Laptop className="w-5 h-5" />;
}

export const DevicesView: React.FC<DevicesViewProps> = ({
  roomId,
  devices,
  commands,
  localDeviceId,
  onRenameDevice,
  onRemoveDevice,
  onCallDevice,
  onShareLocation,
  onOpenPairModal,
}) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [quickTarget, setQuickTarget] = useState<string | null>(null);
  const [quickMode, setQuickMode] = useState<'notify' | 'speak' | 'open_url' | 'open_app'>('notify');
  const [quickText, setQuickText] = useState('');
  const [busyDeviceId, setBusyDeviceId] = useState<string | null>(null);
  const [runningProto, setRunningProto] = useState<ProtocolName | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const dispatchCommand = async (
    targetDevice: string,
    type: DeviceCommand['type'],
    payload: Record<string, unknown>
  ) => {
    setBusyDeviceId(targetDevice);
    setFeedback(null);
    try {
      const res = await authFetch('/api/device/command', roomId, {
        method: 'POST',
        body: JSON.stringify({ roomId, type, targetDevice, payload }),
      });
      const data = (await res.json()) as { summary?: string; error?: string };
      if (!res.ok) throw new Error(data.error || 'Command failed');
      playHudSound('affirmative');
      setFeedback(data.summary || 'Command dispatched.');
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Failed to dispatch command');
    } finally {
      setBusyDeviceId(null);
    }
  };

  const handleRunMeshProtocol = async (protocolName: 'house_party' | 'sentry_mode') => {
    setRunningProto(protocolName);
    setFeedback(null);
    playHudSound('protocol');
    try {
      const res = await authFetch('/api/protocols/run', roomId, {
        method: 'POST',
        body: JSON.stringify({ roomId, protocolName }),
      });
      const data = (await res.json()) as ProtocolResult & { error?: string };
      if (!res.ok) throw new Error(data.error || 'Protocol failed');
      setFeedback(`${data.protocol}: ${data.speechResponse}`);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Failed to run protocol');
    } finally {
      setRunningProto(null);
    }
  };

  const handleCaptureBridgeScreen = async (deviceId: string) => {
    setBusyDeviceId(deviceId);
    setFeedback(null);
    try {
      const res = await authFetch('/api/screen/capture', roomId, {
        method: 'POST',
        body: JSON.stringify({ roomId }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(data.error || 'Screen capture failed');
      playHudSound('affirmative');
      setFeedback('Captured desktop screenshot from Desktop OS Bridge.');
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Screen capture failed');
    } finally {
      setBusyDeviceId(null);
    }
  };

  const handleQuickSubmit = async (e: React.FormEvent, deviceId: string) => {
    e.preventDefault();
    if (!quickText.trim()) return;
    if (quickMode === 'notify') {
      await dispatchCommand(deviceId, 'notify', {
        title: 'RAY Alert',
        message: quickText.trim(),
      });
    } else if (quickMode === 'speak') {
      await dispatchCommand(deviceId, 'speak', {
        text: quickText.trim(),
      });
    } else if (quickMode === 'open_app') {
      await dispatchCommand(deviceId, 'bridge_command', {
        action: 'open_application',
        target: quickText.trim(),
      });
    } else if (quickMode === 'open_url') {
      const url = /^https?:\/\//i.test(quickText.trim())
        ? quickText.trim()
        : `https://${quickText.trim()}`;
      await dispatchCommand(deviceId, 'open_url', {
        url,
        title: url,
      });
    }
    setQuickText('');
    setQuickTarget(null);
  };

  const onlineCount = devices.filter((d) => d.online).length;

  return (
    <div className="max-w-6xl mx-auto p-4 sm:p-6 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-xl font-bold text-slate-900 dark:text-slate-100">
            Connected Device Mesh
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            {onlineCount} online in room <span className="font-mono">{roomId}</span> · Dispatch alerts, speech, OS app launches, camera snapshots, and live resource sweeps.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 self-start sm:self-auto">
          <button
            type="button"
            disabled={runningProto !== null}
            onClick={() => void handleRunMeshProtocol('house_party')}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
          >
            <Activity className="w-3.5 h-3.5" />
            <span>{runningProto === 'house_party' ? 'Sweeping...' : 'House Party Sweep'}</span>
          </button>
          <button
            type="button"
            disabled={runningProto !== null}
            onClick={() => void handleRunMeshProtocol('sentry_mode')}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
          >
            <ShieldAlert className="w-3.5 h-3.5" />
            <span>{runningProto === 'sentry_mode' ? 'Scanning...' : 'Sentry Scan'}</span>
          </button>
          <button
            type="button"
            onClick={onOpenPairModal}
            className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            Add Device or Bridge
          </button>
        </div>
      </div>

      {feedback && (
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 py-2.5 text-xs text-slate-700 dark:text-slate-200">
          {feedback}
        </div>
      )}

      {/* Device Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {devices.map((device) => {
          const isSelf = device.id === localDeviceId;
          const isEditing = editingId === device.id;
          const isQuickOpen = quickTarget === device.id;
          const topProcesses = device.telemetry.topProcesses || [];

          return (
            <div
              key={device.id}
              className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3 min-w-0">
                  <div
                    className={`p-2.5 rounded-lg border ${
                      device.online
                        ? 'border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 bg-slate-50 dark:bg-slate-800'
                        : 'border-slate-200 dark:border-slate-800 text-slate-400 dark:text-slate-600 bg-slate-50 dark:bg-slate-950'
                    }`}
                  >
                    <DeviceIcon type={device.type} />
                  </div>
                  <div className="min-w-0">
                    {isEditing ? (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          if (editName.trim()) onRenameDevice(device.id, editName.trim());
                          setEditingId(null);
                        }}
                        className="flex items-center gap-1.5"
                      >
                        <input
                          type="text"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          autoFocus
                          className="px-2 py-1 text-sm bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded"
                        />
                        <button
                          type="submit"
                          aria-label="Save device name"
                          className="p-1 text-blue-600 hover:bg-slate-100 dark:hover:bg-slate-800 rounded"
                        >
                          <Check className="w-4 h-4" />
                        </button>
                      </form>
                    ) : (
                      <div className="flex items-center gap-2">
                        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
                          {device.name}
                        </h2>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingId(device.id);
                            setEditName(device.name);
                          }}
                          aria-label={`Rename ${device.name}`}
                          className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 p-0.5"
                        >
                          <Edit2 className="w-3 h-3" />
                        </button>
                      </div>
                    )}

                    <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                      <span>{device.os}</span>
                      <span aria-hidden="true"> · </span>
                      <span>{device.browser}</span>
                      {isSelf && (
                        <>
                          <span aria-hidden="true"> · </span>
                          <span className="text-blue-600 dark:text-blue-400 font-medium">This device</span>
                        </>
                      )}
                      <span aria-hidden="true"> · </span>
                      <span
                        className={
                          device.online
                            ? 'text-emerald-700 dark:text-emerald-400 font-medium'
                            : 'text-slate-400'
                        }
                      >
                        {device.online ? 'Online' : 'Offline'}
                      </span>
                    </div>
                  </div>
                </div>

                {!isSelf && device.online && device.type !== 'bridge' && !device.capabilities?.includes('browser-tabs') && onCallDevice && (
                  <>
                    <button
                      type="button"
                      onClick={() => onCallDevice(device.id, device.name)}
                      aria-label={`Call ${device.name}`}
                      className="p-1.5 text-emerald-600 hover:bg-emerald-500/10 rounded-lg"
                    >
                      <Phone className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onCallDevice(device.id, device.name, true)}
                      aria-label={`Video call ${device.name}`}
                      className="p-1.5 text-blue-600 hover:bg-blue-500/10 rounded-lg"
                    >
                      <Video className="w-4 h-4" />
                    </button>
                  </>
                )}
                {!isSelf && (
                  <button
                    type="button"
                    onClick={() => onRemoveDevice(device.id)}
                    aria-label={`Remove ${device.name}`}
                    className="p-1.5 text-slate-400 hover:text-red-600 rounded-lg"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>

              {/* Telemetry Grid */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 pt-2 border-t border-slate-100 dark:border-slate-800 text-xs">
                <div>
                  <span className="text-slate-500 dark:text-slate-400 block">
                    {device.type === 'bridge' ? 'CPU Load' : 'Battery / Power'}
                  </span>
                  <span className="font-mono tabular-nums font-medium text-slate-900 dark:text-slate-100 inline-flex items-center gap-1 mt-0.5">
                    <Battery className="w-3.5 h-3.5 text-slate-400" />
                    {device.telemetry.cpuPercent != null
                      ? `${device.telemetry.cpuPercent}% CPU`
                      : device.telemetry.batteryLevel != null
                      ? `${device.telemetry.batteryLevel}%${device.telemetry.batteryCharging ? ' (Charging)' : ''}`
                      : device.telemetry.cpuUsage || 'AC / Desktop'}
                  </span>
                </div>

                <div>
                  <span className="text-slate-500 dark:text-slate-400 block">Network / Memory</span>
                  <span className="font-mono tabular-nums font-medium text-slate-900 dark:text-slate-100 inline-flex items-center gap-1 mt-0.5">
                    <Wifi className="w-3.5 h-3.5 text-slate-400" />
                    {device.telemetry.memoryPercent != null
                      ? `${device.telemetry.memoryPercent}% RAM (${device.telemetry.memoryFreeMb ?? 0}MB free)`
                      : device.telemetry.networkType
                      ? `${device.telemetry.networkType.toUpperCase()} ${device.telemetry.downlinkMbps ?? ''}Mbps`
                      : device.telemetry.memoryFreeMb != null
                      ? `${device.telemetry.memoryFreeMb}MB free`
                      : 'Active'}
                  </span>
                </div>

                <div>
                  <span className="text-slate-500 dark:text-slate-400 block">
                    {device.telemetry.uptimeMinutes != null ? 'OS Uptime' : 'Display / Time'}
                  </span>
                  <span className="font-mono tabular-nums font-medium text-slate-900 dark:text-slate-100 block mt-0.5">
                    {device.telemetry.uptimeMinutes != null
                      ? `${device.telemetry.uptimeMinutes}m`
                      : device.telemetry.screenWidth && device.telemetry.screenHeight
                      ? `${device.telemetry.screenWidth}×${device.telemetry.screenHeight}`
                      : device.telemetry.localTime || 'Local'}
                  </span>
                </div>
              </div>

              {/* Bridge Top Processes */}
              {device.type === 'bridge' && topProcesses.length > 0 && (
                <div className="pt-2 border-t border-slate-100 dark:border-slate-800 space-y-1.5">
                  <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                    Top Active OS Processes
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                    {topProcesses.slice(0, 4).map((proc) => (
                      <div
                        key={proc.pid}
                        className="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-[11px]"
                      >
                        <span className="font-mono text-slate-800 dark:text-slate-200 truncate">
                          {proc.name}
                        </span>
                        <span className="font-mono tabular-nums text-slate-500 dark:text-slate-400 shrink-0 ml-2">
                          {proc.cpuPercent}% · {proc.memoryPercent}%
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {device.telemetry.latitude != null && device.telemetry.longitude != null && (
                <div className="text-xs text-slate-600 dark:text-slate-400 font-mono tabular-nums flex items-center gap-1.5">
                  <MapPin className="w-3.5 h-3.5 text-slate-400" />
                  <span>
                    {device.telemetry.latitude}, {device.telemetry.longitude}
                  </span>
                </div>
              )}

              {/* Direct Quick Controls */}
              <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
                <button
                  type="button"
                  disabled={!device.online || busyDeviceId === device.id}
                  onClick={() => {
                    setQuickTarget(isQuickOpen && quickMode === 'notify' ? null : device.id);
                    setQuickMode('notify');
                  }}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 whitespace-nowrap shrink-0"
                >
                  <Bell className="w-3.5 h-3.5" />
                  <span>Alert</span>
                </button>
                <button
                  type="button"
                  disabled={!device.online || busyDeviceId === device.id}
                  onClick={() => {
                    setQuickTarget(isQuickOpen && quickMode === 'speak' ? null : device.id);
                    setQuickMode('speak');
                  }}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 whitespace-nowrap shrink-0"
                >
                  <Volume2 className="w-3.5 h-3.5" />
                  <span>Speak</span>
                </button>
                <button
                  type="button"
                  disabled={!device.online || busyDeviceId === device.id}
                  onClick={() => {
                    setQuickTarget(isQuickOpen && quickMode === 'open_url' ? null : device.id);
                    setQuickMode('open_url');
                  }}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 whitespace-nowrap shrink-0"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  <span>Open URL</span>
                </button>
                {device.type === 'bridge' && (
                  <>
                    <button
                      type="button"
                      disabled={!device.online || busyDeviceId === device.id}
                      onClick={() => {
                        setQuickTarget(isQuickOpen && quickMode === 'open_app' ? null : device.id);
                        setQuickMode('open_app');
                      }}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 whitespace-nowrap shrink-0"
                    >
                      <AppWindow className="w-3.5 h-3.5" />
                      <span>Launch App</span>
                    </button>
                    <button
                      type="button"
                      disabled={!device.online || busyDeviceId === device.id}
                      onClick={() => void handleCaptureBridgeScreen(device.id)}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 whitespace-nowrap shrink-0"
                    >
                      <Camera className="w-3.5 h-3.5" />
                      <span>OS Screen</span>
                    </button>
                  </>
                )}
                {device.type !== 'bridge' && (
                  <button
                    type="button"
                    disabled={!device.online || busyDeviceId === device.id}
                    onClick={() =>
                      dispatchCommand(device.id, 'request_snapshot', {
                        reason: 'Requested from Devices console',
                      })
                    }
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 whitespace-nowrap shrink-0"
                  >
                    <Camera className="w-3.5 h-3.5" />
                    <span>Snapshot</span>
                  </button>
                )}
                <button
                  type="button"
                  disabled={!device.online || busyDeviceId === device.id}
                  onClick={() => dispatchCommand(device.id, 'refresh_telemetry', {})}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 whitespace-nowrap shrink-0"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Refresh</span>
                </button>
                {isSelf && (
                  <button
                    type="button"
                    onClick={() => void onShareLocation()}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
                  >
                    <MapPin className="w-3.5 h-3.5" />
                    <span>Share GPS</span>
                  </button>
                )}
              </div>

              {isQuickOpen && (
                <form
                  onSubmit={(e) => handleQuickSubmit(e, device.id)}
                  className="flex items-center gap-2 pt-1"
                >
                  <input
                    type="text"
                    value={quickText}
                    onChange={(e) => setQuickText(e.target.value)}
                    autoFocus
                    placeholder={
                      quickMode === 'notify'
                        ? 'Alert message...'
                        : quickMode === 'speak'
                        ? 'Text to speak aloud on this device...'
                        : quickMode === 'open_app'
                        ? 'Application name (e.g. Visual Studio Code, Chrome, Notes)...'
                        : 'https://example.com'
                    }
                    className="flex-1 px-3 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100"
                  />
                  <button
                    type="submit"
                    className="px-3 py-1.5 text-xs font-semibold bg-blue-600 text-white rounded-lg hover:bg-blue-700 whitespace-nowrap shrink-0"
                  >
                    Send
                  </button>
                </form>
              )}
            </div>
          );
        })}
      </div>

      {/* Command Execution Log Table */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Device Command Log
          </h2>
        </div>

        {commands.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-500 dark:text-slate-400">
            No device commands dispatched yet. Ask RAY to run a task on your devices or trigger a quick action above.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400">
                  <th className="py-2.5 px-4">Time</th>
                  <th className="py-2.5 px-4">Command</th>
                  <th className="py-2.5 px-4">Target</th>
                  <th className="py-2.5 px-4">Status</th>
                  <th className="py-2.5 px-4">Execution Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
                {commands.map((cmd) => (
                  <tr key={cmd.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <td className="py-2.5 px-4 font-mono tabular-nums text-slate-500 dark:text-slate-400 whitespace-nowrap">
                      {new Date(cmd.createdAt).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                      })}
                    </td>
                    <td className="py-2.5 px-4 font-mono font-medium text-slate-900 dark:text-slate-100 whitespace-nowrap">
                      {cmd.type}
                    </td>
                    <td className="py-2.5 px-4 text-slate-700 dark:text-slate-300">
                      {cmd.targetDeviceLabel}
                    </td>
                    <td className="py-2.5 px-4 whitespace-nowrap">
                      <span
                        className={`font-medium ${
                          cmd.status === 'completed'
                            ? 'text-emerald-700 dark:text-emerald-400'
                            : cmd.status === 'failed'
                            ? 'text-red-600 dark:text-red-400'
                            : 'text-amber-700 dark:text-amber-400'
                        }`}
                      >
                        {cmd.status === 'completed'
                          ? 'Completed'
                          : cmd.status === 'failed'
                          ? 'Failed'
                          : 'Dispatched'}
                      </span>
                    </td>
                    <td className="py-2.5 px-4 text-slate-600 dark:text-slate-400 max-w-md truncate">
                      {cmd.results.length > 0
                        ? cmd.results.map((r) => `${r.deviceName}: ${r.message}`).join(' · ')
                        : 'Waiting for confirmation'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
};
