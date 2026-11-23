import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DeviceCommand,
  DeviceInfo,
  HandoffItem,
  HudSoundType,
  RoomSnapshot,
} from '../types/relay';
import {
  collectDeviceTelemetry,
  getOrCreateLocalDeviceIdentity,
  playChime,
  setLocalDeviceName,
} from '../utils/deviceIdentity';
import { playHudSound } from '../utils/hudAudio';
import { ensureRoomBootstrap, getStoredRoomToken } from '../utils/roomAuth';
import { forwardBridgeProxyActionToLocal } from '../services/localBridgeClient';

export type SocketStatus = 'connecting' | 'connected' | 'reconnecting';

export interface IncomingActionItem {
  id: string;
  commandId: string;
  type: DeviceCommand['type'];
  title: string;
  message: string;
  url?: string;
  clipboardContent?: string;
  reason?: string;
  createdAt: number;
}

export interface SnapshotReceivedEvent {
  commandId?: string;
  deviceId: string;
  deviceName: string;
  dataUrl: string;
  reason: string;
}

export function useRelaySocket(
  roomId: string,
  onSnapshotReceived?: (evt: SnapshotReceivedEvent) => void,
  localBridgeConnected = false
) {
  const [identity, setIdentity] = useState(() => getOrCreateLocalDeviceIdentity());
  const [status, setStatus] = useState<SocketStatus>('connecting');
  const [roomToken, setRoomToken] = useState<string>(() => getStoredRoomToken(roomId));
  const [roomAuthError, setRoomAuthError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<RoomSnapshot>({
    roomId,
    devices: [],
    commands: [],
    tasks: [],
    handoffs: [],
    timers: [],
    routines: [],
    brainNotes: [],
    connectors: [],
    veronicaMode: false,
    interrupted: false,
    screenControlArmed: false,
  });
  const [incomingActions, setIncomingActions] = useState<IncomingActionItem[]>([]);
  const [pendingSnapshotRequest, setPendingSnapshotRequest] = useState<{
    commandId: string;
    reason: string;
  } | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const snapshotCallbackRef = useRef(onSnapshotReceived);
  snapshotCallbackRef.current = onSnapshotReceived;
  const localBridgeRef = useRef(localBridgeConnected);
  localBridgeRef.current = localBridgeConnected;

  const sendEvent = useCallback((event: string, data: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ event, data }));
      return true;
    }
    return false;
  }, []);

  const dismissAction = useCallback((id: string) => {
    setIncomingActions((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const executeLocalCommand = useCallback(
    async (cmd: DeviceCommand, deviceId: string) => {
      const ack = (
        ackStatus: 'acknowledged' | 'completed' | 'failed',
        message: string,
        data?: Record<string, unknown>
      ) => {
        sendEvent('command:ack', {
          commandId: cmd.id,
          deviceId,
          status: ackStatus,
          message,
          data,
        });
      };

      const p = cmd.payload || {};

      switch (cmd.type) {
        case 'notify': {
          const title = String(p.title || 'RAY');
          const message = String(p.message || '');
          playHudSound('alert');

          if ('Notification' in window && Notification.permission === 'granted') {
            try {
              new Notification(title, { body: message });
            } catch {
              // Ignore browser notification failure in embedded iframe
            }
          }

          setIncomingActions((prev) => [
            {
              id: `${cmd.id}-notify`,
              commandId: cmd.id,
              type: 'notify',
              title,
              message,
              createdAt: Date.now(),
            },
            ...prev.slice(0, 4),
          ]);
          ack('completed', `Alert displayed on screen ("${title}")`);
          break;
        }

        case 'speak': {
          const text = String(p.text || '');
          const audioBase64 = typeof p.audioBase64 === 'string' ? p.audioBase64 : '';
          let played = false;

          if (audioBase64) {
            try {
              const audio = new Audio(`data:${typeof p.audioMime === 'string' ? p.audioMime : 'audio/wav'};base64,${audioBase64}`);
              await audio.play();
              played = true;
            } catch {
              played = false;
            }
          }

          if (!played && 'speechSynthesis' in window && text) {
            try {
              const utter = new SpeechSynthesisUtterance(text);
              window.speechSynthesis.speak(utter);
              played = true;
            } catch {
              played = false;
            }
          }

          setIncomingActions((prev) => [
            {
              id: `${cmd.id}-speak`,
              commandId: cmd.id,
              type: 'speak',
              title: played ? 'Spoken on this device' : 'Voice message received',
              message: text,
              createdAt: Date.now(),
            },
            ...prev.slice(0, 4),
          ]);
          ack('completed', played ? 'Played audio message on device speakers' : 'Delivered voice message to device');
          break;
        }

        case 'clipboard': {
          const label = String(p.label || 'Clipboard Handoff');
          const content = String(p.content || '');
          let copied = false;
          if (navigator.clipboard && window.isSecureContext) {
            try {
              await navigator.clipboard.writeText(content);
              copied = true;
            } catch {
              copied = false;
            }
          }
          setIncomingActions((prev) => [
            {
              id: `${cmd.id}-clip`,
              commandId: cmd.id,
              type: 'clipboard',
              title: copied ? `Copied: ${label}` : `Received: ${label}`,
              message: content.slice(0, 140),
              clipboardContent: content,
              createdAt: Date.now(),
            },
            ...prev.slice(0, 4),
          ]);
          ack('completed', copied ? 'Written directly to device clipboard' : 'Delivered to device handoff tray (tap Copy)');
          break;
        }

        case 'open_url': {
          const url = String(p.url || '');
          const title = String(p.title || url);
          playHudSound('affirmative');

          // 1) This PC runs the Desktop Bridge -> open it for real in the OS default browser.
          if (localBridgeRef.current) {
            const out = await forwardBridgeProxyActionToLocal(roomId, { action: 'open_url', url });
            if (out.ok) {
              ack('completed', `Opened ${title} in a new browser tab on this computer`);
              break;
            }
          }

          // 2) Try opening directly. Works when pop-ups are allowed for RAY
          //    (one-time: browser address bar -> "Always allow pop-ups") or the
          //    user interacted with RAY a moment ago.
          let opened = false;
          try {
            const win = window.open(url, '_blank', 'noopener');
            opened = Boolean(win) || document.visibilityState === 'hidden';
          } catch {
            opened = false;
          }
          if (opened) {
            ack('completed', `Opened ${title} in a new tab`);
            break;
          }

          // 3) Fallback: one-tap launch card.
          setIncomingActions((prev) => [
            {
              id: `${cmd.id}-url`,
              commandId: cmd.id,
              type: 'open_url',
              title: `Tap to open: ${title}`,
              message: url,
              url,
              createdAt: Date.now(),
            },
            ...prev.slice(0, 4),
          ]);
          ack(
            'acknowledged',
            `Pop-ups are blocked on this browser, so a one-tap launch card was shown for ${url}. Allow pop-ups for RAY (or run the Desktop/Android bridge) to open tabs automatically.`
          );
          break;
        }

        case 'set_timer': {
          const label = String(p.label || 'Timer');
          const duration = Number(p.durationSeconds || 60);
          playHudSound('blip');
          setIncomingActions((prev) => [
            {
              id: `${cmd.id}-timer`,
              commandId: cmd.id,
              type: 'set_timer',
              title: `Timer Started: ${label}`,
              message: `${duration}s countdown synchronized`,
              createdAt: Date.now(),
            },
            ...prev.slice(0, 4),
          ]);
          ack('completed', `Started ${duration}s timer "${label}"`);
          break;
        }

        case 'request_snapshot': {
          const reason = String(p.reason || 'Visual check requested');
          playChime('alert');
          setPendingSnapshotRequest({ commandId: cmd.id, reason });
          ack('acknowledged', 'Snapshot capture modal opened on device');
          break;
        }

        case 'refresh_telemetry': {
          const telemetry = await collectDeviceTelemetry(false);
          sendEvent('device:telemetry', { id: deviceId, telemetry });
          ack('completed', 'Live telemetry updated', telemetry as Record<string, unknown>);
          break;
        }

        case 'bridge_command': {
          if (!localBridgeRef.current) {
            ack('failed', 'Local Desktop Bridge (127.0.0.1:17345) is not active on this browser.');
            break;
          }
          const out = await forwardBridgeProxyActionToLocal(roomId, p);
          ack(
            out.ok ? 'completed' : 'failed',
            out.ok
              ? typeof out.data === 'string'
                ? out.data
                : JSON.stringify(out.data || 'Bridge command completed')
              : out.error || 'Local bridge execution failed',
            out.data && typeof out.data === 'object' ? (out.data as Record<string, unknown>) : undefined
          );
          break;
        }

        case 'wake': {
          playHudSound('wake');
          ack('completed', 'Device is awake and connected');
          break;
        }

        default:
          ack('acknowledged', `Received ${cmd.type}`);
      }
    },
    [roomId, sendEvent]
  );

  const [bootstrapTick, setBootstrapTick] = useState(0);

  const applyManualRoomToken = useCallback(
    async (manualToken: string) => {
      const boot = await ensureRoomBootstrap(roomId, manualToken);
      if (boot.authorized && boot.roomToken) {
        setRoomToken(boot.roomToken);
        setRoomAuthError(null);
        setBootstrapTick((t) => t + 1);
        return true;
      }
      setRoomAuthError(boot.error || 'Invalid room token.');
      return false;
    },
    [roomId]
  );

  useEffect(() => {
    let active = true;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';

    const connect = async () => {
      if (!active) return;
      setStatus((prev) => (prev === 'connected' ? 'reconnecting' : 'connecting'));

      const boot = await ensureRoomBootstrap(roomId);
      if (!active) return;
      if (!boot.authorized || !boot.roomToken) {
        setRoomAuthError(boot.error || 'Room token required.');
        setStatus('reconnecting');
        reconnectTimerRef.current = window.setTimeout(() => void connect(), 3500);
        return;
      }

      setRoomToken(boot.roomToken);
      setRoomAuthError(null);
      const wsUrl = `${protocol}//${window.location.host}/ws?room=${encodeURIComponent(
        roomId
      )}&token=${encodeURIComponent(boot.roomToken)}`;

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = async () => {
        if (!active) return;
        attempt = 0;
        setStatus('connected');
        const telemetry = await collectDeviceTelemetry(false);
        const caps = ['notify', 'clipboard', 'speak', 'timers', 'camera'];
        if ('geolocation' in navigator) caps.push('geolocation');
        if (localBridgeRef.current) {
          caps.push(
            'os-bridge',
            'fs-sandbox',
            'screen-control',
            'ollama-proxy',
            'obsidian-vault',
            'open_application',
            'close_application'
          );
        }
        ws.send(
          JSON.stringify({
            event: 'device:register',
            data: {
              ...identity,
              capabilities: caps,
              telemetry,
            },
          })
        );
      };

      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data as string) as { event: string; data: unknown };
          switch (msg.event) {
            case 'state:sync': {
              setSnapshot(msg.data as RoomSnapshot);
              break;
            }
            case 'device:updated': {
              const updated = msg.data as DeviceInfo;
              setSnapshot((prev) => ({
                ...prev,
                devices: prev.devices.map((d) => (d.id === updated.id ? updated : d)),
              }));
              break;
            }
            case 'command:dispatched': {
              const cmd = msg.data as DeviceCommand;
              setSnapshot((prev) => ({
                ...prev,
                commands: [cmd, ...prev.commands.filter((c) => c.id !== cmd.id)].slice(0, 50),
              }));
              break;
            }
            case 'command:updated': {
              const cmd = msg.data as DeviceCommand;
              setSnapshot((prev) => ({
                ...prev,
                commands: prev.commands.map((c) => (c.id === cmd.id ? cmd : c)),
              }));
              break;
            }
            case 'command:execute': {
              const cmd = msg.data as DeviceCommand;
              void executeLocalCommand(cmd, identity.id);
              break;
            }
            case 'bridge:proxy_request': {
              const reqData = (msg.data || {}) as Record<string, unknown>;
              const requestId = String(reqData.requestId || '');
              void forwardBridgeProxyActionToLocal(roomId, reqData).then((out) => {
                if (ws.readyState === WebSocket.OPEN && requestId) {
                  ws.send(
                    JSON.stringify({
                      event: 'bridge:proxy_response',
                      data: { requestId, ok: out.ok, data: out.data, error: out.error },
                    })
                  );
                }
              });
              break;
            }
            case 'messages:new': {
              // Incoming WhatsApp / Instagram / SMS relayed from the phone or Meta APIs.
              const m = msg.data as { id: string; app: string; from: string; text: string };
              playHudSound('alert');
              if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
                try {
                  new Notification(`${m.app[0]?.toUpperCase()}${m.app.slice(1)} · ${m.from}`, { body: m.text.slice(0, 180), tag: `ray-msg-${m.id}` });
                } catch {
                  // ignore
                }
              }
              setIncomingActions((prev) => [
                {
                  id: `msg-${m.id}`,
                  commandId: m.id,
                  type: 'notify',
                  title: `${m.app[0]?.toUpperCase()}${m.app.slice(1)} · ${m.from}`,
                  message: m.text.slice(0, 200),
                  createdAt: Date.now(),
                },
                ...prev.slice(0, 4),
              ]);
              break;
            }
            case 'hud:sound': {
              const payload = msg.data as { sound?: HudSoundType };
              if (payload.sound) {
                playHudSound(payload.sound);
              }
              break;
            }
            case 'jarvis:interrupted': {
              if ('speechSynthesis' in window) {
                window.speechSynthesis.cancel();
              }
              break;
            }
            case 'snapshot:received': {
              if (snapshotCallbackRef.current) {
                snapshotCallbackRef.current(msg.data as SnapshotReceivedEvent);
              }
              break;
            }
          }
        } catch {
          // Ignore invalid JSON
        }
      };

      ws.onclose = () => {
        if (!active) return;
        setStatus('reconnecting');
        attempt += 1;
        const delay = Math.min(15000, 800 * 2 ** Math.min(attempt, 5)) + Math.random() * 400;
        reconnectTimerRef.current = window.setTimeout(connect, delay);
      };
    };

    let attempt = 0;
    connect();

    // Reconnect immediately when the device wakes up / regains network / tab becomes visible.
    const reconnectNow = () => {
      const ws = wsRef.current;
      if (!active || (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING))) return;
      if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
      attempt = 0;
      void connect();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') reconnectNow();
    };
    window.addEventListener('online', reconnectNow);
    document.addEventListener('visibilitychange', onVisible);
    const swHandler = (evt: MessageEvent) => {
      if (evt.data?.type === 'ray:wake') reconnectNow();
    };
    if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', swHandler);

    const telemetryInterval = window.setInterval(async () => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        const telemetry = await collectDeviceTelemetry(false);
        wsRef.current.send(
          JSON.stringify({
            event: 'device:telemetry',
            data: { id: identity.id, telemetry },
          })
        );
      }
    }, 20000);

    return () => {
      active = false;
      window.removeEventListener('online', reconnectNow);
      document.removeEventListener('visibilitychange', onVisible);
      if ('serviceWorker' in navigator) navigator.serviceWorker.removeEventListener('message', swHandler);
      window.clearInterval(telemetryInterval);
      if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
    };
  }, [roomId, identity, executeLocalCommand, bootstrapTick]);

  // Dynamically advertise or retract os-bridge capabilities when local bridge 17345 comes online/offline
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const caps = ['notify', 'clipboard', 'speak', 'timers', 'camera'];
    if ('geolocation' in navigator) caps.push('geolocation');
    if (localBridgeConnected) {
      caps.push(
        'os-bridge',
        'fs-sandbox',
        'screen-control',
        'ollama-proxy',
        'obsidian-vault',
        'open_application',
        'close_application'
      );
    }
    ws.send(
      JSON.stringify({
        event: 'device:register',
        data: {
          ...identity,
          capabilities: caps,
        },
      })
    );
  }, [localBridgeConnected, identity]);

  const completedTimersRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (snapshot.timers.length === 0) return;
    const interval = window.setInterval(() => {
      const now = Date.now();
      for (const t of snapshot.timers) {
        if (t.endsAt <= now && !completedTimersRef.current.has(t.id)) {
          const targetsMe =
            t.targetDevice === 'all' ||
            t.targetDevice === identity.id ||
            identity.name.toLowerCase().includes(t.targetDevice.toLowerCase());
          if (targetsMe) {
            completedTimersRef.current.add(t.id);
            playChime('timer');
            setIncomingActions((prev) => [
              {
                id: `${t.id}-done`,
                commandId: t.id,
                type: 'set_timer',
                title: `Timer Finished: ${t.label}`,
                message: 'Your synchronized countdown is complete.',
                createdAt: now,
              },
              ...prev.slice(0, 4),
            ]);
          }
        }
      }
    }, 1000);
    return () => window.clearInterval(interval);
  }, [snapshot.timers, identity.id, identity.name]);

  const renameDevice = useCallback(
    (deviceId: string, name: string) => {
      if (deviceId === identity.id) {
        setLocalDeviceName(name);
        setIdentity((prev) => ({ ...prev, name }));
      }
      sendEvent('device:rename', { id: deviceId, name });
    },
    [identity.id, sendEvent]
  );

  const removeDevice = useCallback(
    (deviceId: string) => {
      sendEvent('device:remove', { id: deviceId });
    },
    [sendEvent]
  );

  const shareLocationTelemetry = useCallback(async () => {
    const telemetry = await collectDeviceTelemetry(true);
    sendEvent('device:telemetry', { id: identity.id, telemetry });
    return telemetry;
  }, [identity.id, sendEvent]);

  const createTask = useCallback(
    (title: string, assignedDevice = 'All Devices') => {
      sendEvent('task:create', { title, assignedDevice });
    },
    [sendEvent]
  );

  const toggleTask = useCallback(
    (id: string) => {
      sendEvent('task:toggle', { id });
    },
    [sendEvent]
  );

  const deleteTask = useCallback(
    (id: string) => {
      sendEvent('task:delete', { id });
    },
    [sendEvent]
  );

  const pushHandoff = useCallback(
    (params: { label: string; content: string; kind: HandoffItem['kind']; targetDevice: string }) => {
      sendEvent('handoff:push', {
        ...params,
        sourceDevice: identity.name,
      });
    },
    [identity.name, sendEvent]
  );

  const deleteHandoff = useCallback(
    (id: string) => {
      sendEvent('handoff:delete', { id });
    },
    [sendEvent]
  );

  const createTimer = useCallback(
    (label: string, durationSeconds: number, targetDevice = 'all') => {
      sendEvent('timer:create', { label, durationSeconds, targetDevice });
    },
    [sendEvent]
  );

  const cancelTimer = useCallback(
    (id: string) => {
      sendEvent('timer:cancel', { id });
    },
    [sendEvent]
  );

  const deleteRoutine = useCallback(
    (id: string) => {
      sendEvent('routine:delete', { id });
    },
    [sendEvent]
  );

  const submitSnapshot = useCallback(
    (dataUrl: string, commandId?: string, reason?: string) => {
      sendEvent('snapshot:submit', { dataUrl, commandId, reason });
      if (commandId) {
        sendEvent('command:ack', {
          commandId,
          deviceId: identity.id,
          status: 'completed',
          message: 'Snapshot captured and sent to workspace',
        });
      }
      setPendingSnapshotRequest(null);
    },
    [identity.id, sendEvent]
  );

  return {
    identity,
    status,
    roomToken,
    roomAuthError,
    applyManualRoomToken,
    snapshot,
    incomingActions,
    dismissAction,
    pendingSnapshotRequest,
    clearSnapshotRequest: () => setPendingSnapshotRequest(null),
    submitSnapshot,
    renameDevice,
    removeDevice,
    shareLocationTelemetry,
    createTask,
    toggleTask,
    deleteTask,
    pushHandoff,
    deleteHandoff,
    createTimer,
    cancelTimer,
    deleteRoutine,
  };
}
