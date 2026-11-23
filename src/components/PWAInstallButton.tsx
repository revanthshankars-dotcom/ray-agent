import React, { useState } from 'react';
import { CheckCircle2, Download, Share, X } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';

interface PWAInstallButtonProps {
  compact?: boolean;
}

export const PWAInstallButton: React.FC<PWAInstallButtonProps> = ({ compact = false }) => {
  const { canInstall, isInstalled, isIOS, promptInstall } = usePWAInstall();
  const [showIosTip, setShowIosTip] = useState(false);

  if (isInstalled) {
    if (compact) return null;
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800/60 bg-emerald-50 dark:bg-emerald-950/30 rounded-lg">
        <CheckCircle2 className="w-3.5 h-3.5" />
        <span>App Installed</span>
      </span>
    );
  }

  if (canInstall) {
    return (
      <button
        type="button"
        onClick={() => void promptInstall()}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-900 dark:text-slate-100 border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 hover:border-blue-600 rounded-lg transition-colors whitespace-nowrap shrink-0"
        title="Install RAY on this phone or computer as a standalone app"
      >
        <Download className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
        <span>{compact ? 'Install' : 'Install RAY App'}</span>
      </button>
    );
  }

  if (isIOS && !compact) {
    return (
      <div className="relative">
        <button
          type="button"
          onClick={() => setShowIosTip((v) => !v)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 rounded-lg hover:border-blue-600"
        >
          <Share className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
          <span>Add to iPhone Home</span>
        </button>
        {showIosTip && (
          <div className="mt-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-3 text-xs text-slate-600 dark:text-slate-300 flex items-start justify-between gap-2">
            <span>
              In Safari, tap the <strong>Share</strong> icon and choose <strong>Add to Home Screen</strong> to run RAY fullscreen on iOS.
            </span>
            <button
              type="button"
              onClick={() => setShowIosTip(false)}
              className="text-slate-400 hover:text-slate-700"
              aria-label="Close iOS install tip"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>
    );
  }

  return null;
};
