import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Brain,
  Check,
  Copy,
  FileCode2,
  FilePlus2,
  Folder,
  FolderOpen,
  FolderUp,
  HardDrive,
  Lock,
  Monitor,
  MonitorSmartphone,
  RefreshCw,
  Search,
  Send,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  Upload,
} from 'lucide-react';
import type { BrainNote, DeviceInfo } from '../types/relay';
import {
  captureScreenViaLocalBridge,
  getActiveWindowViaLocalBridge,
  getLocalBridgeRoots,
  listBridgeDirectory,
  probeLocalDirectBridge,
  readBridgeFile,
  searchBridgeFiles,
  writeBridgeFile,
} from '../services/localBridgeClient';
import type {
  LocalBridgeRoot,
  LocalFileContent,
  LocalFileEntry,
  LocalFileSearchHit,
} from '../services/localBridgeClient';
import { playHudSound } from '../utils/hudAudio';

interface BrowserMountedFile {
  id: string;
  name: string;
  relativePath: string;
  sizeBytes: number;
  lastModified: number;
  fileObj: File;
}

interface FilesSystemViewProps {
  roomId: string;
  devices: DeviceInfo[];
  hasBridgeOnline: boolean;
  screenSharing: boolean;
  screenControlArmed: boolean;
  onToggleScreenShare: () => Promise<void>;
  onToggleScreenControlArmed: () => Promise<void>;
  onCaptureBrowserScreenFrame: () => string | null;
  onOpenPairModal: () => void;
  onAskRayWithContext: (prompt: string, imageAttachment?: { name: string; dataUrl: string; mimeType: string }) => void;
  onSaveToBrain: (note: BrainNote) => Promise<void> | void;
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const FilesSystemView: React.FC<FilesSystemViewProps> = ({
  roomId,
  devices,
  hasBridgeOnline,
  screenSharing,
  screenControlArmed,
  onToggleScreenShare,
  onToggleScreenControlArmed,
  onCaptureBrowserScreenFrame,
  onOpenPairModal,
  onAskRayWithContext,
  onSaveToBrain,
}) => {
  const [sourceMode, setSourceMode] = useState<'bridge' | 'browser'>('bridge');
  const [bridgeOnlineLocal, setBridgeOnlineLocal] = useState(false);
  const [bridgeHostInfo, setBridgeHostInfo] = useState<string>('');
  const [roots, setRoots] = useState<LocalBridgeRoot[]>([]);
  const [currentPath, setCurrentPath] = useState('');
  const [parentPath, setParentPath] = useState('');
  const [entries, setEntries] = useState<LocalFileEntry[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchHits, setSearchHits] = useState<LocalFileSearchHit[] | null>(null);
  const [selectedFile, setSelectedFile] = useState<LocalFileContent | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [copiedFile, setCopiedFile] = useState(false);

  // Guarded Write / New File editor modal
  const [writeOpen, setWriteOpen] = useState(false);
  const [writePath, setWritePath] = useState('');
  const [writeContent, setWriteContent] = useState('');
  const [writingFile, setWritingFile] = useState(false);

  // Live Screen Vision & Active Window
  const [screenPreviewUrl, setScreenPreviewUrl] = useState<string | null>(null);
  const [activeWindowTitle, setActiveWindowTitle] = useState<string>('');
  const [capturingScreen, setCapturingScreen] = useState(false);

  // Browser Native Folder Mount (fallback / zero-install mode)
  const [browserFolderName, setBrowserFolderName] = useState('');
  const [browserFiles, setBrowserFiles] = useState<BrowserMountedFile[]>([]);
  const [browserFilter, setBrowserFilter] = useState('');
  const webkitInputRef = useRef<HTMLInputElement | null>(null);

  const loadDirectory = useCallback(
    async (dirPath: string) => {
      setLoadingList(true);
      setSearchHits(null);
      try {
        const res = await listBridgeDirectory(roomId, dirPath);
        if (res.ok && res.data) {
          setCurrentPath(res.data.currentPath);
          setParentPath(res.data.parentPath);
          setEntries(res.data.items);
          setStatusNotice(null);
        } else {
          setStatusNotice(res.error || 'Could not list directory.');
        }
      } finally {
        setLoadingList(false);
      }
    },
    [roomId]
  );

  const refreshBridgeFilesystem = useCallback(async () => {
    setLoadingList(true);
    try {
      const [probe, rootsRes, winRes] = await Promise.all([
        probeLocalDirectBridge(roomId),
        getLocalBridgeRoots(roomId),
        getActiveWindowViaLocalBridge(roomId),
      ]);
      setBridgeOnlineLocal(Boolean(probe?.ok));
      if (rootsRes.ok && rootsRes.data) {
        setRoots(rootsRes.data.roots);
        setBridgeHostInfo(`${rootsRes.data.hostname} · ${rootsRes.data.platform}`);
        if (rootsRes.data.roots.length > 0) {
          await loadDirectory(rootsRes.data.roots[0].path);
        }
      } else {
        setRoots([]);
        setStatusNotice(rootsRes.error || 'Desktop OS Bridge not detected.');
      }
      if (winRes.ok && winRes.data?.activeWindow) {
        setActiveWindowTitle(winRes.data.activeWindow);
      }
    } finally {
      setLoadingList(false);
    }
  }, [loadDirectory, roomId]);

  useEffect(() => {
    void refreshBridgeFilesystem();
  }, [refreshBridgeFilesystem]);

  const handleOpenBridgeFile = async (filePath: string) => {
    setLoadingFile(true);
    try {
      const res = await readBridgeFile(roomId, filePath, 1, 500);
      if (res.ok && res.data) {
        setSelectedFile(res.data);
        setStatusNotice(null);
      } else {
        setStatusNotice(res.error || 'Unable to read file.');
      }
    } finally {
      setLoadingFile(false);
    }
  };

  const handleSearchSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = searchQuery.trim();
    if (!q) {
      setSearchHits(null);
      return;
    }
    setLoadingList(true);
    try {
      const res = await searchBridgeFiles(roomId, q, currentPath || undefined);
      if (res.ok && res.data) {
        setSearchHits(res.data.results);
      } else {
        setStatusNotice(res.error || 'Search failed.');
      }
    } finally {
      setLoadingList(false);
    }
  };

