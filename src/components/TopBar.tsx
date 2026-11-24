import React from 'react';
import { OctagonX, PictureInPicture2 } from 'lucide-react';
import { PWAInstallButton } from './PWAInstallButton';

export type ActiveTab = 'dashboard' | 'assistant' | 'brain' | 'files' | 'apps' | 'devices' | 'routines' | 'handoff' | 'connect' | 'brain3d' | 'jarvis';

interface TopBarProps {
  activeTab: ActiveTab;
  onSelectTab: (tab: ActiveTab) => void;
  onOpenPairModal: () => void;
  onEmergencyStop: () => void;
  showEmergencyStop?: boolean;
  /** Opens RAY as a small window on top of every app (PC browsers that support it). */
  onFloat?: () => void;
  floating?: boolean;
}

const NAV_ITEMS: Array<{ id: ActiveTab; label: string }> = [
  { id: 'dashboard', label: 'Home' },
  { id: 'assistant', label: 'Assistant' },
  { id: 'jarvis', label: 'JARVIS Core' },
  { id: 'brain', label: 'Notes' },
  { id: 'brain3d', label: '3D Brain' },
  { id: 'files', label: 'Files & OS' },
  { id: 'apps', label: 'Apps' },
  { id: 'devices', label: 'Devices' },
  { id: 'connect', label: 'Connections' },
  { id: 'routines', label: 'Routines' },
  { id: 'handoff', label: 'Handoff' },
];

export const TopBar: React.FC<TopBarProps> = ({
  activeTab,
  onSelectTab,
  onOpenPairModal,
  onEmergencyStop,
  showEmergencyStop = false,
  onFloat,
  floating = false,
}) => {
  return (
    <header className="h-14 shrink-0 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 sm:px-6 flex items-center justify-between gap-6">
      <button
        type="button"
        onClick={() => onSelectTab('dashboard')}
        className="font-display text-lg font-bold tracking-tight text-slate-900 dark:text-slate-100 whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-blue-600 rounded"
      >
        RAY
      </button>

      {/* Large screens use the sidebar for navigation; show where you are instead. */}
      <div className="hidden lg:flex items-center gap-2 mr-auto min-w-0 text-sm">
        <span className="text-slate-300 dark:text-slate-700">/</span>
        <span className="font-medium text-slate-700 dark:text-slate-200 truncate">{NAV_ITEMS.find((n) => n.id === activeTab)?.label}</span>
      </div>

      <nav className="hidden md:flex lg:hidden items-center gap-5 overflow-x-auto">
        {NAV_ITEMS.map((item) => {
          const active = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectTab(item.id)}
              className={`py-1.5 text-sm font-medium whitespace-nowrap shrink-0 border-b-2 transition-colors focus-visible:outline-2 focus-visible:outline-blue-600 ${
                active
                  ? 'border-blue-600 text-slate-900 dark:text-slate-100'
                  : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </nav>

      <div className="flex items-center gap-2 shrink-0">
        {showEmergencyStop && (
          <button
            type="button"
            onClick={onEmergencyStop}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-red-700 dark:text-red-300 border border-red-300 dark:border-red-800 hover:bg-red-50 dark:hover:bg-red-950/50 rounded-lg transition-colors whitespace-nowrap shrink-0"
            title="Emergency Stop: interrupt speech and cancel running tasks"
          >
            <OctagonX className="w-3.5 h-3.5" />
            <span>Stop All</span>
          </button>
        )}
        <PWAInstallButton compact />
        {onFloat && (
          <button
            type="button"
            onClick={onFloat}
            title="Float RAY on top of every app (Alt+O)"
            className={`hidden md:inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
              floating
                ? 'border-cyan-500/40 bg-cyan-50 dark:bg-cyan-950/40 text-cyan-700 dark:text-cyan-300'
                : 'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800'
            }`}
          >
            <PictureInPicture2 className="w-3.5 h-3.5" />
            {floating ? 'Floating' : 'Float'}
          </button>
        )}
        <button
          type="button"
          onClick={onOpenPairModal}
          className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
        >
          Pair Device
        </button>
      </div>
    </header>
  );
};
