import React, { useEffect, useState } from 'react';
import {
  Blocks,
  Bot,
  Brain,
  ClipboardList,
  Cloud,
  FolderOpen,
  Home,
  Laptop,
  Layers,
  LogIn,
  LogOut,
  MonitorSmartphone,
  Moon,
  Smartphone,
  Sun,
  Tablet,
  Terminal,
  Timer,
  Wifi,
  WifiOff,
  X,
  Cable,
} from 'lucide-react';
import type { User } from 'firebase/auth';
import type { ActiveTab } from './TopBar';
import type { DeviceInfo, SyncTimer } from '../types/relay';
import type { SocketStatus } from '../hooks/useRelaySocket';

interface SidebarProps {
  activeTab: ActiveTab;
  onSelectTab: (tab: ActiveTab) => void;
  roomId: string;
  socketStatus: SocketStatus;
  devices: DeviceInfo[];
  localDeviceId: string;
  timers: SyncTimer[];
  darkMode: boolean;
  onToggleDarkMode: () => void;
  onOpenPairModal: () => void;
  onSelectDeviceTarget: (deviceName: string) => void;
  onCancelTimer: (timerId: string) => void;
  user: User | null;
  authReady: boolean;
  authError: string | null;
  onSignIn: () => Promise<void>;
  onSignOut: () => Promise<void>;
}

function DeviceGlyph({ type }: { type: DeviceInfo['type'] }) {
  if (type === 'mobile') return <Smartphone className="w-4 h-4 shrink-0" />;
  if (type === 'tablet') return <Tablet className="w-4 h-4 shrink-0" />;
  if (type === 'bridge') return <Terminal className="w-4 h-4 shrink-0" />;
  return <Laptop className="w-4 h-4 shrink-0" />;
}

function formatRemaining(endsAt: number, now: number): string {
  const diff = Math.max(0, Math.ceil((endsAt - now) / 1000));
  const mins = Math.floor(diff / 60);
  const secs = diff % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

const SIDEBAR_NAV: Array<{ id: ActiveTab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'dashboard', label: 'Home', icon: Home },
  { id: 'assistant', label: 'AI Assistant', icon: Bot },
  { id: 'brain', label: 'Second Brain', icon: Brain },
  { id: 'files', label: 'Files & OS', icon: FolderOpen },
  { id: 'apps', label: 'Apps & Connectors', icon: Blocks },
  { id: 'devices', label: 'Devices', icon: MonitorSmartphone },
  { id: 'connect', label: 'Connections & Engines', icon: Cable },
  { id: 'routines', label: 'Routines', icon: ClipboardList },
  { id: 'handoff', label: 'Handoff', icon: Layers },
];