  const handleWriteConfirmed = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!writePath.trim()) return;
    setWritingFile(true);
    try {
      const res = await writeBridgeFile(roomId, writePath.trim(), writeContent);
      if (res.ok && res.data) {
        playHudSound('affirmative');
        setWriteOpen(false);
        setStatusNotice(`Saved ${res.data.bytes} bytes to ${res.data.path}`);
        await handleOpenBridgeFile(res.data.path);
        if (currentPath) await loadDirectory(currentPath);
      } else {
        setStatusNotice(res.error || 'Write blocked or failed.');
      }
    } finally {
      setWritingFile(false);
    }
  };

  const handleCaptureScreen = async () => {
    setCapturingScreen(true);
    try {
      if (screenSharing) {
        const frame = onCaptureBrowserScreenFrame();
        if (frame) {
          setScreenPreviewUrl(frame);
          playHudSound('blip');
          return;
        }
      }
      const [capRes, winRes] = await Promise.all([
        captureScreenViaLocalBridge(roomId),
        getActiveWindowViaLocalBridge(roomId),
      ]);
      if (winRes.ok && winRes.data?.activeWindow) {
        setActiveWindowTitle(winRes.data.activeWindow);
      }
      if (capRes.ok && capRes.data?.dataUrl) {
        setScreenPreviewUrl(capRes.data.dataUrl);
        playHudSound('affirmative');
        setStatusNotice(null);
        return;
      }
      setStatusNotice(
        capRes.error || 'Desktop Bridge unreachable — use "Share Screen" button to stream via browser.'
      );
    } finally {
      setCapturingScreen(false);
    }
  };

  // Browser File System Access API + WebKit Directory Fallback
  const handleMountBrowserDirectory = async () => {
    const picker = (
      window as unknown as {
        showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>;
      }
    ).showDirectoryPicker;

    if (typeof picker === 'function') {
      try {
        const dirHandle = await picker();
        const collected: BrowserMountedFile[] = [];
        const walkHandle = async (handle: FileSystemDirectoryHandle, prefix: string, depth: number) => {
          if (depth > 4 || collected.length >= 400) return;
          const iter = (handle as unknown as {
            values: () => AsyncIterable<FileSystemFileHandle | FileSystemDirectoryHandle>;
          }).values();
          for await (const entry of iter) {
            if (collected.length >= 400) break;
            if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue;
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.kind === 'directory') {
              await walkHandle(entry as FileSystemDirectoryHandle, rel, depth + 1);
            } else {
              const file = await (entry as FileSystemFileHandle).getFile();
              collected.push({
                id: `${rel}-${file.lastModified}`,
                name: entry.name,
                relativePath: rel,
                sizeBytes: file.size,
                lastModified: file.lastModified,
                fileObj: file,
              });
            }
          }
        };
        await walkHandle(dirHandle, '', 0);
        setBrowserFolderName(dirHandle.name);
        setBrowserFiles(collected);
        setSourceMode('browser');
        playHudSound('affirmative');
        setStatusNotice(`Mounted browser folder "${dirHandle.name}" (${collected.length} files).`);
        return;
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') return;
        // Sandboxed iframe throws SecurityError — fall back cleanly to webkitdirectory input
      }
    }

    webkitInputRef.current?.click();
  };

  const handleWebkitDirectoryPicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const rawList = Array.from(e.target.files || []);
    if (rawList.length === 0) return;
    const filtered = rawList
      .filter((f) => {
        const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
        return !rel.includes('/node_modules/') && !rel.includes('/.git/') && !rel.startsWith('.');
      })
      .slice(0, 400);

    const firstRel = (filtered[0] as File & { webkitRelativePath?: string })?.webkitRelativePath || '';
    const folderLabel = firstRel.includes('/') ? firstRel.split('/')[0] : 'Mounted Folder';
    const mapped: BrowserMountedFile[] = filtered.map((file) => {
      const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      return {
        id: `${rel}-${file.lastModified}`,
        name: file.name,
        relativePath: rel,
        sizeBytes: file.size,
        lastModified: file.lastModified,
        fileObj: file,
      };
    });
    setBrowserFolderName(folderLabel);
    setBrowserFiles(mapped);
    setSourceMode('browser');
    playHudSound('affirmative');
    setStatusNotice(`Mounted local folder "${folderLabel}" (${mapped.length} files via browser).`);
    e.target.value = '';
  };

  const handleOpenBrowserFile = async (item: BrowserMountedFile) => {
    setLoadingFile(true);
    try {
      if (item.sizeBytes > 300 * 1024) {
        setStatusNotice(`"${item.name}" exceeds 300KB inline viewer limit (${formatBytes(item.sizeBytes)}).`);
        return;
      }
      const lower = item.name.toLowerCase();
      if (
        lower === '.env' ||
        lower.startsWith('.env.') ||
        /\.(pem|key|pfx|p12)$/i.test(lower)
      ) {
        setStatusNotice('Blocked by RAY Security Shield: sensitive key/env files cannot be loaded into AI context.');
        return;
      }
      const text = await item.fileObj.text();
      const lines = text.split(/\r?\n/);
      setSelectedFile({
        path: item.relativePath,
        name: item.name,
        sizeBytes: item.sizeBytes,
        totalLines: lines.length,
        startLine: 1,
        endLine: Math.min(500, lines.length),
        content: lines.slice(0, 500).join('\n'),
      });
      setStatusNotice(null);
    } finally {
      setLoadingFile(false);
    }
  };

  const filteredBrowserFiles = useMemo(() => {
    const q = browserFilter.trim().toLowerCase();
    if (!q) return browserFiles.slice(0, 120);
    return browserFiles
      .filter((f) => f.relativePath.toLowerCase().includes(q) || f.name.toLowerCase().includes(q))
      .slice(0, 120);
  }, [browserFiles, browserFilter]);

  const bridgeDevice = useMemo(
    () =>
      devices.find((d) => d.type === 'bridge' && d.online) ||
      devices.find((d) => d.online && d.telemetry?.cpuPercent != null) ||
      devices[0],
    [devices]
  );

  const anyBridgeAlive = bridgeOnlineLocal || hasBridgeOnline;

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto space-y-5">
      <input
        ref={(el) => {
          webkitInputRef.current = el;
          if (el) {
            el.setAttribute('webkitdirectory', '');
            el.setAttribute('directory', '');
          }
        }}
        type="file"
        multiple
        className="hidden"
        onChange={handleWebkitDirectoryPicked}
      />

      {/* Top Header */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-xl font-bold text-slate-900 dark:text-slate-100">
            System Files, Screen Vision &amp; OS Monitor
          </h1>
          <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-400 mt-0.5">
            Dual-plane access: hardened Desktop OS Bridge (<code className="font-mono">127.0.0.1:17345</code>) or zero-install Browser Folder Mount with secret-file &amp; symlink protection.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center p-0.5 bg-slate-100 dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700">
            <button
              type="button"
              onClick={() => setSourceMode('bridge')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                sourceMode === 'bridge'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              OS Bridge ({anyBridgeAlive ? 'Online' : 'Setup'})
            </button>
            <button
              type="button"
              onClick={() => setSourceMode('browser')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                sourceMode === 'browser'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              Browser Folder {browserFiles.length > 0 ? `(${browserFiles.length})` : ''}
            </button>
          </div>

          <button
            type="button"
            onClick={() => void handleMountBrowserDirectory()}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 hover:border-blue-600 rounded-lg"
          >
            <Upload className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
            <span>Mount Local Folder</span>
          </button>

          <button
            type="button"
            onClick={() => void refreshBridgeFilesystem()}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loadingList ? 'animate-spin' : ''}`} />
            <span>Sync OS</span>
          </button>
        </div>
      </div>

      {statusNotice && (
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 py-2.5 text-xs text-slate-700 dark:text-slate-200 flex items-center justify-between gap-3">
          <span>{statusNotice}</span>
          {!anyBridgeAlive && sourceMode === 'bridge' && (
            <button
              type="button"
              onClick={onOpenPairModal}
              className="text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline shrink-0"
            >
              Download Updated Bridge Script
            </button>
          )}
        </div>
      )}

      {/* Main 12-Col Grid */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-5">
        {/* Left 8 Cols: File Explorer + File Previewer */}
        <div className="xl:col-span-8 space-y-4">
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
            {sourceMode === 'bridge' ? (
              <>
                {/* Roots & Search Bar */}
                <div className="p-4 border-b border-slate-200 dark:border-slate-800 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {roots.map((r) => (
                        <button
                          key={r.id}
                          type="button"
                          onClick={() => void loadDirectory(r.path)}
                          className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md border transition-colors ${
                            currentPath === r.path || currentPath.startsWith(r.path)
                              ? 'border-blue-600 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300'
                              : 'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                          }`}
                        >
                          <HardDrive className="w-3 h-3" />
                          <span>{r.label}</span>
                        </button>
                      ))}
                      {roots.length === 0 && (
                        <span className="text-xs text-slate-500">
                          Run <code className="font-mono">relay-bridge-{roomId.toLowerCase()}.mjs</code> for direct OS filesystem access, or click Mount Local Folder.
                        </span>
                      )}
                    </div>

                    <button
                      type="button"
                      disabled={!anyBridgeAlive}
                      onClick={() => {
                        setWritePath(currentPath ? `${currentPath}/ray-note.md` : 'vault/ray-note.md');
                        setWriteContent('# New Note\n\nCreated from RAY Files & OS.\n');
                        setWriteOpen((v) => !v);
                      }}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium border border-slate-200 dark:border-slate-700 rounded-md text-slate-700 dark:text-slate-200 hover:border-blue-600 disabled:opacity-40"
                    >
                      <FilePlus2 className="w-3.5 h-3.5" />
                      <span>New / Edit File</span>
                    </button>
                  </div>

                  <form onSubmit={handleSearchSubmit} className="flex items-center gap-2">
                    {currentPath && (
                      <button
                        type="button"
                        onClick={() => void loadDirectory(parentPath)}
                        className="p-2 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
                        title="Parent folder"
                      >
                        <FolderUp className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <div className="relative flex-1">
                      <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-2.5" />
                      <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Search filenames or inside code/documents (e.g. invoice, App.tsx, study notes)..."
                        className="w-full pl-8 pr-3 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100"
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={!anyBridgeAlive || !searchQuery.trim()}
                      className="px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-40 rounded-lg"
                    >
                      Search
                    </button>
                    {searchHits && (
                      <button
                        type="button"
                        onClick={() => setSearchHits(null)}
                        className="px-2.5 py-1.5 text-xs border border-slate-200 dark:border-slate-700 rounded-lg"
                      >
                        Clear
                      </button>
                    )}
                  </form>

                  {currentPath && (
                    <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400 truncate">
                      {bridgeHostInfo ? `${bridgeHostInfo} · ` : ''}
                      {currentPath}
                    </div>
                  )}
                </div>

                {/* Confirmation-Gated Write Form */}
                {writeOpen && (
                  <form
                    onSubmit={handleWriteConfirmed}
                    className="p-4 bg-amber-50/60 dark:bg-amber-950/20 border-b border-amber-200 dark:border-amber-900/50 space-y-2.5"
                  >
                    <div className="flex items-center gap-2 text-xs font-semibold text-amber-800 dark:text-amber-300">
                      <ShieldAlert className="w-4 h-4" />
                      <span>Human-in-the-Loop File Write (Sandbox Verified)</span>
                    </div>
                    <input
                      type="text"
                      required
                      value={writePath}
                      onChange={(e) => setWritePath(e.target.value)}
                      placeholder="Target file path inside allowed roots..."
                      className="w-full px-3 py-1.5 text-xs font-mono bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg"
                    />
                    <textarea
                      rows={4}
                      value={writeContent}
                      onChange={(e) => setWriteContent(e.target.value)}
                      className="w-full px-3 py-2 text-xs font-mono bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg"
                    />
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setWriteOpen(false)}
                        className="px-3 py-1.5 text-xs border border-slate-300 dark:border-slate-700 rounded-lg"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={writingFile}
                        className="px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg"
                      >
                        {writingFile ? 'Writing...' : 'Approve & Write File'}
                      </button>
                    </div>
                  </form>
                )}

                {/* Directory Listing / Search Results + File Viewer Split */}
                <div className="grid grid-cols-1 md:grid-cols-12 min-h-[420px]">
                  <div className="md:col-span-5 border-b md:border-b-0 md:border-r border-slate-200 dark:border-slate-800 max-h-[480px] overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800">
                    {searchHits ? (
                      searchHits.length === 0 ? (
                        <div className="p-6 text-center text-xs text-slate-500">No matches found.</div>
                      ) : (
                        searchHits.map((hit) => (
                          <button
                            key={hit.path}
                            type="button"
                            onClick={() =>
                              hit.kind === 'dir'
                                ? void loadDirectory(hit.path)
                                : void handleOpenBridgeFile(hit.path)
                            }
                            className="w-full px-3.5 py-2.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800/50 space-y-0.5"
                          >
                            <div className="flex items-center gap-2 text-xs font-medium text-slate-900 dark:text-slate-100 truncate">
                              {hit.kind === 'dir' ? (
                                <Folder className="w-3.5 h-3.5 text-blue-600 shrink-0" />
                              ) : (
                                <FileCode2 className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                              )}
                              <span className="truncate">{hit.name}</span>
                            </div>
                            <div className="text-[10px] font-mono text-slate-400 truncate">{hit.path}</div>
                            {hit.snippet && (
                              <div className="text-[11px] text-slate-600 dark:text-slate-400 line-clamp-2">
                                {hit.snippet}
                              </div>
                            )}
                          </button>
                        ))
                      )
                    ) : entries.length === 0 ? (
                      <div className="p-6 text-center text-xs text-slate-500">
                        {anyBridgeAlive ? 'Folder is empty.' : 'Connect OS Bridge or switch to Browser Folder tab.'}
                      </div>
                    ) : (
                      entries.map((item) => (
                        <button
                          key={item.path}
                          type="button"
                          onClick={() =>
                            item.kind === 'dir'
                              ? void loadDirectory(item.path)
                              : void handleOpenBridgeFile(item.path)
                          }
                          className={`w-full px-3.5 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800/50 flex items-center justify-between gap-2 ${
                            selectedFile?.path === item.path ? 'bg-blue-50/70 dark:bg-blue-950/30' : ''
                          }`}
                        >
                          <span className="inline-flex items-center gap-2 min-w-0 text-xs text-slate-800 dark:text-slate-200">
                            {item.kind === 'dir' ? (
                              <Folder className="w-3.5 h-3.5 text-blue-600 shrink-0" />
                            ) : (
                              <FileCode2 className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                            )}
                            <span className="truncate">{item.name}</span>
                          </span>
                          <span className="text-[10px] font-mono text-slate-400 tabular-nums shrink-0">
                            {item.kind === 'dir' ? 'DIR' : formatBytes(item.sizeBytes)}
                          </span>
                        </button>
                      ))
                    )}
                  </div>

                  {/* File Inspector Pane */}
                  <div className="md:col-span-7 flex flex-col">
                    {loadingFile ? (
                      <div className="p-6 text-xs text-slate-500">Reading file...</div>
                    ) : selectedFile ? (
                      <>
                        <div className="px-4 py-2.5 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2 bg-slate-50/70 dark:bg-slate-950/60">
                          <div className="min-w-0">
                            <div className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">
                              {selectedFile.name}
                            </div>
                            <div className="text-[10px] font-mono text-slate-500 truncate">
                              {selectedFile.totalLines} lines · {formatBytes(selectedFile.sizeBytes)}
                            </div>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => {
                                void navigator.clipboard?.writeText(selectedFile.content);
                                setCopiedFile(true);
                                window.setTimeout(() => setCopiedFile(false), 1400);
                              }}
                              className="inline-flex items-center gap-1 px-2 py-1 text-[11px] border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-100 dark:hover:bg-slate-800"
                            >
                              {copiedFile ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                              <span>{copiedFile ? 'Copied' : 'Copy'}</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                const ts = Date.now();
                                void onSaveToBrain({
                                  id: `note-file-${ts}`,
                                  title: `File · ${selectedFile.name}`,
                                  slug: selectedFile.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
                                  folder: 'Files',
                                  content: `# ${selectedFile.name}\n\nSource Path: \`${selectedFile.path}\`\n\n\`\`\`\n${selectedFile.content.slice(0, 6000)}\n\`\`\`\n\n#files #ray`,
                                  tags: ['files', 'ray'],
                                  links: ['Ray Second Brain'],
                                  source: 'user',
                                  createdAt: ts,
                                  updatedAt: ts,
                                });
                                playHudSound('affirmative');
                                setStatusNotice(`Saved "${selectedFile.name}" into your Second Brain.`);
                              }}
                              className="inline-flex items-center gap-1 px-2 py-1 text-[11px] border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-100 dark:hover:bg-slate-800"
                            >
                              <Brain className="w-3 h-3 text-blue-600" />
                              <span>Save to Brain</span>
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                onAskRayWithContext(
                                  `Analyze this file (${selectedFile.path}):\n\n\`\`\`\n${selectedFile.content.slice(0, 4500)}\n\`\`\``
                                )
                              }
                              className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded"
                            >
                              <Send className="w-3 h-3" />
                              <span>Ask RAY</span>
                            </button>
                          </div>
                        </div>
                        <pre className="p-4 text-[11px] font-mono text-slate-800 dark:text-slate-200 overflow-auto max-h-[430px] leading-relaxed whitespace-pre-wrap break-words">
                          {selectedFile.content}
                        </pre>
                      </>
                    ) : (
                      <div className="flex-1 flex flex-col items-center justify-center p-8 text-center text-xs text-slate-500 space-y-2">
                        <FolderOpen className="w-6 h-6 text-slate-400" />
                        <p>Select any file on the left to inspect its contents, save it to Second Brain, or send it to RAY.</p>
                      </div>
                    )}
                  </div>
                </div>
              </>
            ) : (
              /* Browser Native Folder Mount UI */
              <>
                <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs text-slate-700 dark:text-slate-300">
                    {browserFolderName ? (
                      <span>
                        Mounted: <strong>{browserFolderName}</strong> ({browserFiles.length} files indexed locally in browser)
                      </span>
                    ) : (
                      <span>Zero-install access: mount any local project or Documents folder straight into your browser.</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={browserFilter}
                      onChange={(e) => setBrowserFilter(e.target.value)}
                      placeholder="Filter mounted files..."
                      className="px-2.5 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg"
                    />
                    <button
                      type="button"
                      onClick={() => void handleMountBrowserDirectory()}
                      className="px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg"
                    >
                      Pick Folder
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-12 min-h-[420px]">
                  <div className="md:col-span-5 border-b md:border-b-0 md:border-r border-slate-200 dark:border-slate-800 max-h-[460px] overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800">
                    {filteredBrowserFiles.length === 0 ? (
                      <div className="p-6 text-center text-xs text-slate-500">
                        Click &ldquo;Pick Folder&rdquo; to mount local files without needing a terminal script.
                      </div>
                    ) : (
                      filteredBrowserFiles.map((bf) => (
                        <button
                          key={bf.id}
                          type="button"
                          onClick={() => void handleOpenBrowserFile(bf)}
                          className={`w-full px-3.5 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800/50 flex items-center justify-between gap-2 ${
                            selectedFile?.path === bf.relativePath ? 'bg-blue-50/70 dark:bg-blue-950/30' : ''
                          }`}
                        >
                          <span className="truncate text-xs text-slate-800 dark:text-slate-200">
                            {bf.relativePath}
                          </span>
                          <span className="text-[10px] font-mono text-slate-400 shrink-0">
                            {formatBytes(bf.sizeBytes)}
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                  <div className="md:col-span-7 flex flex-col">
                    {selectedFile ? (
                      <>
                        <div className="px-4 py-2.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2 bg-slate-50/70 dark:bg-slate-950/60">
                          <span className="text-xs font-semibold truncate">{selectedFile.path}</span>
                          <button
                            type="button"
                            onClick={() =>
                              onAskRayWithContext(
                                `Analyze this local file (${selectedFile.path}):\n\n\`\`\`\n${selectedFile.content.slice(0, 4500)}\n\`\`\``
                              )
                            }
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded"
                          >
                            <Send className="w-3 h-3" />
                            <span>Ask RAY</span>
                          </button>
                        </div>
                        <pre className="p-4 text-[11px] font-mono text-slate-800 dark:text-slate-200 overflow-auto max-h-[410px] whitespace-pre-wrap break-words">
                          {selectedFile.content}
                        </pre>
                      </>
                    ) : (
                      <div className="flex-1 flex items-center justify-center p-8 text-xs text-slate-500">
                        Select a mounted file to inspect or send to RAY.
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Right 4 Cols: Live Screen Vision + Active Window + OS Processes + Security Boundary */}
        <div className="xl:col-span-4 space-y-4">
          {/* Live Screen Vision & Control */}
          <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Monitor className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Live Screen &amp; Window Vision
                </h2>
              </div>
              <button
                type="button"
                onClick={() => void handleCaptureScreen()}
                disabled={capturingScreen}
                className="px-2.5 py-1 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-md"
              >
                {capturingScreen ? 'Capturing...' : 'Snap Screen'}
              </button>
            </div>

            <div className="text-xs text-slate-600 dark:text-slate-400 flex items-center justify-between gap-2">
              <span>Active Window:</span>
              <span className="font-mono text-slate-900 dark:text-slate-100 truncate max-w-[200px]">
                {activeWindowTitle || bridgeDevice?.telemetry?.activeWindow || 'Capture to detect'}
              </span>
            </div>

            {screenPreviewUrl ? (
              <div className="space-y-2">
                <img
                  src={screenPreviewUrl}
                  alt="Captured screen preview"
                  className="w-full h-40 object-cover rounded-lg border border-slate-200 dark:border-slate-800"
                />
                <button
                  type="button"
                  onClick={() =>
                    onAskRayWithContext(
                      `Inspect what is currently on my screen${activeWindowTitle ? ` (active window: "${activeWindowTitle}")` : ''} and help me with the next step.`,
                      {
                        name: 'desktop-screen.png',
                        dataUrl: screenPreviewUrl,
                        mimeType: 'image/png',
                      }
                    )
                  }
                  className="w-full py-1.5 text-xs font-semibold text-white bg-slate-900 dark:bg-slate-100 dark:text-slate-900 hover:opacity-90 rounded-lg"
                >
                  Send Screen Frame to RAY
                </button>
              </div>
            ) : (
              <div className="h-32 rounded-lg border border-dashed border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/60 flex flex-col items-center justify-center text-center p-4 text-xs text-slate-500">
                <p>Click &ldquo;Snap Screen&rdquo; (OS Bridge) or &ldquo;Share Screen&rdquo; below to let RAY see your screen.</p>
              </div>
            )}

            <div className="grid grid-cols-2 gap-2 pt-1">
              <button
                type="button"
                onClick={() => void onToggleScreenShare()}
                className={`py-1.5 px-2.5 text-xs font-medium rounded-lg border ${
                  screenSharing
                    ? 'border-blue-600 text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/30'
                    : 'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200'
                }`}
              >
                {screenSharing ? 'Stop Browser Share' : 'Share Browser Screen'}
              </button>
              <button
                type="button"
                onClick={() => void onToggleScreenControlArmed()}
                className={`py-1.5 px-2.5 text-xs font-medium rounded-lg border ${
                  screenControlArmed
                    ? 'border-amber-500 text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/30'
                    : 'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200'
                }`}
              >
                {screenControlArmed ? 'Input: Armed' : 'Input: Safe'}
              </button>
            </div>
          </section>

          {/* OS Process & Telemetry */}
          <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <MonitorSmartphone className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                  System Processes
                </h2>
              </div>
              <span className="text-[11px] font-mono text-slate-500">
                {bridgeDevice?.telemetry?.cpuPercent != null ? `${bridgeDevice.telemetry.cpuPercent}% CPU` : 'Live'}
              </span>
            </div>

            {bridgeDevice?.telemetry?.topProcesses && bridgeDevice.telemetry.topProcesses.length > 0 ? (
              <div className="space-y-1.5">
                {bridgeDevice.telemetry.topProcesses.slice(0, 6).map((p) => (
                  <div
                    key={`${p.pid}-${p.name}`}
                    className="flex items-center justify-between px-2.5 py-1.5 rounded bg-slate-50 dark:bg-slate-950 border border-slate-100 dark:border-slate-800 text-xs tabular-nums"
                  >
                    <span className="font-mono text-slate-800 dark:text-slate-200 truncate">{p.name}</span>
                    <span className="font-mono text-[11px] text-slate-500 shrink-0">
                      {p.cpuPercent}% · {p.memoryPercent}% RAM
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-slate-500">
                Connect the OS Bridge to inspect live CPU/RAM processes across Windows, macOS, or Linux.
              </p>
            )}
          </section>

          {/* Security Boundary Architecture Card */}
          <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-2.5 text-xs">
            <div className="flex items-center gap-2 font-semibold text-slate-900 dark:text-slate-100">
              <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
              <span>Zero-Trust OS File Guardrails</span>
            </div>
            <ul className="space-y-1.5 text-slate-600 dark:text-slate-400 text-[11px]">
              <li className="flex items-start gap-1.5">
                <Lock className="w-3.5 h-3.5 text-emerald-600 shrink-0 mt-0.5" />
                <span>Symlink-safe <code className="font-mono">realpathSync</code> jail scoped strictly to Desktop, Documents, Downloads, Vault, or <code className="font-mono">RELAY_ALLOWED_DIRS</code>.</span>
              </li>
              <li className="flex items-start gap-1.5">
                <Lock className="w-3.5 h-3.5 text-emerald-600 shrink-0 mt-0.5" />
                <span>Blocks secret files (<code className="font-mono">.env</code>, <code className="font-mono">.ssh/</code>, <code className="font-mono">*.pem</code>, <code className="font-mono">*.key</code>, credentials JSON) against prompt-injection leaks.</span>
              </li>
              <li className="flex items-start gap-1.5">
                <Terminal className="w-3.5 h-3.5 text-blue-600 shrink-0 mt-0.5" />
                <span>All file writes and screen mouse/keyboard actions require explicit Human-in-the-Loop confirmation.</span>
              </li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
};
