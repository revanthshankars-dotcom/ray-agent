import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRight, Cloud, FileText, HardDrive, Link2, RefreshCw, Sparkles, X } from 'lucide-react';
import type { BrainNote } from '../types/relay';
import { BrainGraph3D, fileColor, type GraphLink, type GraphNode } from './BrainGraph3D';
import { authFetch } from '../utils/roomAuth';

interface DeviceFileMap {
  deviceId: string;
  deviceName: string;
  sep: string;
  online: boolean;
  indexedAt: number;
  count: number;
  files: Array<{ p: string; s: number; m: number }>;
}
interface DriveFile {
  id: string;
  name: string;
  mimeType?: string;
  modifiedTime?: string;
  webViewLink?: string;
}

/** Strip the user's home prefix so folders read "Documents/Work" instead of "C:\\Users\\ray\\Documents\\Work". */
function relPath(p: string): string {
  return p
    .replace(/^[A-Za-z]:[\\/]Users[\\/][^\\/]+[\\/]/i, '')
    .replace(/^\/(home|Users)\/[^/]+\//, '')
    .replace(/^\/data\/data\/com\.termux\/files\/home\/(storage\/shared\/)?/, '')
    .replace(/^\/(sdcard|storage\/emulated\/0)\//, 'Phone/')
    .replace(/\\/g, '/');
}

function buildFileGraph(maps: DeviceFileMap[], drive: DriveFile[], notes: BrainNote[], perDevice: number, showDevices: boolean, showCloud: boolean) {
  const nodes: GraphNode[] = [];
  const links: GraphLink[] = [];
  const fileNodes: GraphNode[] = [];
  if (showDevices) {
    for (const d of maps) {
      const devId = `dev:${d.deviceId}`;
      nodes.push({ id: devId, label: d.deviceName, kind: 'device', folder: 'Devices', degree: 0, meta: { online: d.online } });
      const seenFolders = new Set<string>();
      for (const f of d.files.slice(0, perDevice)) {
        const rel = relPath(f.p);
        const parts = rel.split('/');
        const name = parts.pop() || rel;
        let parent = devId;
        let acc = '';
        for (const seg of parts.slice(0, 2)) {
          acc = acc ? `${acc}/${seg}` : seg;
          const fid = `fold:${d.deviceId}:${acc}`;
          if (!seenFolders.has(fid)) {
            seenFolders.add(fid);
            nodes.push({ id: fid, label: seg, kind: 'folder', folder: acc, degree: 0, meta: { device: d.deviceName, path: acc } });
            links.push({ source: parent, target: fid, kind: 'contains' });
          }
          parent = fid;
        }
        const node: GraphNode = {
          id: `file:${d.deviceId}:${f.p}`,
          label: name,
          kind: 'file',
          folder: parts.join('/'),
          degree: 0,
          meta: { device: d.deviceName, path: f.p, sizeKb: Math.round(f.s / 1024), modified: new Date(f.m).toISOString().slice(0, 10), online: d.online },
        };
        nodes.push(node);
        fileNodes.push(node);
        links.push({ source: parent, target: node.id, kind: 'contains' });
      }
    }
  }
  if (showCloud && drive.length) {
    nodes.push({ id: 'cloud:gdrive', label: 'Google Drive', kind: 'cloud', folder: 'Cloud', degree: 0 });
    for (const f of drive) {
      const node: GraphNode = { id: `gd:${f.id}`, label: f.name, kind: 'file', folder: 'Google Drive', degree: 0, meta: { device: 'Google Drive', path: f.name, modified: f.modifiedTime?.slice(0, 10), url: f.webViewLink } };
      nodes.push(node);
      fileNodes.push(node);
      links.push({ source: 'cloud:gdrive', target: node.id, kind: 'contains' });
    }
  }
  // Notes that mention a file by name are linked to it (Obsidian-style cross references).
  const named = fileNodes.filter((f) => f.label.replace(/\.[^.]+$/, '').length >= 5);
  for (const n of notes) {
    const text = `${n.title}\n${n.content}`.toLowerCase();
    for (const f of named) {
      const base = f.label.toLowerCase();
      const stem = base.replace(/\.[^.]+$/, '');
      if (text.includes(base) || text.includes(stem)) links.push({ source: n.id, target: f.id, kind: 'mentions' });
    }
  }
  return { nodes, links };
}

/**
 * Full-page 3D Second Brain: the whole knowledge graph, with a reading panel for the
 * clicked note (backlinks included) — RAY's Obsidian-style "graph view".
 */
export function Brain3DView({
  notes,
  onOpenInEditor,
  onAskRay,
  roomId,
  googleAccessToken,
}: {
  notes: BrainNote[];
  onOpenInEditor: (noteId: string) => void;
  onAskRay: (prompt: string) => void;
  roomId: string;
  googleAccessToken?: string | null;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<GraphNode | null>(null);
  const [maps, setMaps] = useState<DeviceFileMap[]>([]);
  const [drive, setDrive] = useState<DriveFile[]>([]);
  const [showDevices, setShowDevices] = useState(true);
  const [showCloud, setShowCloud] = useState(true);
  const [perDevice, setPerDevice] = useState(300);
  const [loadingFiles, setLoadingFiles] = useState(false);

  const loadFiles = useCallback(
    async (rescan = false) => {
      setLoadingFiles(true);
      try {
        if (rescan) {
          await authFetch('/api/brain/files/refresh', roomId, { method: 'POST', body: JSON.stringify({ roomId }) });
        }
        const r = await authFetch(`/api/brain/files?room=${encodeURIComponent(roomId)}&perDevice=2000`, roomId);
        const j = (await r.json()) as { devices?: DeviceFileMap[] };
        setMaps(j.devices || []);
        if (googleAccessToken) {
          const d = await authFetch(
            '/api/workspace/execute',
            roomId,
            { method: 'POST', body: JSON.stringify({ roomId, action: 'drive_search_files', args: { pageSize: 300 } }) },
            { googleAccessToken }
          );
          const dj = (await d.json()) as { result?: string };
          try {
            setDrive(JSON.parse(dj.result || '[]') as DriveFile[]);
          } catch {
            setDrive([]);
          }
        }
      } catch {
        // offline — keep what we have
      } finally {
        setLoadingFiles(false);
      }
    },
    [googleAccessToken, roomId]
  );

  useEffect(() => {
    void loadFiles(false);
  }, [loadFiles]);

  const extra = useMemo(() => buildFileGraph(maps, drive, notes, perDevice, showDevices, showCloud), [maps, drive, notes, perDevice, showDevices, showCloud]);
  const totalFiles = maps.reduce((a, d) => a + d.count, 0);
  const selected = notes.find((n) => n.id === selectedId) || null;
  const backlinks = useMemo(
    () => (selected ? notes.filter((n) => n.id !== selected.id && n.links?.some((l) => l.toLowerCase() === selected.title.toLowerCase())) : []),
    [notes, selected]
  );

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[1600px] mx-auto p-3 sm:p-5 pb-24 md:pb-5">
        <div className="flex flex-wrap items-end justify-between gap-2 mb-3">
          <div>
            <p className="text-[11px] uppercase tracking-[0.2em] text-cyan-600 dark:text-cyan-400 font-semibold">Second Brain</p>
            <h1 className="font-display text-xl sm:text-2xl font-bold text-slate-900 dark:text-slate-100">3D Knowledge Graph</h1>
            <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-400">
              Notes, [[wikilinks]], #tags — plus every file on your connected devices and in your cloud. Click a node to inspect it.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 mb-3 text-xs">
          <button
            type="button"
            onClick={() => setShowDevices((v) => !v)}
            className={`h-8 px-3 inline-flex items-center gap-1.5 rounded-lg border ${showDevices ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-600 dark:text-indigo-300' : 'border-slate-200 dark:border-slate-700 text-slate-500'}`}
          >
            <HardDrive className="w-3.5 h-3.5" /> Device files ({maps.length} devices · {totalFiles.toLocaleString()} files)
          </button>
          <button
            type="button"
            onClick={() => setShowCloud((v) => !v)}
            className={`h-8 px-3 inline-flex items-center gap-1.5 rounded-lg border ${showCloud ? 'border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-300' : 'border-slate-200 dark:border-slate-700 text-slate-500'}`}
          >
            <Cloud className="w-3.5 h-3.5" /> Cloud ({googleAccessToken ? `${drive.length} Drive files` : 'connect Google'})
          </button>
          <label className="inline-flex items-center gap-2 text-slate-600 dark:text-slate-300">
            Files per device
            <input type="range" min={50} max={2000} step={50} value={perDevice} onChange={(e) => setPerDevice(Number(e.target.value))} className="w-28" />
            <span className="tabular-nums w-10">{perDevice}</span>
          </label>
          <button
            type="button"
            onClick={() => void loadFiles(true)}
            className="h-8 px-3 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loadingFiles ? 'animate-spin' : ''}`} /> Rescan devices
          </button>
          <span className="flex items-center gap-2 text-[11px] text-slate-500">
            {[['Docs', '#f59e0b'], ['Images', '#ec4899'], ['Media', '#a855f7'], ['Code', '#06b6d4'], ['Sheets', '#22c55e']].map(([l, c]) => (
              <span key={l} className="inline-flex items-center gap-1">
                <span className="w-2 h-2 rounded-full" style={{ background: c }} />
                {l}
              </span>
            ))}
          </span>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-[1fr_360px] gap-3">
          <div className="min-w-0 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3">
            {notes.length === 0 ? (
              <div className="h-[60vh] flex flex-col items-center justify-center text-center gap-2 text-slate-500">
                <Sparkles className="w-6 h-6 text-cyan-500" />
                <p className="text-sm">Your brain is empty. Ask RAY to “remember…” something or create a note in Second Brain.</p>
              </div>
            ) : (
              <BrainGraph3D
                notes={notes}
                onOpenNote={(id) => {
                  setSelectedItem(null);
                  setSelectedId(id);
                }}
                onOpenItem={(n) => {
                  if (n.kind === 'file' || n.kind === 'device' || n.kind === 'folder' || n.kind === 'cloud') {
                    setSelectedId(null);
                    setSelectedItem(n);
                  }
                }}
                extra={extra}
                heightClass="h-[62vh] min-h-[380px]"
              />
            )}
          </div>

          <aside className="min-w-0 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 xl:max-h-[calc(62vh+80px)] overflow-y-auto">
            {selectedItem ? (
              <div className="space-y-3">
                <div className="flex items-start gap-2">
                  <span className="mt-1 w-3 h-3 rounded-full shrink-0" style={{ background: selectedItem.kind === 'file' ? fileColor(selectedItem.label) : '#818cf8' }} />
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-slate-900 dark:text-slate-100 break-words">{selectedItem.label}</p>
                    <p className="text-[11px] text-slate-500 capitalize">{selectedItem.kind}</p>
                  </div>
                  <button type="button" aria-label="Close" onClick={() => setSelectedItem(null)} className="p-1 rounded text-slate-400 hover:text-slate-600">
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <dl className="text-xs space-y-1.5">
                  {selectedItem.meta?.device && (
                    <div className="flex gap-2"><dt className="text-slate-500 w-16 shrink-0">Device</dt><dd className="text-slate-800 dark:text-slate-200">{selectedItem.meta.device}{selectedItem.meta.online === false ? ' (offline)' : ''}</dd></div>
                  )}
                  {selectedItem.meta?.path && (
                    <div className="flex gap-2"><dt className="text-slate-500 w-16 shrink-0">Path</dt><dd className="text-slate-800 dark:text-slate-200 break-all font-mono text-[11px]">{selectedItem.meta.path}</dd></div>
                  )}
                  {selectedItem.meta?.sizeKb != null && (
                    <div className="flex gap-2"><dt className="text-slate-500 w-16 shrink-0">Size</dt><dd className="text-slate-800 dark:text-slate-200">{selectedItem.meta.sizeKb.toLocaleString()} KB</dd></div>
                  )}
                  {selectedItem.meta?.modified && (
                    <div className="flex gap-2"><dt className="text-slate-500 w-16 shrink-0">Modified</dt><dd className="text-slate-800 dark:text-slate-200">{selectedItem.meta.modified}</dd></div>
                  )}
                </dl>
                {selectedItem.kind === 'file' && (
                  <div className="flex gap-2 pt-1">
                    {selectedItem.meta?.url ? (
                      <a href={selectedItem.meta.url} target="_blank" rel="noreferrer" className="flex-1 inline-flex items-center justify-center gap-1 h-9 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold">
                        Open in Drive <ArrowRight className="w-3.5 h-3.5" />
                      </a>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onAskRay(`Read and summarize the file "${selectedItem.meta?.path}" on ${selectedItem.meta?.device}.`)}
                        className="flex-1 h-9 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold"
                      >
                        Ask RAY to read it
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onAskRay(`Open the file "${selectedItem.meta?.path}" on ${selectedItem.meta?.device}.`)}
                      className="flex-1 h-9 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-semibold text-slate-700 dark:text-slate-200"
                    >
                      Open on device
                    </button>
                  </div>
                )}
              </div>
            ) : !selected ? (
              <div className="text-sm text-slate-500 dark:text-slate-400 space-y-3">
                <p className="font-semibold text-slate-900 dark:text-slate-100">Reading panel</p>
                <p>Click any coloured node to read the note here. Grey nodes are tags or links to notes that don’t exist yet.</p>
                <ul className="text-xs space-y-1">
                  <li>· Drag to orbit, scroll to zoom</li>
                  <li>· “Tags” toggles #tag nodes</li>
                  <li>· Type in “Highlight…” to find notes</li>
                </ul>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-start gap-2">
                  <FileText className="w-4 h-4 mt-0.5 text-blue-500 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-slate-900 dark:text-slate-100 break-words">{selected.title}</p>
                    <p className="text-[11px] text-slate-500">
                      {selected.folder} · updated {new Date(selected.updatedAt).toLocaleDateString()}
                    </p>
                  </div>
                  <button type="button" aria-label="Close note" onClick={() => setSelectedId(null)} className="p-1 rounded text-slate-400 hover:text-slate-600">
                    <X className="w-4 h-4" />
                  </button>
                </div>
                {selected.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {selected.tags.map((t) => (
                      <span key={t} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                        #{t}
                      </span>
                    ))}
                  </div>
                )}
                <pre className="whitespace-pre-wrap break-words text-xs leading-relaxed text-slate-700 dark:text-slate-300 font-sans max-h-[40vh] overflow-y-auto">
                  {selected.content.slice(0, 4000)}
                </pre>
                {backlinks.length > 0 && (
                  <div>
                    <p className="text-[11px] font-semibold text-slate-500 flex items-center gap-1">
                      <Link2 className="w-3 h-3" /> Linked from
                    </p>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {backlinks.map((b) => (
                        <button key={b.id} type="button" onClick={() => setSelectedId(b.id)} className="text-[11px] px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-300">
                          {b.title}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="flex gap-2 pt-1">
                  <button type="button" onClick={() => onOpenInEditor(selected.id)} className="flex-1 inline-flex items-center justify-center gap-1 h-9 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold">
                    Edit note <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onAskRay(`Using my note [[${selected.title}]], `)}
                    className="flex-1 h-9 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-semibold text-slate-700 dark:text-slate-200"
                  >
                    Ask RAY
                  </button>
                </div>
              </div>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}
