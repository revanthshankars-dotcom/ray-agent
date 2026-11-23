import { useCallback, useState } from 'react';
import { Check, Loader2, Smartphone, Sparkles, X, Zap } from 'lucide-react';
import { getStoredRoomToken } from '../utils/roomAuth';

type StepState = 'pending' | 'running' | 'done' | 'skipped' | 'failed';
interface Step {
  id: string;
  label: string;
  state: StepState;
  note?: string;
}

function detectPlatform(): 'android' | 'ios' | 'win' | 'mac' | 'linux' {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Windows/i.test(ua)) return 'win';
  if (/Mac OS X/i.test(ua)) return 'mac';
  return 'linux';
}

/**
 * One tap to connect everything this device can do with RAY.
 * Browsers only let users grant mic/notification access themselves, so each permission
 * pops up once — RAY does every other step automatically.
 */
export function ConnectThisDevice({
  roomId,
  bridgeConnected,
  onEnablePush,
  onEnableWake,
  canInstallApp,
  onInstallApp,
  isInstalled,
  compact = false,
}: {
  roomId: string;
  bridgeConnected: boolean;
  onEnablePush: () => Promise<boolean>;
  onEnableWake: () => void;
  canInstallApp: boolean;
  onInstallApp: () => Promise<boolean>;
  isInstalled: boolean;
  compact?: boolean;
}) {
  const platform = detectPlatform();
  const mobile = platform === 'android' || platform === 'ios';
  const [open, setOpen] = useState(() => new URLSearchParams(window.location.search).has('connect'));
  const [steps, setSteps] = useState<Step[]>([]);
  const [running, setRunning] = useState(false);

  const update = (id: string, patch: Partial<Step>) => setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));

  const run = useCallback(async () => {
    const plan: Step[] = [
      { id: 'mic', label: 'Microphone for voice & calls', state: 'pending' },
      { id: 'push', label: 'Wake-ups, calls & message alerts', state: 'pending' },
      { id: 'wake', label: '“Hey Ray” listening', state: 'pending' },
      { id: 'app', label: mobile ? 'Install RAY on the home screen' : 'Install RAY as an app', state: 'pending' },
    ];
    if (!mobile) plan.push({ id: 'bridge', label: 'PC bridge (apps, tabs, files, screen)', state: 'pending' });
    setSteps(plan);
    setOpen(true);
    setRunning(true);

    // 1) Microphone
    update('mic', { state: 'running' });
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      update('mic', { state: 'done' });
    } catch {
      update('mic', { state: 'failed', note: 'Allow the microphone in the browser’s site settings.' });
    }

    // 2) Notifications + Web Push (wake / calls / messages)
    update('push', { state: 'running' });
    const pushed = await onEnablePush().catch(() => false);
    update('push', pushed ? { state: 'done' } : { state: 'failed', note: platform === 'ios' ? 'On iPhone, add RAY to the Home Screen first, then tap Connect again.' : 'Allow notifications for this site.' });

    // 3) Wake word
    onEnableWake();
    update('wake', { state: 'done', note: mobile ? 'Works while RAY is open on screen.' : undefined });

    // 4) Install as app
    if (isInstalled) update('app', { state: 'done', note: 'Already installed' });
    else if (canInstallApp) {
      update('app', { state: 'running' });
      const ok = await onInstallApp().catch(() => false);
      update('app', ok ? { state: 'done' } : { state: 'skipped', note: 'You can install it later from the browser menu.' });
    } else {
      update('app', {
        state: 'skipped',
        note: platform === 'ios' ? 'Tap Share → “Add to Home Screen”.' : 'Browser menu ⋮ → “Install app” / “Add to Home screen”.',
      });
    }

    // 5) PC bridge: one double-click installer
    if (!mobile) {
      if (bridgeConnected) update('bridge', { state: 'done', note: 'Already running' });
      else {
        const token = getStoredRoomToken(roomId);
        const os = platform === 'win' ? 'win' : platform === 'mac' ? 'mac' : 'linux';
        const a = document.createElement('a');
        a.href = `/api/bridge-installer?room=${encodeURIComponent(roomId)}&token=${encodeURIComponent(token)}&os=${os}`;
        a.download = '';
        document.body.appendChild(a);
        a.click();
        a.remove();
        update('bridge', {
          state: 'done',
          note:
            os === 'win'
              ? 'Downloaded “ray-connect.cmd” — double-click it once (choose “Run anyway” if Windows asks).'
              : os === 'mac'
              ? 'Downloaded “ray-connect.command” — right-click → Open the first time.'
              : 'Downloaded “ray-connect.sh” — run: bash ~/Downloads/ray-connect.sh',
        });
      }
    }
    setRunning(false);
  }, [bridgeConnected, canInstallApp, isInstalled, mobile, onEnablePush, onEnableWake, onInstallApp, platform, roomId]);

  return (
    <>
      <button
        type="button"
        onClick={() => void run()}
        className={`inline-flex items-center justify-center gap-2 rounded-xl font-semibold text-white bg-gradient-to-r from-emerald-500 to-cyan-500 hover:opacity-95 shadow-lg shadow-emerald-500/20 ${
          compact ? 'h-9 px-3 text-xs' : 'h-11 px-5 text-sm'
        }`}
      >
        <Zap className="w-4 h-4" /> Connect this device
      </button>

      {open && (
        <div className="fixed inset-0 z-[90] bg-slate-950/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-3" onClick={() => !running && setOpen(false)}>
          <div className="w-full max-w-md rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start gap-3">
              <span className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-cyan-500 flex items-center justify-center text-white">
                {mobile ? <Smartphone className="w-5 h-5" /> : <Sparkles className="w-5 h-5" />}
              </span>
              <div className="flex-1">
                <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">Connect this {mobile ? 'phone' : 'computer'} to RAY</h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">Tap “Allow” on each pop-up — RAY does the rest.</p>
              </div>
              {!running && (
                <button type="button" aria-label="Close" onClick={() => setOpen(false)} className="p-1 text-slate-400">
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>

            {steps.length === 0 ? (
              <button type="button" onClick={() => void run()} className="mt-5 w-full h-12 rounded-xl font-semibold text-white bg-gradient-to-r from-emerald-500 to-cyan-500">
                Connect everything
              </button>
            ) : (
              <ul className="mt-4 space-y-2.5">
                {steps.map((s) => (
                  <li key={s.id} className="flex items-start gap-2.5">
                    <span
                      className={`mt-0.5 w-5 h-5 rounded-full flex items-center justify-center shrink-0 ${
                        s.state === 'done' ? 'bg-emerald-500 text-white' : s.state === 'failed' ? 'bg-amber-500 text-white' : 'bg-slate-200 dark:bg-slate-700'
                      }`}
                    >
                      {s.state === 'running' ? <Loader2 className="w-3 h-3 animate-spin" /> : s.state === 'done' ? <Check className="w-3 h-3" /> : s.state === 'failed' ? '!' : ''}
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm text-slate-900 dark:text-slate-100">{s.label}</p>
                      {s.note && <p className="text-[11px] text-slate-500 dark:text-slate-400">{s.note}</p>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {!running && steps.length > 0 && (
              <button type="button" onClick={() => setOpen(false)} className="mt-5 w-full h-10 rounded-xl border border-slate-200 dark:border-slate-700 text-sm font-medium text-slate-700 dark:text-slate-200">
                Done
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
