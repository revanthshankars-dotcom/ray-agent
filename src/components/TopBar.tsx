import React from 'react';
import { OctagonX } from 'lucide-react';
import { PWAInstallButton } from './PWAInstallButton';

export type ActiveTab = 'dashboard' | 'assistant' | 'brain' | 'files' | 'apps' | 'devices' | 'routines' | 'handoff';

interface TopBarProps {
  activeTab: ActiveTab;
  onSelectTab: (tab: ActiveTab) => void;
  onOpenPairModal: () => void;
  onEmergencyStop: () => void;
  showEmergencyStop?: boolean;
}

const NAV_ITEMS: Array<{ id: ActiveTab; label: string }> = [
  { id: 'dashboard', label: 'Home' },
  { id: 'assistant', label: 'Assistant' },
  { id: 'brain', label: 'Brain' },
  { id: 'files', label: 'Files & OS' },
  { id: 'apps', label: 'Apps' },
  { id: 'devices', label: 'Devices' },
  { id: 'routines', label: 'Routines' },
  { id: 'handoff', label: 'Handoff' },
];

export const TopBar: React.FC<TopBarProps> = ({
  activeTab,
  onSelectTab,
  onOpenPairModal,
  onEmergencyStop,
  showEmergencyStop = false,
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

      <nav className="hidden md:flex items-center gap-5">
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
