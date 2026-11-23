import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Hash, Loader2, Maximize2, Minimize2, RotateCcw } from 'lucide-react';
import type { BrainNote } from '../types/relay';

interface GraphNode {
  id: string;
  label: string;
  kind: 'note' | 'tag' | 'ghost';
  folder: string;
  degree: number;
  noteId?: string;
  x?: number;
  y?: number;
  z?: number;
}
interface GraphLink {
  source: string;
  target: string;
  kind: 'wikilink' | 'tag';
}

const FOLDER_PALETTE = ['#60a5fa', '#34d399', '#f472b6', '#fbbf24', '#a78bfa', '#22d3ee', '#fb7185', '#4ade80', '#f97316', '#2dd4bf'];

function folderColor(folder: string, folders: string[]): string {
  const idx = Math.max(0, folders.indexOf(folder));
  return FOLDER_PALETTE[idx % FOLDER_PALETTE.length];
}

/**
 * Obsidian-style 3D knowledge graph: every note, every [[wikilink]] and every #tag,
 * clustered by folder. Unresolved links show as faint "ghost" notes (like Obsidian).
 */
export function BrainGraph3D({
  notes,
  onOpenNote,
  showTags = true,
}: {
  notes: BrainNote[];
  onOpenNote: (noteId: string) => void;
  showTags?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const graphRef = useRef<any>(null);
  const fittedRef = useRef(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [tagsOn, setTagsOn] = useState(showTags);
  const [hover, setHover] = useState<GraphNode | null>(null);
  const [query, setQuery] = useState('');

  const data = useMemo(() => {
    const folders = Array.from(new Set(notes.map((n) => n.folder || 'General'))).sort();
    const byTitle = new Map(notes.map((n) => [n.title.toLowerCase(), n]));
    const nodes = new Map<string, GraphNode>();
    const links: GraphLink[] = [];
    for (const n of notes) {
      nodes.set(n.id, { id: n.id, label: n.title, kind: 'note', folder: n.folder || 'General', degree: 0, noteId: n.id });
    }
    for (const n of notes) {
      for (const l of n.links || []) {
        const target = byTitle.get(l.toLowerCase());
        let targetId = target?.id;
        if (!targetId) {
          targetId = `ghost:${l.toLowerCase()}`;
          if (!nodes.has(targetId)) nodes.set(targetId, { id: targetId, label: l, kind: 'ghost', folder: '(unresolved)', degree: 0 });
        }
        if (targetId !== n.id) links.push({ source: n.id, target: targetId, kind: 'wikilink' });
      }
      if (tagsOn) {
        for (const t of n.tags || []) {
          const tid = `tag:${t}`;
          if (!nodes.has(tid)) nodes.set(tid, { id: tid, label: `#${t}`, kind: 'tag', folder: '#tags', degree: 0 });
          links.push({ source: n.id, target: tid, kind: 'tag' });
        }
      }
    }
    for (const l of links) {
      nodes.get(l.source)!.degree++;
      nodes.get(l.target)!.degree++;
    }
    return { nodes: Array.from(nodes.values()), links, folders };
  }, [notes, tagsOn]);

  // Create graph once
  useEffect(() => {
    let disposed = false;
    const el = containerRef.current;
    if (!el) return;
    setLoading(true);
    import('3d-force-graph')
      .then(({ default: ForceGraph3D }) => {
        if (disposed || !containerRef.current) return;
        const isDark = document.documentElement.classList.contains('dark') || window.matchMedia('(prefers-color-scheme: dark)').matches;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const g = new (ForceGraph3D as any)(el, { controlType: 'orbit' })
          .width(el.clientWidth || 600)
          .height(el.clientHeight || 520)
          .backgroundColor(isDark ? '#020617' : '#f8fafc')
          .showNavInfo(false)
          .nodeRelSize(4)
          .linkOpacity(0.35)
          .linkDirectionalParticles((l: GraphLink) => (l.kind === 'wikilink' ? 2 : 0))
          .linkDirectionalParticleWidth(1.4)
          .linkDirectionalParticleSpeed(0.006)
          .cooldownTicks(160)
          .onEngineStop(() => {
            if (!fittedRef.current) {
              fittedRef.current = true;
              g.zoomToFit(500, 30);
            }
          })
          .onNodeHover((n: GraphNode | null) => {
            el.style.cursor = n && n.kind === 'note' ? 'pointer' : 'grab';
            setHover(n);
          })
          .onNodeClick((n: GraphNode) => {
            if (n.kind === 'note' && n.noteId) onOpenNote(n.noteId);
            const dist = 90;
            const r = 1 + dist / Math.hypot(n.x || 1, n.y || 1, n.z || 1);
            g.cameraPosition({ x: (n.x || 0) * r, y: (n.y || 0) * r, z: (n.z || 0) * r }, n, 900);
          });
        g.d3Force('charge')?.strength(-70);
        graphRef.current = g;
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to load 3D engine');
        setLoading(false);
      });
    const ro = new ResizeObserver(() => {
      if (graphRef.current && containerRef.current) {
        graphRef.current.width(containerRef.current.clientWidth).height(containerRef.current.clientHeight);
      }
    });
    ro.observe(el);
    return () => {
      disposed = true;
      ro.disconnect();
      try {
        graphRef.current?._destructor?.();
      } catch {
        // ignore
      }
      graphRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push data + styling whenever notes / search change
  useEffect(() => {
    const g = graphRef.current;
    if (!g) return;
    const q = query.trim().toLowerCase();
    const isDark = document.documentElement.classList.contains('dark') || window.matchMedia('(prefers-color-scheme: dark)').matches;
    g.nodeVal((n: GraphNode) => (n.kind === 'note' ? 1.5 + Math.min(10, n.degree) : n.kind === 'tag' ? 1 + Math.min(4, n.degree / 2) : 0.8))
      .nodeColor((n: GraphNode) => {
        const dim = q && !n.label.toLowerCase().includes(q);
        if (dim) return isDark ? '#1e293b' : '#e2e8f0';
        if (n.kind === 'tag') return '#94a3b8';
        if (n.kind === 'ghost') return isDark ? '#475569' : '#cbd5e1';
        return folderColor(n.folder, data.folders);
      })
      .nodeLabel((n: GraphNode) => `<div style="font:12px system-ui;padding:4px 8px;border-radius:6px;background:rgba(15,23,42,.9);color:#e2e8f0">${n.label.replace(/</g, '&lt;')}<br/><span style="opacity:.6">${n.kind === 'note' ? n.folder : n.kind === 'tag' ? 'tag' : 'not created yet'} · ${n.degree} links</span></div>`)
      .linkColor((l: GraphLink) => (l.kind === 'tag' ? (isDark ? '#334155' : '#cbd5e1') : isDark ? '#60a5fa' : '#3b82f6'))
      .linkWidth((l: GraphLink) => (l.kind === 'wikilink' ? 0.8 : 0.2))
      .graphData({ nodes: data.nodes.map((n) => ({ ...n })), links: data.links.map((l) => ({ ...l })) });
    fittedRef.current = false;
  }, [data, query, loading]);

  const noteCount = data.nodes.filter((n) => n.kind === 'note').length;
  const linkCount = data.links.filter((l) => l.kind === 'wikilink').length;

  return (
    <div className={fullscreen ? 'fixed inset-0 z-50 bg-slate-950 p-3' : 'relative'}>
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
          <Box className="w-4 h-4 text-cyan-500" />
          3D Knowledge Graph
          <span className="text-xs font-normal text-slate-500">
            {noteCount} notes · {linkCount} links{tagsOn ? ` · ${data.nodes.filter((n) => n.kind === 'tag').length} tags` : ''}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Highlight…"
            className="h-8 w-36 px-2.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
          />
          <button
            type="button"
            onClick={() => setTagsOn((v) => !v)}
            className={`h-8 px-2.5 inline-flex items-center gap-1 text-xs rounded-lg border ${
              tagsOn ? 'border-cyan-500/50 text-cyan-600 dark:text-cyan-300 bg-cyan-500/10' : 'border-slate-200 dark:border-slate-700 text-slate-500'
            }`}
          >
            <Hash className="w-3.5 h-3.5" /> Tags
          </button>
          <button
            type="button"
            aria-label="Reset camera"
            onClick={() => graphRef.current?.zoomToFit(600, 40)}
            className="h-8 w-8 inline-flex items-center justify-center rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
            onClick={() => setFullscreen((v) => !v)}
            className="h-8 w-8 inline-flex items-center justify-center rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500"
          >
            {fullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      <div className="relative rounded-xl overflow-hidden border border-slate-200 dark:border-slate-800">
        <div ref={containerRef} className={fullscreen ? 'h-[calc(100vh-70px)] w-full' : 'h-[520px] w-full'} />
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-slate-500 gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading 3D engine…
          </div>
        )}
        {error && <div className="absolute inset-0 flex items-center justify-center text-sm text-red-500">{error}</div>}
        <div className="absolute left-3 bottom-3 flex flex-wrap gap-x-3 gap-y-1 max-w-[70%] text-[11px] text-slate-500 dark:text-slate-400 pointer-events-none">
          {data.folders.slice(0, 8).map((f) => (
            <span key={f} className="inline-flex items-center gap-1">
              <span className="w-2 h-2 rounded-full" style={{ background: folderColor(f, data.folders) }} />
              {f}
            </span>
          ))}
        </div>
        {hover && (
          <div className="absolute right-3 bottom-3 text-[11px] px-2 py-1 rounded-md bg-slate-900/80 text-slate-200 pointer-events-none">
            {hover.kind === 'note' ? 'Click to open' : hover.kind === 'ghost' ? 'Linked but not created yet' : 'Tag'}
          </div>
        )}
      </div>
      <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
        Drag to orbit · scroll to zoom · click a note to open it. Notes are saved to RAY&apos;s cloud storage (Google Cloud Storage when configured) and mirror to your Obsidian vault via the bridge.
      </p>
    </div>
  );
}
