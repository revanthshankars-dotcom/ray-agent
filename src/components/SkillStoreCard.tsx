import { useEffect, useRef, useState } from 'react';
import { authFetch } from '../utils/roomAuth';

interface InstalledSkill { id: string; title: string; summary?: string; creator?: string }
interface CatalogSkill { slug: string; title: string; summary: string; creator: string; why?: string }
interface SkillsData {
  installed: InstalledSkill[];
  recommended: Array<CatalogSkill & { why: string }>;
  results: CatalogSkill[];
  catalogError?: string | null;
}

export function SkillStoreCard({ roomId }: { roomId: string }) {
  const [data, setData] = useState<SkillsData | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = (search = '') =>
    authFetch(roomId, `/api/skills?room=${encodeURIComponent(roomId)}&q=${encodeURIComponent(search)}`)
      .then((r) => r.json() as Promise<SkillsData>)
      .then(setData)
      .catch(() => undefined);

  useEffect(() => { void load(); }, [roomId]);

  const onSearch = (v: string) => {
    setQ(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => load(v), 350);
  };

  const install = async (slug: string) => {
    setBusy(slug); setMsg('');
    try {
      const r = await authFetch(roomId, '/api/skills/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roomId, slug }) });
      const j = await r.json() as { results: Array<{ ok: boolean; message: string }> };
      setMsg(j.results[0]?.message || 'Done.');
    } catch { setMsg('Could not install.'); }
    setBusy(null);
    void load(q);
  };

  const remove = async (id: string) => {
    setBusy(id); setMsg('');
    try {
      await authFetch(roomId, '/api/skills/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roomId, id }) });
      setMsg('Removed.');
    } catch { setMsg('Could not remove.'); }
    setBusy(null);
    void load(q);
  };

  const installed = data?.installed || [];
  const recommended = (q ? data?.results : data?.recommended) || [];
  const isInstalled = (slug: string) => installed.some((s) => s.id === slug || s.title.toLowerCase() === slug.toLowerCase());

  return (
    <div className="mt-4">
      <div className="flex items-center justify-between mb-2">
        <p className="text-[11px] font-semibold uppercase tracking-widest text-blue-600 dark:text-blue-400">Skill Store</p>
        {msg && <span className="text-[11px] text-slate-500 dark:text-slate-400">{msg}</span>}
      </div>

      {/* Search */}
      <input
        type="search"
        placeholder="Search Orbit skills…"
        value={q}
        onChange={(e) => onSearch(e.target.value)}
        className="w-full text-sm rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 mb-3 outline-none focus:ring-2 focus:ring-blue-500/40 text-slate-900 dark:text-slate-100 placeholder:text-slate-400"
      />

      {/* Installed */}
      {!q && installed.length > 0 && (
        <div className="mb-3">
          <p className="text-[11px] text-slate-500 dark:text-slate-400 mb-1.5">Installed ({installed.length})</p>
          <div className="flex flex-col gap-2">
            {installed.map((s) => (
              <div key={s.id} className="flex items-start justify-between gap-2 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-100 dark:border-slate-700/50 px-3 py-2.5">
                <div className="min-w-0">
                  <p className="text-[13px] font-semibold text-slate-900 dark:text-slate-100 truncate">{s.title}</p>
                  {s.summary && <p className="text-[12px] text-slate-500 dark:text-slate-400 mt-0.5 line-clamp-2">{s.summary}</p>}
                  {s.creator && <p className="text-[11px] text-slate-400 mt-0.5">by {s.creator}</p>}
                </div>
                <button
                  type="button"
                  disabled={busy === s.id}
                  onClick={() => remove(s.id)}
                  className="text-[11px] font-semibold text-red-500 hover:text-red-600 shrink-0 mt-0.5 disabled:opacity-40"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Catalog results / recommendations */}
      {recommended.length > 0 && (
        <div>
          <p className="text-[11px] text-slate-500 dark:text-slate-400 mb-1.5">{q ? `Results for "${q}"` : 'Recommended'}</p>
          <div className="flex flex-col gap-2">
            {recommended.map((s) => {
              const already = isInstalled(s.slug);
              return (
                <div key={s.slug} className="flex items-start justify-between gap-2 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="text-[13px] font-semibold text-slate-900 dark:text-slate-100 truncate">{s.title}</p>
                    <p className="text-[12px] text-slate-500 dark:text-slate-400 mt-0.5 line-clamp-2">{s.why || s.summary}</p>
                    <p className="text-[11px] text-slate-400 mt-0.5">by {s.creator}</p>
                  </div>
                  {!already && (
                    <button
                      type="button"
                      disabled={busy === s.slug}
                      onClick={() => install(s.slug)}
                      className="text-[11px] font-semibold text-blue-600 dark:text-blue-400 hover:underline shrink-0 mt-0.5 disabled:opacity-40"
                    >
                      {busy === s.slug ? 'Installing…' : 'Install'}
                    </button>
                  )}
                  {already && <span className="text-[11px] text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5">✓ On</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {data?.catalogError && (
        <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-2">Catalog unavailable: {data.catalogError}</p>
      )}
      {!q && !installed.length && !recommended.length && data && (
        <p className="text-[12px] text-slate-500 dark:text-slate-400">Search above to find skills, or type "install skill" in chat to browse by voice.</p>
      )}
    </div>
  );
}