export const Sidebar: React.FC<SidebarProps> = ({
  activeTab,
  onSelectTab,
  roomId,
  socketStatus,
  devices,
  localDeviceId,
  timers,
  darkMode,
  onToggleDarkMode,
  onOpenPairModal,
  onSelectDeviceTarget,
  onCancelTimer,
  user,
  authReady,
  authError,
  onSignIn,
  onSignOut,
}) => {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (timers.length === 0) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [timers.length]);

  const onlineDevices = devices.filter((d) => d.online);

  return (
    <aside className="hidden lg:flex w-64 shrink-0 flex-col border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
      <div className="p-4 border-b border-slate-200 dark:border-slate-800 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400">Workspace Room</span>
          <button
            type="button"
            onClick={onOpenPairModal}
            className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline whitespace-nowrap shrink-0"
          >
            Switch
          </button>
        </div>
        <div className="flex items-center justify-between">
          <span className="font-mono text-sm font-semibold text-slate-900 dark:text-slate-100 tabular-nums">
            {roomId}
          </span>
          <span
            className={`inline-flex items-center gap-1.5 text-xs font-medium ${
              socketStatus === 'connected'
                ? 'text-emerald-700 dark:text-emerald-400'
                : 'text-amber-700 dark:text-amber-400'
            }`}
          >
            {socketStatus === 'connected' ? (
              <Wifi className="w-3.5 h-3.5" />
            ) : (
              <WifiOff className="w-3.5 h-3.5" />
            )}
            <span>
              {socketStatus === 'connected'
                ? 'Connected'
                : socketStatus === 'connecting'
                ? 'Connecting'
                : 'Reconnecting'}
            </span>
          </span>
        </div>
      </div>

      {/* Firebase Cloud Sync Account */}
      <div className="p-4 border-b border-slate-200 dark:border-slate-800 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400 inline-flex items-center gap-1.5">
            <Cloud className="w-3.5 h-3.5" />
            <span>Cloud Memory</span>
          </span>
          {user && (
            <span className="text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
              Synced
            </span>
          )}
        </div>

        {!authReady ? (
          <p className="text-xs text-slate-500 dark:text-slate-400">Checking session...</p>
        ) : user ? (
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">
                {user.displayName || 'Ray'}
              </div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                {user.email}
              </div>
            </div>
            <button
              type="button"
              onClick={() => void onSignOut()}
              title="Sign out of Cloud Memory"
              aria-label="Sign out"
              className="p-1.5 text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 border border-slate-200 dark:border-slate-700 rounded-lg shrink-0"
            >
              <LogOut className="w-3.5 h-3.5" />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => void onSignIn()}
            className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-900 dark:text-slate-100 border border-slate-200 dark:border-slate-700 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            <LogIn className="w-3.5 h-3.5" />
            <span>Sign in with Google</span>
          </button>
        )}

        {authError && (
          <p className="text-[11px] text-red-600 dark:text-red-400 leading-snug">{authError}</p>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-5">
        <section>
          <h2 className="text-xs font-semibold text-slate-500 dark:text-slate-400 mb-2">
            Navigation
          </h2>
          <ul className="space-y-1">
            {SIDEBAR_NAV.map((item) => {
              const Icon = item.icon;
              const active = activeTab === item.id;
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => onSelectTab(item.id)}
                    className={`w-full px-2.5 py-2 rounded-lg text-xs font-medium flex items-center gap-2.5 transition-colors whitespace-nowrap ${
                      active
                        ? 'bg-blue-600 text-white'
                        : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/70'
                    }`}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    <span className="truncate">{item.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="pt-4 border-t border-slate-200 dark:border-slate-800">
          <div className="flex items-center justify-between mb-2.5">
            <h2 className="text-xs font-semibold text-slate-500 dark:text-slate-400">
              Paired Devices ({onlineDevices.length} online)
            </h2>
          </div>

          {devices.length === 0 ? (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Registering this device...
            </p>
          ) : (
            <ul className="space-y-1">
              {devices.map((device) => {
                const isSelf = device.id === localDeviceId;
                return (
                  <li key={device.id}>
                    <button
                      type="button"
                      onClick={() => onSelectDeviceTarget(device.name)}
                      className="w-full text-left px-2.5 py-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800/70 transition-colors flex items-start gap-2.5 group"
                      title={`Target ${device.name} in Assistant`}
                    >
                      <span
                        className={`mt-0.5 ${
                          device.online
                            ? 'text-slate-700 dark:text-slate-200'
                            : 'text-slate-400 dark:text-slate-600'
                        }`}
                      >
                        <DeviceGlyph type={device.type} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-xs font-medium text-slate-900 dark:text-slate-100 truncate">
                          {device.name}
                        </span>
                        <span className="block text-[11px] text-slate-500 dark:text-slate-400 truncate">
                          {isSelf ? 'This device' : device.os}
                          {' · '}
                          {device.online ? 'Online' : 'Offline'}
                          {device.telemetry.batteryLevel != null
                            ? ` · ${device.telemetry.batteryLevel}%`
                            : device.telemetry.cpuPercent != null
                            ? ` · ${device.telemetry.cpuPercent}% CPU`
                            : ''}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {timers.length > 0 && (
          <section className="pt-4 border-t border-slate-200 dark:border-slate-800">
            <h2 className="text-xs font-semibold text-slate-500 dark:text-slate-400 mb-2.5">
              Active Timers
            </h2>
            <ul className="space-y-2">
              {timers.map((timer) => {
                const expired = timer.endsAt <= now;
                return (
                  <li
                    key={timer.id}
                    className="flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/50"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 text-xs font-medium text-slate-900 dark:text-slate-100 truncate">
                        <Timer className="w-3.5 h-3.5 shrink-0 text-blue-600 dark:text-blue-400" />
                        <span className="truncate">{timer.label}</span>
                      </div>
                      <div className="font-mono text-xs text-slate-600 dark:text-slate-400 tabular-nums mt-0.5">
                        {expired ? 'Completed' : formatRemaining(timer.endsAt, now)}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => onCancelTimer(timer.id)}
                      aria-label={`Cancel ${timer.label}`}
                      className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 rounded"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        <section className="pt-4 border-t border-slate-200 dark:border-slate-800">
          <h2 className="text-xs font-semibold text-slate-500 dark:text-slate-400 mb-2">
            Shortcuts
          </h2>
          <div className="space-y-1.5 text-[11px] text-slate-600 dark:text-slate-400">
            <div className="flex items-center justify-between">
              <span className="font-mono px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-200">Alt+H</span>
              <span>Home Dashboard</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="font-mono px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-200">Alt+R</span>
              <span>AI Assistant</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="font-mono px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-200">Alt+B</span>
              <span>Second Brain</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="font-mono px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-200">Alt+F</span>
              <span>Files &amp; OS</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="font-mono px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-200">Alt+A</span>
              <span>Apps &amp; Connectors</span>
            </div>
          </div>
        </section>
      </div>

      <div className="p-4 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between">
        <span className="text-xs text-slate-500 dark:text-slate-400">Appearance</span>
        <button
          type="button"
          onClick={onToggleDarkMode}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
        >
          {darkMode ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
          <span>{darkMode ? 'Light' : 'Dark'}</span>
        </button>
      </div>
    </aside>
  );
};
