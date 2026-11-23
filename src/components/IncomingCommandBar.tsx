import React, { useState } from 'react';
import { Bell, Check, Clipboard, ExternalLink, Timer, Volume2, X } from 'lucide-react';
import type { IncomingActionItem } from '../hooks/useRelaySocket';

interface IncomingCommandBarProps {
  actions: IncomingActionItem[];
  onDismiss: (id: string) => void;
}

export const IncomingCommandBar: React.FC<IncomingCommandBarProps> = ({
  actions,
  onDismiss,
}) => {
  const [copiedId, setCopiedId] = useState<string | null>(null);

  if (actions.length === 0) return null;

  const handleCopy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      window.setTimeout(() => setCopiedId(null), 1800);
    } catch {
      // Clipboard blocked
    }
  };

  return (
    <div className="fixed bottom-16 lg:bottom-5 right-4 z-40 w-[calc(100vw-2rem)] max-w-sm space-y-2 pointer-events-none">
      {actions.map((item) => (
        <div
          key={item.id}
          className="pointer-events-auto rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-3.5 shadow-lg flex items-start gap-3"
        >
          <div className="mt-0.5 text-blue-600 dark:text-blue-400 shrink-0">
            {item.type === 'speak' ? (
              <Volume2 className="w-4 h-4" />
            ) : item.type === 'clipboard' ? (
              <Clipboard className="w-4 h-4" />
            ) : item.type === 'open_url' ? (
              <ExternalLink className="w-4 h-4" />
            ) : item.type === 'set_timer' ? (
              <Timer className="w-4 h-4" />
            ) : (
              <Bell className="w-4 h-4" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">
              {item.title}
            </div>
            {item.message && (
              <p className="text-xs text-slate-600 dark:text-slate-300 mt-0.5 break-words">
                {item.message}
              </p>
            )}
            <div className="flex items-center gap-2 mt-2">
              {item.url && (
                <a
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
                >
                  <span>Open Link</span>
                  <ExternalLink className="w-3 h-3" />
                </a>
              )}
              {item.clipboardContent && (
                <button
                  type="button"
                  onClick={() => handleCopy(item.id, item.clipboardContent!)}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                >
                  {copiedId === item.id ? <Check className="w-3 h-3" /> : <Clipboard className="w-3 h-3" />}
                  <span>{copiedId === item.id ? 'Copied' : 'Copy'}</span>
                </button>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() => onDismiss(item.id)}
            aria-label="Dismiss notification"
            className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 p-0.5 rounded shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      ))}
    </div>
  );
};
