import { useMemo, useState } from 'react';
import { ArrowRight, FileText, Link2, Sparkles, X } from 'lucide-react';
import type { BrainNote } from '../types/relay';
import { BrainGraph3D } from './BrainGraph3D';

/**
 * Full-page 3D Second Brain: the whole knowledge graph, with a reading panel for the
 * clicked note (backlinks included) — RAY's Obsidian-style "graph view".
 */
export function Brain3DView({
  notes,
  onOpenInEditor,
  onAskRay,
}: {
  notes: BrainNote[];
  onOpenInEditor: (noteId: string) => void;
  onAskRay: (prompt: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
              Every note, [[wikilink]] and #tag in one space. Click a node to read it.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-[1fr_360px] gap-3">
          <div className="min-w-0 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3">
            {notes.length === 0 ? (
              <div className="h-[60vh] flex flex-col items-center justify-center text-center gap-2 text-slate-500">
                <Sparkles className="w-6 h-6 text-cyan-500" />
                <p className="text-sm">Your brain is empty. Ask RAY to “remember…” something or create a note in Second Brain.</p>
              </div>
            ) : (
              <BrainGraph3D notes={notes} onOpenNote={setSelectedId} heightClass="h-[62vh] min-h-[380px]" />
            )}
          </div>

          <aside className="min-w-0 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 xl:max-h-[calc(62vh+80px)] overflow-y-auto">
            {!selected ? (
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
