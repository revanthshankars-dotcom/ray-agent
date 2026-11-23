import React from 'react';
import { WifiOff } from 'lucide-react';
import { useOnlineStatus } from '../hooks/useOnlineStatus';

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();
  if (isOnline) return null;

  return (
    <div
      role="status"
      className="bg-amber-600 text-white text-xs font-medium px-4 py-1.5 flex items-center justify-center gap-2 shrink-0"
    >
      <WifiOff className="w-3.5 h-3.5 shrink-0" />
      <span>Offline mode — cached workspace ready; live device relay resumes when connected.</span>
    </div>
  );
};
