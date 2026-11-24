import { useState } from 'react';
import { Mic, MonitorSmartphone } from 'lucide-react';
import type { DeviceInfo } from '../types/relay';
import { authFetch } from '../utils/roomAuth';

/**
 * Shared mic: choose where voice commands spoken HERE are carried out ("Runs on"), or ask another
 * device to listen for you and carry the commands out here ("Use mic on").
 */
export function VoiceRouting({
  roomId,
  devices,
  myDeviceId,
  myName,
  runOn,
  onRunOnChange,
}: {
  roomId: string;
  devices: DeviceInfo[];
  myDeviceId: string;
  myName: string;
  runOn: string;
  onRunOnChange: (v: string) => void;
}) {
  const [msg, setMsg] = useState('');
  const others = devices.filter((d) => d.online && d.id !== myDeviceId && !d.capabilities?.includes('browser-tabs'));
  const targets = devices.filter((d) => d.online && d.id !== myDeviceId);
  const remoteMic = async (micId: string) => {
    if (!micId) return;
    setMsg('Asking…');
    try {
      const r = await authFetch('/api/voice/remote-mic', roomId, { method: 'POST', body: JSON.stringify({ roomId, micDevice: micId, runOn: myName }) });
      const j = (await r.json()) as { summary?: string; error?: string };
      setMsg(j.error || j.summary || 'Listening there');
    } catch {
      setMsg('Could not reach that device');
    }
    window.setTimeout(() => setMsg(''), 6000);
  };
  const sel =
    'max-w-[9.5rem] truncate rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent px-1.5 py-1 text-[11px] text-slate-700 dark:text-slate-200';
  return (
    <div className="inline-flex items-center gap-1.5 shrink-0" title="Shared mic: speak on one device, act on another">
      <MonitorSmartphone className="w-3.5 h-3.5 text-slate-500" />
      <label className="sr-only" htmlFor="ray-runon">
        Voice commands run on
      </label>
      <select id="ray-runon" className={sel} value={runOn} onChange={(e) => onRunOnChange(e.target.value)}>
        <option value="">Runs on: auto</option>
        <option value={myName}>Runs on: this device</option>
        {targets.map((d) => (
          <option key={d.id} value={d.name}>
            Runs on: {d.name}
          </option>
        ))}
      </select>
      {others.length > 0 && (
        <>
          <Mic className="w-3.5 h-3.5 text-slate-500" />
          <label className="sr-only" htmlFor="ray-remote-mic">
            Use the microphone of another device
          </label>
          <select id="ray-remote-mic" className={sel} value="" onChange={(e) => void remoteMic(e.target.value)}>
            <option value="">Use mic on…</option>
            {others.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </>
      )}
      {msg && <span className="text-[11px] text-slate-500 truncate max-w-[12rem]">{msg}</span>}
    </div>
  );
}
