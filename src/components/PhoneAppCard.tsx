import { useEffect, useState } from 'react';
import { getStoredRoomToken } from '../utils/roomAuth';

/** The native RAY Android app (replaces Termux): download, then pair with one tap or a QR code. */
export function PhoneAppCard({ roomId, phoneOnline }: { roomId: string; phoneOnline?: string }) {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const token = getStoredRoomToken(roomId);
  const pairLink = `ray://pair?hub=${encodeURIComponent(origin)}&room=${encodeURIComponent(roomId)}&token=${encodeURIComponent(token)}`;
  const [qr, setQr] = useState('');
  const [copied, setCopied] = useState(false);
  const isAndroid = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);

  useEffect(() => {
    void import('qrcode').then((m) => m.default.toDataURL(pairLink, { width: 220, margin: 1 })).then(setQr).catch(() => setQr(''));
  }, [pairLink]);

  return (
    <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">RAY phone app (Android) — no Termux needed</h4>
        {phoneOnline && <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-emerald-500/12 text-emerald-700 dark:text-emerald-300">{phoneOnline} online</span>}
      </div>
      <p className="mt-1 text-[12px] text-slate-600 dark:text-slate-300">
        Runs in the background on your phone: RAY can open apps and links, call and find contacts, read chat notifications, speak, set timers and ask you questions over any app — and answer questions about photos on the phone with SmolVLM2, offline. Android 8+ (SmolVLM2 needs Android 12+).
      </p>
      <div className="mt-3 grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-4 items-start">
        <ol className="text-[12px] text-slate-700 dark:text-slate-200 list-decimal pl-4 space-y-1.5">
          <li>
            On the phone, download and open{' '}
            <a className="font-semibold text-blue-600 dark:text-blue-400 underline" href="/api/android/ray.apk" download>
              ray-phone.apk
            </a>{' '}
            (12 MB). Android asks once to allow installs from your browser — allow it, then tap Install.
          </li>
          <li>
            Pair: {isAndroid ? 'tap ' : 'on the phone open this page and tap '}
            <a className="font-semibold text-blue-600 dark:text-blue-400 underline" href={pairLink}>
              Open in RAY app
            </a>
            , or scan the code with the phone's camera.{' '}
            <button
              type="button"
              className="text-blue-600 dark:text-blue-400 underline"
              onClick={() => {
                void navigator.clipboard.writeText(pairLink);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
            >
              {copied ? 'Copied' : 'Copy link'}
            </button>
          </li>
          <li>In the app, allow the items in “Let RAY help on this phone” (Xiaomi/Redmi: also Settings → Apps → RAY → Autostart on).</li>
          <li>Optional: tap “Download SmolVLM2” on Wi-Fi (363 MB) for offline photo questions.</li>
        </ol>
        {qr && <img src={qr} alt="QR code to pair the RAY phone app" className="w-[150px] h-[150px] rounded-xl border border-slate-200 dark:border-slate-700 bg-white" />}
      </div>
      <p className="mt-2 text-[10px] text-slate-500">The link contains your room token — only open it on your own phone. Already using Termux? The app replaces it; you can uninstall Termux after pairing.</p>
    </div>
  );
}
