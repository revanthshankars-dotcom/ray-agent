import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Check, Copy, Download, KeyRound, RefreshCw, ShieldAlert, Smartphone, Terminal, X } from 'lucide-react';
import { PWAInstallButton } from './PWAInstallButton';

interface PairDeviceModalProps {
  open: boolean;
  roomId: string;
  roomToken: string;
  roomAuthError?: string | null;
  bridgeStatus?: 'connected' | 'token_mismatch' | 'offline';
  bridgeStartupInstalled?: boolean;
  ollamaRunning?: boolean;
  onApplyRoomToken?: (token: string) => Promise<boolean>;
  onClose: () => void;
  onChangeRoom: (newRoomId: string) => void;
}

export const PairDeviceModal: React.FC<PairDeviceModalProps> = ({
  open,
  roomId,
  roomToken,
  roomAuthError,
  bridgeStatus = 'offline',
  bridgeStartupInstalled = false,
  ollamaRunning = false,
  onApplyRoomToken,
  onClose,
  onChangeRoom,
}) => {
  const [tab, setTab] = useState<'mobile' | 'bridge'>('mobile');
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [roomInput, setRoomInput] = useState(roomId);
  const [tokenInput, setTokenInput] = useState('');
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedToken, setCopiedToken] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);
  const [downloadingBridge, setDownloadingBridge] = useState(false);
  const [bridgeMsg, setBridgeMsg] = useState<string | null>(null);

  const bridgeFilename = `relay-bridge-${roomId.toLowerCase()}.mjs`;
  const bridgeUrl = `/api/bridge-script?room=${encodeURIComponent(roomId)}&token=${encodeURIComponent(
    roomToken
  )}`;
  const winStartupCmd = `npm install ws; node ".\\Downloads\\${bridgeFilename}" --install-startup`;
  const unixStartupCmd = `cd ~/Downloads && npm install ws && node ${bridgeFilename} --install-startup`;
  const winFixTokenCmd = `node ".\\Downloads\\${bridgeFilename}" --set-token ${roomToken || '<ROOM_TOKEN>'}`;
  const unixFixTokenCmd = `node ~/Downloads/${bridgeFilename} --set-token ${roomToken || '<ROOM_TOKEN>'}`;

  const joinUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/?room=${encodeURIComponent(roomId)}${
          roomToken ? `&token=${encodeURIComponent(roomToken)}` : ''
        }&connect=1`
      : '';

  useEffect(() => {
    setRoomInput(roomId);
  }, [roomId]);

  useEffect(() => {
    if (!open || !joinUrl) return;
    QRCode.toDataURL(joinUrl, { width: 220, margin: 1 })
      .then((url) => setQrDataUrl(url))
      .catch(() => setQrDataUrl(''));
  }, [open, joinUrl]);

  if (!open) return null;

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(joinUrl);
      setCopiedLink(true);
      window.setTimeout(() => setCopiedLink(false), 1800);
    } catch {
      // Clipboard restricted
    }
  };

  const handleCopyToken = async () => {
    if (!roomToken) return;
    try {
      await navigator.clipboard.writeText(roomToken);
      setCopiedToken(true);
      window.setTimeout(() => setCopiedToken(false), 1800);
    } catch {
      // Clipboard restricted
    }
  };

  const fetchVerifiedBridgeScript = async (): Promise<string> => {
    const resp = await fetch(`${bridgeUrl}&format=json`, {
      headers: {
        Accept: 'application/json',
        ...(roomToken ? { 'X-Relay-Room-Token': roomToken } : {}),
      },
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const contentType = resp.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
      throw new Error('Preview proxy intercepted download. Refresh the page and retry.');
    }
    const data = (await resp.json()) as { script?: string; error?: string };
    const text = String(data.script || '');
    if (!text || text.trim().startsWith('<')) {
      throw new Error(data.error || 'Received invalid script payload.');
    }
    return text;
  };

  const handleDownloadBridge = async () => {
    setDownloadingBridge(true);
    setBridgeMsg(null);
    try {
      const text = await fetchVerifiedBridgeScript();
      const blob = new Blob([text], { type: 'text/javascript;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = bridgeFilename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setBridgeMsg(`Saved valid JS script "${bridgeFilename}" to your Downloads folder.`);
    } catch (err) {
      setBridgeMsg(err instanceof Error ? err.message : 'Download failed — verify your room token is unlocked.');
    } finally {
      setDownloadingBridge(false);
    }
  };

  const handleCopyBridgeScript = async () => {
    setDownloadingBridge(true);
    setBridgeMsg(null);
    try {
      const text = await fetchVerifiedBridgeScript();
      await navigator.clipboard.writeText(text);
      setBridgeMsg(`Copied full "${bridgeFilename}" script to clipboard! Paste with: Get-Clipboard | Set-Content .\\${bridgeFilename}`);
    } catch (err) {
      setBridgeMsg(err instanceof Error ? err.message : 'Could not copy bridge script.');
    } finally {
      setDownloadingBridge(false);
    }
  };

  const handleCopyBridgeCmd = async (cmd: string, key = 'default') => {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopiedCmd(key);
      window.setTimeout(() => setCopiedCmd(null), 1800);
    } catch {
      // Clipboard restricted
    }
  };

  const handleJoinRoom = (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = roomInput.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
    if (cleaned.length >= 3) {
      onChangeRoom(cleaned);
    }
  };

  const handleUnlockRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tokenInput.trim() || !onApplyRoomToken) return;
    const ok = await onApplyRoomToken(tokenInput.trim());
    if (ok) {
      setTokenInput('');
    }
  };

  const handleGenerateRoom = () => {
    const randomCode = 'RLY-' + Math.random().toString(36).slice(2, 6).toUpperCase();
    onChangeRoom(randomCode);
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/70 flex items-center justify-center p-4">
      <div className="w-full max-w-xl rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-4">
          <div>
            <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
              Pair Another Device
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Authenticated pairing for room{' '}
              <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">{roomId}</span>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close pairing modal"
            className="p-1.5 text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 rounded-lg"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 pt-3 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2">
          <button
            type="button"
            onClick={() => setTab('mobile')}
            className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 ${
              tab === 'mobile'
                ? 'border-blue-600 text-blue-600 dark:text-blue-400'
                : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            <Smartphone className="w-3.5 h-3.5" />
            <span>Phone, Tablet & Browser</span>
          </button>
          <button
            type="button"
            onClick={() => setTab('bridge')}
            className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 ${
              tab === 'bridge'
                ? 'border-blue-600 text-blue-600 dark:text-blue-400'
                : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            <Terminal className="w-3.5 h-3.5" />
            <span>Desktop OS Bridge</span>
          </button>
        </div>

        <div className="p-5 space-y-5">
          {roomAuthError && (
            <div className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-3 space-y-2 text-xs">
              <div className="font-semibold text-amber-800 dark:text-amber-300">{roomAuthError}</div>
              {onApplyRoomToken && (
                <form onSubmit={handleUnlockRoom} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={tokenInput}
                    onChange={(e) => setTokenInput(e.target.value)}
                    placeholder="Paste Room Access Token..."
                    className="flex-1 px-2.5 py-1.5 font-mono bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded"
                  />
                  <button
                    type="submit"
                    className="px-3 py-1.5 font-semibold text-white bg-blue-600 rounded hover:bg-blue-700"
                  >
                    Unlock
                  </button>
                </form>
              )}
            </div>
          )}

          {tab === 'mobile' ? (
            <>
              <div className="flex flex-col sm:flex-row items-center gap-5">
                <div className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-white shrink-0">
                  {qrDataUrl ? (
                    <img
                      src={qrDataUrl}
                      alt={`QR code to join room ${roomId}`}
                      className="w-40 h-40 block"
                    />
                  ) : (
                    <div className="w-40 h-40 flex items-center justify-center text-xs text-slate-400">
                      Generating QR...
                    </div>
                  )}
                </div>

                <div className="flex-1 min-w-0 space-y-3 w-full">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      Scan or open on your second device
                    </h3>
                    <p className="text-xs text-slate-600 dark:text-slate-400 mt-1 leading-relaxed">
                      This pairing link embeds your authenticated room token so only paired devices can join the live WebSocket mesh.
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      readOnly
                      value={joinUrl}
                      aria-label="Workspace pairing URL"
                      className="flex-1 min-w-0 px-3 py-2 text-xs font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-700 dark:text-slate-300"
                    />
                    <button
                      type="button"
                      onClick={handleCopyLink}
                      className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 rounded-lg hover:opacity-90 whitespace-nowrap shrink-0"
                    >
                      {copiedLink ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>{copiedLink ? 'Copied' : 'Copy'}</span>
                    </button>
                  </div>

                  {roomToken && (
                    <div className="flex items-center justify-between gap-2 text-[11px] font-mono text-slate-500">
                      <span className="inline-flex items-center gap-1 truncate">
                        <KeyRound className="w-3 h-3 shrink-0" />
                        Token: {roomToken.slice(0, 10)}...
                      </span>
                      <button
                        type="button"
                        onClick={handleCopyToken}
                        className="text-blue-600 dark:text-blue-400 hover:underline shrink-0"
                      >
                        {copiedToken ? 'Token Copied' : 'Copy Token'}
                      </button>
                    </div>
                  )}

                  <div className="pt-1 flex flex-wrap items-center gap-2">
                    <PWAInstallButton />
                  </div>
                </div>
              </div>

              <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-3 text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                <strong className="text-slate-900 dark:text-slate-100">Phone Everywhere Control:</strong>{' '}
                Open the Shared App URL on your phone (not inside the preview frame) and install it to your home screen. Whenever your PC stays online with RAY open or the Startup Bridge installed, phone voice/text commands tunnel securely to your PC files, screen, and Ollama models.
              </div>

              <div className="pt-4 border-t border-slate-200 dark:border-slate-800">
                <form onSubmit={handleJoinRoom} className="flex flex-wrap items-center gap-2">
                  <label htmlFor="room-code-input" className="text-xs font-medium text-slate-600 dark:text-slate-400">
                    Room Code:
                  </label>
                  <input
                    id="room-code-input"
                    type="text"
                    value={roomInput}
                    onChange={(e) => setRoomInput(e.target.value.toUpperCase())}
                    placeholder="RLY-HOME"
                    className="w-36 px-3 py-1.5 text-xs font-mono uppercase bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100"
                  />
                  <button
                    type="submit"
                    className="px-3 py-1.5 text-xs font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 whitespace-nowrap shrink-0"
                  >
                    Join Room
                  </button>
                  <button
                    type="button"
                    onClick={handleGenerateRoom}
                    className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
                  >
                    <RefreshCw className="w-3 h-3" />
                    <span>New Private Room</span>
                  </button>
                </form>
              </div>
            </>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    RAY Persistent Desktop OS Bridge (v2.1)
                  </h3>
                  <p className="text-xs text-slate-600 dark:text-slate-400 mt-1 leading-relaxed">
                    Gives RAY live access to Desktop/Documents/Downloads/Vault, silent auto-start on PC boot, automatic <code className="font-mono">ollama serve</code> launch, and Phone → PC relay.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono text-slate-600 dark:text-slate-300">
                  <span
                    className={
                      bridgeStatus === 'connected'
                        ? 'text-emerald-700 dark:text-emerald-400 font-semibold'
                        : bridgeStatus === 'token_mismatch'
                        ? 'text-amber-700 dark:text-amber-400 font-semibold'
                        : ''
                    }
                  >
                    Bridge: {bridgeStatus === 'connected' ? 'Connected' : bridgeStatus === 'token_mismatch' ? '401 Token Mismatch' : 'Offline'}
                  </span>
                  <span>·</span>
                  <span className={ollamaRunning ? 'text-emerald-700 dark:text-emerald-400 font-semibold' : ''}>
                    Ollama: {ollamaRunning ? 'Running' : 'Standby'}
                  </span>
                  <span>·</span>
                  <span>Auto-Start: {bridgeStartupInstalled ? 'Installed' : 'Not installed'}</span>
                </div>
              </div>

              {bridgeStatus === 'token_mismatch' && (
                <div className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-3 space-y-2 text-xs">
                  <div className="flex items-start gap-2 font-semibold text-amber-800 dark:text-amber-300">
                    <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>
                      Fix 401 Invalid X-Relay-Room-Token: your local Bridge on port 17345 is holding an older token. Sync it in 1 command (or re-download &amp; restart):
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2 font-mono text-[11px] bg-white dark:bg-slate-950 border border-amber-200 dark:border-amber-900 rounded px-2.5 py-1.5 text-slate-800 dark:text-slate-200 overflow-x-auto">
                    <span className="truncate">{winFixTokenCmd}</span>
                    <button
                      type="button"
                      onClick={() => void handleCopyBridgeCmd(winFixTokenCmd, 'fixwin')}
                      className="px-2 py-0.5 text-[11px] rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0"
                    >
                      {copiedCmd === 'fixwin' ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  <div className="flex items-center justify-between gap-2 font-mono text-[11px] text-slate-600 dark:text-slate-400 overflow-x-auto">
                    <span className="truncate">macOS/Linux: {unixFixTokenCmd}</span>
                    <button
                      type="button"
                      onClick={() => void handleCopyBridgeCmd(unixFixTokenCmd, 'fixunix')}
                      className="px-2 py-0.5 text-[11px] rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0"
                    >
                      {copiedCmd === 'fixunix' ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                </div>
              )}

              <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-3.5 font-mono text-xs text-slate-800 dark:text-slate-200 space-y-2.5 overflow-x-auto">
                <div className="font-sans font-semibold text-slate-900 dark:text-slate-100">
                  1. Download <span className="font-mono">{bridgeFilename}</span> below
                </div>
                <div className="font-sans font-semibold text-slate-900 dark:text-slate-100">
                  2. Install Auto-Start on PC Boot + Auto Ollama (run once in PowerShell):
                </div>
                <div className="flex items-center justify-between gap-2 pl-2 text-blue-700 dark:text-blue-400">
                  <span className="break-all">{winStartupCmd}</span>
                  <button
                    type="button"
                    onClick={() => void handleCopyBridgeCmd(winStartupCmd, 'startup')}
                    className="px-2 py-0.5 text-[11px] rounded border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800 shrink-0"
                  >
                    {copiedCmd === 'startup' ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <div className="text-slate-500 text-[11px] flex items-center justify-between gap-2 pl-2">
                  <span className="break-all">macOS/Linux: {unixStartupCmd}</span>
                  <button
                    type="button"
                    onClick={() => void handleCopyBridgeCmd(unixStartupCmd, 'unixstartup')}
                    className="px-2 py-0.5 text-[11px] rounded border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800 shrink-0"
                  >
                    {copiedCmd === 'unixstartup' ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <div className="font-sans text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                  Copies into <code className="font-mono">%APPDATA%\RAY-Bridge</code>, registers silent startup login launch, persists your room token in <code className="font-mono">~/.ray-bridge/</code>, and automatically spawns <code className="font-mono">ollama serve</code> if Ollama is stopped.
                </div>
              </div>

              {bridgeMsg && (
                <div className="text-xs text-emerald-700 dark:text-emerald-400 font-medium">
                  {bridgeMsg}
                </div>
              )}

              <div className="flex flex-wrap items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={handleCopyBridgeScript}
                  disabled={downloadingBridge}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium border border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-60 rounded-lg transition-colors"
                >
                  <Copy className="w-3.5 h-3.5" />
                  <span>Copy Script</span>
                </button>
                <button
                  type="button"
                  onClick={handleDownloadBridge}
                  disabled={downloadingBridge}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 rounded-lg transition-colors"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>{downloadingBridge ? 'Downloading...' : `Download ${bridgeFilename}`}</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
