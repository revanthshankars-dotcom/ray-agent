import { useCallback, useEffect, useState } from 'react';
import {
  fetchLocalOllamaTags,
  probeLocalDirectBridgeDetailed,
} from '../services/localBridgeClient';
import type { LocalBridgeHealth } from '../services/localBridgeClient';

export interface LocalBridgeMonitorState {
  status: 'connected' | 'token_mismatch' | 'offline';
  health: LocalBridgeHealth | null;
  ollamaRunning: boolean;
  ollamaModels: string[];
  startupInstalled: boolean;
  error: string | null;
  lastCheckedAt: number | null;
  refreshNow: () => Promise<void>;
}

export function useLocalBridgeMonitor(
  roomId: string,
  ollamaUrl = 'http://127.0.0.1:11434',
  roomToken?: string
): LocalBridgeMonitorState {
  const [status, setStatus] = useState<'connected' | 'token_mismatch' | 'offline'>('offline');
  const [health, setHealth] = useState<LocalBridgeHealth | null>(null);
  const [ollamaRunning, setOllamaRunning] = useState(false);
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [startupInstalled, setStartupInstalled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);

  const refreshNow = useCallback(async () => {
    const probe = await probeLocalDirectBridgeDetailed(roomId);
    setStatus(probe.status);
    setHealth(probe.health || null);
    setStartupInstalled(Boolean(probe.startupInstalled));
    setError(probe.error || null);
    setLastCheckedAt(Date.now());

    if (probe.status === 'connected') {
      const modelsFromHealth = Array.isArray(probe.ollamaModels) ? probe.ollamaModels : [];
      if (probe.ollamaRunning && modelsFromHealth.length > 0) {
        setOllamaRunning(true);
        setOllamaModels(modelsFromHealth);
      } else {
        const tagRes = await fetchLocalOllamaTags(roomId, ollamaUrl);
        if (tagRes.ok) {
          setOllamaRunning(true);
          setOllamaModels(tagRes.models);
        } else {
          setOllamaRunning(Boolean(probe.ollamaRunning));
          setOllamaModels(modelsFromHealth);
        }
      }
      return;
    }

    if (probe.status === 'token_mismatch') {
      setOllamaRunning(Boolean(probe.ollamaRunning));
      setOllamaModels(Array.isArray(probe.ollamaModels) ? probe.ollamaModels : []);
      return;
    }

    // Even if Local Bridge 17345 is offline, try direct loopback Ollama check (localhost users)
    try {
      const safeOrigin = ollamaUrl.replace('://localhost', '://127.0.0.1').replace(/\/+$/, '');
      const resp = await fetch(`${safeOrigin}/api/tags`, { signal: AbortSignal.timeout(1200) });
      if (resp.ok) {
        const data = (await resp.json()) as { models?: Array<{ name?: string }> };
        const models = (data.models || []).map((m) => m.name || '').filter(Boolean);
        setOllamaRunning(true);
        setOllamaModels(models);
        return;
      }
    } catch {
      // Ignore direct loopback failure
    }
    setOllamaRunning(false);
    setOllamaModels([]);
  }, [ollamaUrl, roomId, roomToken]);

  // Offline: back off 5s → 10s → 20s … up to 60s instead of hammering a refused port (#11).
  const [offlineStreak, setOfflineStreak] = useState(0);
  useEffect(() => {
    setOfflineStreak((n) => (status === 'offline' ? n + 1 : 0));
  }, [status, lastCheckedAt]);

  useEffect(() => {
    void refreshNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, ollamaUrl, roomToken]);

  useEffect(() => {
    const intervalMs = status === 'connected' ? 12000 : Math.min(60000, 5000 * 2 ** Math.min(4, Math.max(0, offlineStreak - 1)));
    const id = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void refreshNow();
    }, intervalMs);

    const onFocus = () => void refreshNow();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('focus', onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshNow, status, Math.min(5, offlineStreak)]);

  return {
    status,
    health,
    ollamaRunning,
    ollamaModels,
    startupInstalled,
    error,
    lastCheckedAt,
    refreshNow,
  };
}
