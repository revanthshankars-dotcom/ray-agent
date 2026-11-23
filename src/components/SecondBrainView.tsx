import { BrainGraph3D } from './BrainGraph3D';
import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowUpRight,
  Blocks,
  BookOpen,
  Calendar,
  CheckCircle2,
  Download,
  ExternalLink,
  FileText,
  Folder,
  FolderSync,
  GitFork,
  Globe,
  Hash,
  KeyRound,
  Link2,
  Network,
  Plus,
  RefreshCw,
  Save,
  Search,
  Sparkles,
  Trash2,
} from 'lucide-react';
import type { AppConnector, BrainNote } from '../types/relay';
import { playHudSound } from '../utils/hudAudio';
import { authFetch } from '../utils/roomAuth';

interface SecondBrainViewProps {
  roomId: string;
  notes: BrainNote[];
  hasBridgeOnline: boolean;
  googleAccessToken: string | null;
  notionToken: string;
  connectors: AppConnector[];
  onConnectGoogleWorkspace: () => Promise<string | null>;
  onSaveConnector: (connector: AppConnector) => Promise<void> | void;
  onSaveNote: (note: BrainNote) => Promise<void> | void;
  onDeleteNote: (noteId: string) => Promise<void> | void;
  onAskJarvis: (prompt: string) => void;
  onOpenAppsTab: () => void;
}

const GOOGLE_BRAIN_APPS = [
  { id: 'gmail', name: 'Gmail', action: 'gmail_list_messages', folder: 'Apps/Google', tag: 'gmail' },
  { id: 'calendar', name: 'Google Calendar', action: 'calendar_list_events', folder: 'Apps/Google', tag: 'calendar' },
  { id: 'drive', name: 'Google Drive', action: 'drive_search_files', folder: 'Apps/Google', tag: 'drive' },
  { id: 'docs', name: 'Google Docs', action: 'drive_search_files', folder: 'Apps/Google', tag: 'docs' },
  { id: 'sheets', name: 'Google Sheets', action: 'drive_search_files', folder: 'Apps/Google', tag: 'sheets' },
  { id: 'tasks', name: 'Google Tasks', action: 'tasks_list_tasks', folder: 'Apps/Google', tag: 'tasks' },
  { id: 'contacts', name: 'Google Contacts', action: 'contacts_search', folder: 'Apps/Google', tag: 'contacts' },
] as const;

const FREE_EXTERNAL_APPS: Array<{
  name: string;
  category: AppConnector['category'];
  connectorType: AppConnector['connectorType'];
  endpointOrTarget: string;
  description: string;
}> = [
  {
    name: 'Brave Browser',
    category: 'browser',
    connectorType: 'url_template',
    endpointOrTarget: 'https://search.brave.com/search?q={{query}}',
    description: 'Privacy-first web research linked straight into Brain notes.',
  },
  {
    name: 'Notion',
    category: 'notes',
    connectorType: 'notion',
    endpointOrTarget: 'https://api.notion.com/v1/search',
    description: 'Pull Notion pages into Obsidian Markdown notes via integration token.',
  },
  {
    name: 'NotebookLM',
    category: 'notes',
    connectorType: 'url_template',
    endpointOrTarget: 'https://notebooklm.google.com/',
    description: 'Deep AI notebook companion linked to [[External Apps Hub]].',
  },
  {
    name: 'WhatsApp',
    category: 'social',
    connectorType: 'url_template',
    endpointOrTarget: 'https://wa.me/{{phone}}?text={{text}}',
    description: 'Zero-fee quick WhatsApp handoff & message notes.',
  },
  {
    name: 'Instagram',
    category: 'social',
    connectorType: 'url_template',
    endpointOrTarget: 'https://www.instagram.com/',
    description: 'Save creator references and links into your Brain.',
  },
];

const NOTE_TEMPLATES: Array<{ label: string; folder: string; buildContent: (title: string) => string }> = [
  {
    label: 'Daily Note',
    folder: 'Daily',
    buildContent: (title) =>
      `# ${title}\n\nLinked to [[Ray Second Brain]] and [[Google Workspace Hub]].\n\n## Priorities\n- [ ] Review [[Gmail]] & [[Google Calendar]]\n- [ ] Capture new insights with \`[[Wikilinks]]\`\n\n## Log\n\n#daily #ray`,
  },
  {
    label: 'Project Architecture',
    folder: 'Projects',
    buildContent: (title) =>
      `# ${title}\n\nParent: [[Ray Second Brain]]\n\n## Objective\nDescribe the architecture and outcomes here.\n\n## Tasks\n- [ ] Design core schema\n- [ ] Wire [[Google Drive]] & [[Notion]] specs\n\n#project #architecture`,
  },
  {
    label: 'Meeting / App Digest',
    folder: 'Apps',
    buildContent: (title) =>
      `# ${title}\n\nSources: [[Google Calendar]] · [[Gmail]] · [[Google Tasks]]\n\n## Key Takeaways\n- \n\n## Action Items\n- [ ] Follow up\n\n#digest #apps`,
  },
];

function slugify(title: string): string {
  return (
    (title || 'untitled')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || `note-${Date.now()}`
  );
}

function parseWikilinks(text: string): string[] {
  const out = new Set<string>();
  const re = /\[\[([^\]]{1,120})\]\]/g;
  let m: RegExpExecArray | null = null;
  while ((m = re.exec(text)) !== null) {
    const clean = m[1].split('|')[0].trim();
    if (clean) out.add(clean);
  }
  return Array.from(out);
}

function parseTags(text: string): string[] {
  const out = new Set<string>();
  const re = /(?:^|\s)#([a-zA-Z0-9_-]{2,40})/g;
  let m: RegExpExecArray | null = null;
  while ((m = re.exec(text)) !== null) {
    out.add(m[1].toLowerCase());
  }
  return Array.from(out);
}

function countChecklist(content: string): { done: number; total: number } {
  const matches = content.match(/^\s*-\s+\[([ xX])\]/gm) || [];
  let done = 0;
  for (const m of matches) {
    if (/\[[xX]\]/.test(m)) done++;
  }
  return { done, total: matches.length };
}

export const SecondBrainView: React.FC<SecondBrainViewProps> = ({
  roomId,
  notes,
  hasBridgeOnline,
  googleAccessToken,
  notionToken,
  connectors,
  onConnectGoogleWorkspace,
  onSaveConnector,
  onSaveNote,
  onDeleteNote,
  onAskJarvis,
  onOpenAppsTab,
}) => {
  const [selectedId, setSelectedId] = useState<string>(() => notes[0]?.id || '');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedFolder, setSelectedFolder] = useState<string>('all');
  const [selectedTag, setSelectedTag] = useState<string>('all');
  const [viewMode, setViewMode] = useState<'split' | 'edit' | 'preview' | 'graph' | '3d'>('split');
  const [showAppsRail, setShowAppsRail] = useState(true);
  const [showLocalSync, setShowLocalSync] = useState(false);

  const activeNote = useMemo(
    () => notes.find((n) => n.id === selectedId) || notes[0] || null,
    [notes, selectedId]
  );

  const [draftTitle, setDraftTitle] = useState('');
  const [draftFolder, setDraftFolder] = useState('Notes');
  const [draftContent, setDraftContent] = useState('');
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [busyApp, setBusyApp] = useState<string | null>(null);
  const [hoveredGraphNode, setHoveredGraphNode] = useState<string | null>(null);
  const [semanticMode, setSemanticMode] = useState(false);
  const [semanticLoading, setSemanticLoading] = useState(false);
  const [semanticMatches, setSemanticMatches] = useState<Array<{ id: string; score: number }>>([]);
  const [captureUrlInput, setCaptureUrlInput] = useState('');
  const [capturingUrl, setCapturingUrl] = useState(false);

  useEffect(() => {
    if (activeNote && editingNoteId !== activeNote.id) {
      setEditingNoteId(activeNote.id);
      setDraftTitle(activeNote.title);
      setDraftFolder(activeNote.folder || 'Notes');
      setDraftContent(activeNote.content);
    } else if (!activeNote && editingNoteId !== null) {
      setEditingNoteId(null);
      setDraftTitle('');
      setDraftFolder('Notes');
      setDraftContent('');
    }
  }, [activeNote, editingNoteId]);

  const folders = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of notes) {
      const f = n.folder || 'Notes';
      counts.set(f, (counts.get(f) || 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [notes]);

  const allTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of notes) {
      for (const t of n.tags || []) {
        counts.set(t, (counts.get(t) || 0) + 1);
      }
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [notes]);

  const semanticScoreMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const item of semanticMatches) {
      m.set(item.id, item.score);
    }
    return m;
  }, [semanticMatches]);

  const runSemanticSearch = async (queryText: string) => {
    const q = queryText.trim();
    if (!q) {
      setSemanticMatches([]);
      return;
    }
    setSemanticLoading(true);
    try {
      const res = await authFetch('/api/brain/semantic-search', roomId, {
        method: 'POST',
        body: JSON.stringify({
          roomId,
          query: q,
          notes: notes.map((n) => ({
            id: n.id,
            title: n.title,
            folder: n.folder,
            content: n.content,
            tags: n.tags,
          })),
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        matches?: Array<{ id: string; score: number }>;
      };
      if (res.ok && Array.isArray(data.matches)) {
        setSemanticMatches(data.matches);
      }
    } finally {
      setSemanticLoading(false);
    }
  };

  useEffect(() => {
    if (!semanticMode) {
      setSemanticMatches([]);
      return;
    }
    const q = searchQuery.trim();
    if (!q) {
      setSemanticMatches([]);
      return;
    }
    const id = window.setTimeout(() => {
      void runSemanticSearch(q);
    }, 350);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [semanticMode, searchQuery, notes.length]);

  const filteredNotes = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const base = notes.filter((n) => {
      if (selectedFolder !== 'all' && (n.folder || 'Notes') !== selectedFolder) return false;
      if (selectedTag !== 'all' && !(n.tags || []).includes(selectedTag)) return false;
      if (!q) return true;
      if (semanticMode && semanticMatches.length > 0) {
        return semanticScoreMap.has(n.id);
      }
      return (
        n.title.toLowerCase().includes(q) ||
        n.content.toLowerCase().includes(q) ||
        n.folder.toLowerCase().includes(q) ||
        (n.tags || []).some((t) => t.includes(q.replace(/^#/, '')))
      );
    });
    if (semanticMode && semanticMatches.length > 0) {
      return [...base].sort(
        (a, b) => (semanticScoreMap.get(b.id) || 0) - (semanticScoreMap.get(a.id) || 0)
      );
    }
    return base;
  }, [notes, searchQuery, selectedFolder, selectedTag, semanticMode, semanticMatches.length, semanticScoreMap]);

  const backlinks = useMemo(() => {
    if (!activeNote) return [];
    const targetLower = activeNote.title.toLowerCase();
    return notes.filter(
      (n) =>
        n.id !== activeNote.id &&
        (n.links || []).some((l) => l.toLowerCase() === targetLower)
    );
  }, [notes, activeNote]);

  const saveAndPersistNote = async (note: BrainNote) => {
    await onSaveNote(note);
    await authFetch('/api/brain/notes', roomId, {
      method: 'POST',
      body: JSON.stringify({ roomId, note }),
    }).catch(() => {});
  };

  const handleCreateNote = async (
    presetTitle?: string,
    presetFolder = 'Notes',
    presetContent?: string
  ) => {
    const now = Date.now();
    const title = (presetTitle || `Note ${notes.length + 1}`).trim();
    const existing = notes.find((n) => n.title.toLowerCase() === title.toLowerCase());
    if (existing) {
      setSelectedId(existing.id);
      if (viewMode === 'graph') setViewMode('split');
      return existing;
    }

    const content =
      presetContent ??
      `# ${title}\n\nConnected to [[Ray Second Brain]].\n\n- [ ] Add notes or link apps like [[Gmail]], [[Notion]], [[Brave Browser]]\n\n#notes`;
    const newNote: BrainNote = {
      id: `note-${now}-${Math.random().toString(36).slice(2, 6)}`,
      title,
      slug: slugify(title),
      folder: presetFolder,
      content,
      tags: parseTags(content),
      links: parseWikilinks(content),
      source: 'user',
      createdAt: now,
      updatedAt: now,
    };
    setSelectedId(newNote.id);
    setEditingNoteId(newNote.id);
    setDraftTitle(newNote.title);
    setDraftFolder(newNote.folder);
    setDraftContent(newNote.content);
    await saveAndPersistNote(newNote);
    playHudSound('blip');
    return newNote;
  };

  const handleOpenTodayNote = async () => {
    const today = new Date().toISOString().slice(0, 10);
    const tpl = NOTE_TEMPLATES[0];
    await handleCreateNote(today, tpl.folder, tpl.buildContent(`Daily Note — ${today}`));
    if (viewMode === 'graph') setViewMode('split');
  };

  const handleSaveCurrent = async (overrideContent?: string) => {
    if (!draftTitle.trim()) return;
    const contentToSave = overrideContent ?? draftContent;
    const now = Date.now();
    const title = draftTitle.trim();
    const tags = parseTags(contentToSave);
    const links = parseWikilinks(contentToSave);
    const saved: BrainNote = {
      id: activeNote?.id || `note-${now}-${Math.random().toString(36).slice(2, 6)}`,
      title,
      slug: slugify(title),
      folder: draftFolder.trim() || 'Notes',
      content: contentToSave,
      tags,
      links,
      source: activeNote?.source || 'user',
      createdAt: activeNote?.createdAt || now,
      updatedAt: now,
    };
    await saveAndPersistNote(saved);
    playHudSound('affirmative');
    setStatusMessage(`Saved "[[${saved.title}]]" (${links.length} links, ${tags.length} tags).`);
  };

  const handleToggleChecklistLine = async (lineIndex: number) => {
    const lines = draftContent.split('\n');
    const line = lines[lineIndex];
    if (line === undefined) return;
    if (/^\s*-\s+\[\s\]/.test(line)) {
      lines[lineIndex] = line.replace(/\[\s\]/, '[x]');
    } else if (/^\s*-\s+\[[xX]\]/.test(line)) {
      lines[lineIndex] = line.replace(/\[[xX]\]/, '[ ]');
    } else {
      return;
    }
    const nextContent = lines.join('\n');
    setDraftContent(nextContent);
    await handleSaveCurrent(nextContent);
  };

  const handleOpenWikilink = async (targetTitle: string) => {
    const match = notes.find(
      (n) => n.title.toLowerCase() === targetTitle.toLowerCase() || n.slug === slugify(targetTitle)
    );
    if (match) {
      setSelectedId(match.id);
      if (viewMode === 'graph') setViewMode('split');
    } else {
      await handleCreateNote(targetTitle);
      if (viewMode === 'graph') setViewMode('split');
    }
  };

  const handleInsertWikilink = (targetName: string) => {
    const token = `[[${targetName}]]`;
    if (!draftContent.includes(token)) {
      setDraftContent((prev) => (prev ? `${prev}\n- Linked: ${token}` : token));
    }
    playHudSound('blip');
  };

  const handlePullGoogleAppToBrain = async (app: (typeof GOOGLE_BRAIN_APPS)[number]) => {
    if (!googleAccessToken) {
      setStatusMessage(`Authorize Google Workspace when ready to sync ${app.name} into your Second Brain.`);
      return;
    }
    setBusyApp(app.id);
    setStatusMessage(null);
    try {
      const res = await authFetch(
        '/api/workspace/execute',
        roomId,
        {
          method: 'POST',
          body: JSON.stringify({ roomId, action: app.action, args: { query: '' } }),
        },
        { googleAccessToken }
      );
      const data = (await res.json()) as { result?: string; error?: string };
      if (!res.ok) throw new Error(data.error || `Failed to read ${app.name}`);

      const stamp = new Date().toLocaleString();
      const today = new Date().toISOString().slice(0, 10);
      const existing = notes.find((n) => n.title.toLowerCase() === app.name.toLowerCase());
      const content =
        `# ${app.name}\n\nSynced into [[Ray Second Brain]] · [[Google Workspace Hub]] · [[${today}]]\n_Updated: ${stamp}_\n\n## Live Data\n\`\`\`\n${(data.result || 'No items found.').slice(0, 4000)}\n\`\`\`\n\n#apps #google #${app.tag}`;
      const note: BrainNote = {
        id: existing?.id || `note-app-${app.id}-${Date.now()}`,
        title: app.name,
        slug: slugify(app.name),
        folder: app.folder,
        content,
        tags: parseTags(content),
        links: parseWikilinks(content),
        source: 'jarvis',
        createdAt: existing?.createdAt || Date.now(),
        updatedAt: Date.now(),
      };
      await saveAndPersistNote(note);
      setSelectedId(note.id);
      if (viewMode === 'graph') setViewMode('split');
      playHudSound('affirmative');
      setStatusMessage(`Captured ${app.name} directly into Second Brain note "[[${app.name}]]".`);
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : `Failed to sync ${app.name}`);
    } finally {
      setBusyApp(null);
    }
  };

  const handleLinkExternalAppToBrain = async (
    appDef: (typeof FREE_EXTERNAL_APPS)[number],
    captureFromNotion = false
  ) => {
    setBusyApp(appDef.name);
    setStatusMessage(null);
    try {
      // Ensure connector is registered for RAY if missing
      let conn = connectors.find((c) => c.name.toLowerCase() === appDef.name.toLowerCase());
      if (!conn) {
        const now = Date.now();
        conn = {
          id: `conn-${now}-${Math.random().toString(36).slice(2, 6)}`,
          name: appDef.name,
          category: appDef.category,
          connectorType: appDef.connectorType,
          endpointOrTarget: appDef.endpointOrTarget,
          method: appDef.connectorType === 'notion' ? 'POST' : 'LAUNCH',
          description: appDef.description,
          headersJson: '{}',
          enabled: true,
          requiresConfirmation: appDef.name === 'WhatsApp',
          createdAt: now,
          updatedAt: now,
        };
        await onSaveConnector(conn);
      }

      let bodyDetails = appDef.description;
      if (captureFromNotion && conn.connectorType === 'notion') {
        if (!notionToken.trim()) {
          setStatusMessage('Enter your Notion token in the Apps tab to pull live Notion pages into your Brain.');
          return;
        }
        const res = await authFetch(
          '/api/connectors/test',
          roomId,
          {
            method: 'POST',
            body: JSON.stringify({ roomId, connector: conn, args: { query: '' }, confirmed: true }),
          },
          { notionToken }
        );
        const data = (await res.json()) as { result?: string; error?: string };
        if (!res.ok) throw new Error(data.error || 'Notion pull failed');
        bodyDetails = `## Notion Sync\n\`\`\`\n${(data.result || '').slice(0, 3500)}\n\`\`\``;
      }

      const existing = notes.find((n) => n.title.toLowerCase() === appDef.name.toLowerCase());
      const content =
        `# ${appDef.name}\n\nLinked to [[Ray Second Brain]] and [[External Apps Hub]].\n\nEndpoint: \`${appDef.endpointOrTarget}\`\n\n${bodyDetails}\n\n- [ ] Capture references from ${appDef.name}\n\n#apps #${slugify(appDef.name)}`;
      const note: BrainNote = {
        id: existing?.id || `note-ext-${slugify(appDef.name)}-${Date.now()}`,
        title: appDef.name,
        slug: slugify(appDef.name),
        folder: 'Apps/External',
        content,
        tags: parseTags(content),
        links: parseWikilinks(content),
        source: 'user',
        createdAt: existing?.createdAt || Date.now(),
        updatedAt: Date.now(),
      };
      await saveAndPersistNote(note);
      setSelectedId(note.id);
      if (viewMode === 'graph') setViewMode('split');
      playHudSound('affirmative');
      setStatusMessage(`Added ${appDef.name} into your Second Brain Knowledge Graph.`);
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : `Failed to add ${appDef.name}`);
    } finally {
      setBusyApp(null);
    }
  };

  const handleDownloadActiveMarkdown = () => {
    if (!activeNote) return;
    const blob = new Blob([draftContent], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${slugify(draftTitle || activeNote.title)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleSyncLocalFolder = async (direction: 'pull' | 'push') => {
    setSyncing(true);
    setStatusMessage(null);
    try {
      const res = await authFetch('/api/brain/sync-local', roomId, {
        method: 'POST',
        body: JSON.stringify({ roomId, direction }),
      });
      const data = (await res.json()) as {
        importedCount?: number;
        pushed?: number;
        vaultDir?: string;
        notes?: BrainNote[];
        error?: string;
      };
      if (!res.ok) throw new Error(data.error || 'Sync failed');
      if (direction === 'pull' && Array.isArray(data.notes)) {
        for (const n of data.notes) {
          await onSaveNote(n);
        }
        setStatusMessage(`Imported ${data.importedCount ?? data.notes.length} local .md files.`);
      } else {
        setStatusMessage(`Exported ${data.pushed ?? 0} notes as .md files to local folder.`);
      }
      playHudSound('affirmative');
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : 'Local folder sync failed');
    } finally {
      setSyncing(false);
    }
  };

  const handleCaptureUrlToBrain = async (e: React.FormEvent) => {
    e.preventDefault();
    const url = captureUrlInput.trim();
    if (!url || capturingUrl) return;
    setCapturingUrl(true);
    setStatusMessage(null);
    try {
      const res = await authFetch('/api/ai/read-url', roomId, {
        method: 'POST',
        body: JSON.stringify({ roomId, url, saveToBrain: true }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        title?: string;
        savedNote?: BrainNote;
        error?: string;
      };
      if (!res.ok || !data.savedNote) {
        throw new Error(data.error || 'Could not capture URL');
      }
      await onSaveNote(data.savedNote);
      setSelectedId(data.savedNote.id);
      setCaptureUrlInput('');
      if (viewMode === 'graph') setViewMode('split');
      playHudSound('affirmative');
      setStatusMessage(`Captured "${data.savedNote.title}" into Web Captures.`);
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : 'Failed to capture web URL');
    } finally {
      setCapturingUrl(false);
    }
  };

  const renderInlineTokens = (text: string) => {
    const tokens = text.split(/(\[\[[^\]]+\]\]|\*\*[^*]+\*\*|#[a-zA-Z0-9_-]{2,40}|`[^`]+`)/g);
    return tokens.map((tok, tIdx) => {
      if (tok.startsWith('[[') && tok.endsWith(']]')) {
        const target = tok.slice(2, -2).split('|')[0].trim();
        const exists = notes.some((n) => n.title.toLowerCase() === target.toLowerCase());
        return (
          <button
            key={tIdx}
            type="button"
            onClick={() => void handleOpenWikilink(target)}
            className={`inline-flex items-center gap-0.5 font-medium underline underline-offset-2 ${
              exists
                ? 'text-blue-600 dark:text-blue-400 hover:text-blue-700'
                : 'text-amber-700 dark:text-amber-400 hover:text-amber-800'
            }`}
          >
            <span>{target}</span>
            <ArrowUpRight className="w-3 h-3" />
          </button>
        );
      }
      if (tok.startsWith('**') && tok.endsWith('**')) {
        return (
          <strong key={tIdx} className="font-semibold text-slate-900 dark:text-slate-100">
            {tok.slice(2, -2)}
          </strong>
        );
      }
      if (tok.startsWith('#') && tok.length > 2) {
        return (
          <button
            key={tIdx}
            type="button"
            onClick={() => setSelectedTag(tok.slice(1).toLowerCase())}
            className="font-mono text-xs text-emerald-700 dark:text-emerald-400 hover:underline"
          >
            {tok}
          </button>
        );
      }
      if (tok.startsWith('`') && tok.endsWith('`')) {
        return (
          <code
            key={tIdx}
            className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 font-mono text-xs text-slate-900 dark:text-slate-100"
          >
            {tok.slice(1, -1)}
          </code>
        );
      }
      return <React.Fragment key={tIdx}>{tok}</React.Fragment>;
    });
  };

  const renderObsidianMarkdown = (content: string) => {
    const lines = content.split('\n');
    const elements: React.ReactNode[] = [];
    let inCodeBlock = false;
    let codeLines: string[] = [];

    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      const trimmed = line.trim();

      if (trimmed.startsWith('```')) {
        if (!inCodeBlock) {
          inCodeBlock = true;
          codeLines = [];
        } else {
          inCodeBlock = false;
          elements.push(
            <pre
              key={`code-${idx}`}
              className="p-3 rounded-lg bg-slate-900 dark:bg-slate-950 text-slate-100 font-mono text-xs overflow-x-auto border border-slate-800"
            >
              <code>{codeLines.join('\n')}</code>
            </pre>
          );
        }
        continue;
      }

      if (inCodeBlock) {
        codeLines.push(line);
        continue;
      }

      if (!trimmed) {
        elements.push(<div key={idx} className="h-2" />);
        continue;
      }

      if (trimmed.startsWith('# ')) {
        elements.push(
          <h1 key={idx} className="font-display text-xl font-bold text-slate-900 dark:text-slate-100">
            {trimmed.slice(2)}
          </h1>
        );
      } else if (trimmed.startsWith('## ')) {
        elements.push(
          <h2 key={idx} className="font-display text-base font-semibold text-slate-900 dark:text-slate-100 pt-2">
            {trimmed.slice(3)}
          </h2>
        );
      } else if (trimmed.startsWith('### ')) {
        elements.push(
          <h3 key={idx} className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100 pt-1">
            {trimmed.slice(4)}
          </h3>
        );
      } else if (trimmed.startsWith('> ')) {
        elements.push(
          <blockquote
            key={idx}
            className="border-l-2 border-blue-500 pl-3 py-1 text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-900/60 rounded-r"
          >
            {renderInlineTokens(trimmed.slice(2))}
          </blockquote>
        );
      } else if (/^-\s+\[([ xX])\]\s+/.test(trimmed)) {
        const checked = /^-\s+\[[xX]\]/.test(trimmed);
        const label = trimmed.replace(/^-\s+\[[ xX]\]\s+/, '');
        elements.push(
          <label
            key={idx}
            className="flex items-start gap-2 cursor-pointer select-none py-0.5"
          >
            <input
              type="checkbox"
              checked={checked}
              onChange={() => void handleToggleChecklistLine(idx)}
              className="mt-1 accent-blue-600 rounded"
            />
            <span className={checked ? 'line-through text-slate-400' : ''}>
              {renderInlineTokens(label)}
            </span>
          </label>
        );
      } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
        elements.push(
          <div key={idx} className="flex items-start gap-2 pl-1">
            <span className="text-blue-500 mt-1.5 text-[10px]">●</span>
            <div className="flex-1 break-words">{renderInlineTokens(trimmed.slice(2))}</div>
          </div>
        );
      } else {
        elements.push(
          <p key={idx} className="break-words">
            {renderInlineTokens(line)}
          </p>
        );
      }
    }

    return (
      <div className="space-y-1.5 text-sm leading-relaxed text-slate-800 dark:text-slate-200">
        {elements}
      </div>
    );
  };

  // Interactive Knowledge Graph combining Brain Notes + All Connected Apps
  const graphData = useMemo(() => {
    const noteItems = notes.slice(0, 24).map((n) => ({
      id: n.id,
      title: n.title,
      folder: n.folder,
      links: n.links || [],
      isApp: n.folder.startsWith('Apps'),
    }));

    // Include virtual app nodes for any connected Google/External apps mentioned in wikilinks
    const existingLower = new Set(noteItems.map((n) => n.title.toLowerCase()));
    const allVirtualAppNames = [
      ...GOOGLE_BRAIN_APPS.map((a) => a.name),
      ...FREE_EXTERNAL_APPS.map((a) => a.name),
      ...connectors.map((c) => c.name),
    ];
    for (const appName of allVirtualAppNames) {
      if (!existingLower.has(appName.toLowerCase())) {
        existingLower.add(appName.toLowerCase());
        noteItems.push({
          id: `appnode-${slugify(appName)}`,
          title: appName,
          folder: 'App Node',
          links: ['Ray Second Brain'],
          isApp: true,
        });
      }
    }

    const width = 820;
    const height = 500;
    const cx = width / 2;
    const cy = height / 2;
    const maxNodes = noteItems.slice(0, 36);

    const nodes = maxNodes.map((n, idx) => {
      if (n.title.toLowerCase() === 'ray second brain') {
        return { ...n, x: cx, y: cy };
      }
      const angle = (idx / Math.max(1, maxNodes.length)) * Math.PI * 2 - Math.PI / 2;
      const radius = n.isApp ? 205 : idx % 2 === 0 ? 135 : 95;
      return {
        ...n,
        x: cx + Math.cos(angle) * radius * 1.18,
        y: cy + Math.sin(angle) * radius * 0.92,
      };
    });

    const nodeByTitle = new Map(nodes.map((n) => [n.title.toLowerCase(), n]));
    const edges: Array<{ from: (typeof nodes)[0]; to: (typeof nodes)[0] }> = [];
    for (const n of nodes) {
      for (const link of n.links) {
        const toNode = nodeByTitle.get(link.toLowerCase());
        if (toNode && toNode.id !== n.id) {
          edges.push({ from: n, to: toNode });
        }
      }
    }

    return { width, height, nodes, edges };
  }, [notes, connectors]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[1520px] mx-auto p-4 sm:p-6 space-y-4">
        {/* Header */}
        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-3">
          <div>
            <h1 className="font-display text-xl font-bold text-slate-900 dark:text-slate-100">
              Ray&apos;s Obsidian Second Brain
            </h1>
            <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-400 mt-0.5">
              Standalone Markdown knowledge graph with folders, checklists,{' '}
              <span className="font-mono">[[wikilinks]]</span>, backlinks, and all connected apps wired straight into your notes.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center p-0.5 bg-slate-100 dark:bg-slate-800 rounded-lg">
              {(['split', 'edit', 'preview', '3d', 'graph'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setViewMode(m)}
                  className={`px-2.5 py-1.5 text-xs font-medium rounded-md capitalize transition-colors ${
                    viewMode === m
                      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  {m === 'graph' ? '2D Graph' : m === '3d' ? '3D Graph' : m}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => void handleOpenTodayNote()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg"
            >
              <Calendar className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
              <span>Daily Note</span>
            </button>

            <button
              type="button"
              onClick={() => setShowAppsRail((s) => !s)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border rounded-lg transition-colors ${
                showAppsRail
                  ? 'border-blue-600/40 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300'
                  : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200'
              }`}
            >
              <Blocks className="w-3.5 h-3.5" />
              <span>Brain Apps ({GOOGLE_BRAIN_APPS.length + FREE_EXTERNAL_APPS.length + connectors.length})</span>
            </button>

            <button
              type="button"
              onClick={() => setShowLocalSync((s) => !s)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg"
              title="Optional: mirror notes as .md files to a local computer folder"
            >
              <FolderSync className="w-3.5 h-3.5" />
              <span>Export / Sync</span>
            </button>

            <button
              type="button"
              onClick={() => void handleCreateNote()}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>New Note</span>
            </button>
          </div>
        </div>

        {/* Optional Local Folder Export/Sync Bar */}
        {showLocalSync && (
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3.5 flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="text-slate-600 dark:text-slate-300 max-w-2xl">
              <strong className="text-slate-900 dark:text-slate-100">Standalone vs. Optional Local Folder Sync:</strong>{' '}
              Your Second Brain works 100% independently right here in RAY and Firebase. If you also want{' '}
              <code className="font-mono">.md</code> copies on disk, download the current note or set{' '}
              <code className="font-mono">RELAY_VAULT_DIR</code> on your Desktop OS Bridge.
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleDownloadActiveMarkdown}
                disabled={!activeNote}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 font-medium border border-slate-200 dark:border-slate-700 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Download .md</span>
              </button>
              <button
                type="button"
                disabled={!hasBridgeOnline || syncing}
                onClick={() => void handleSyncLocalFolder('pull')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 font-medium border border-slate-200 dark:border-slate-700 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40"
              >
                <FolderSync className="w-3.5 h-3.5" />
                <span>{syncing ? 'Syncing...' : 'Pull Disk .md'}</span>
              </button>
              <button
                type="button"
                disabled={!hasBridgeOnline || syncing}
                onClick={() => void handleSyncLocalFolder('push')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 font-medium border border-slate-200 dark:border-slate-700 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40"
              >
                <BookOpen className="w-3.5 h-3.5" />
                <span>Push Disk .md</span>
              </button>
            </div>
          </div>
        )}

        {statusMessage && (
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 py-2 text-xs text-slate-700 dark:text-slate-200">
            {statusMessage}
          </div>
        )}

        {/* Capture Any Web URL Straight Into Second Brain */}
        <form
          onSubmit={handleCaptureUrlToBrain}
          className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-2.5 flex flex-col sm:flex-row items-stretch sm:items-center gap-2"
        >
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <Globe className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0 ml-1" />
            <input
              type="url"
              value={captureUrlInput}
              onChange={(e) => setCaptureUrlInput(e.target.value)}
              placeholder="Paste any https:// article or doc URL — RAY reads & saves an Obsidian note..."
              className="flex-1 min-w-0 px-2.5 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100"
            />
          </div>
          <button
            type="submit"
            disabled={capturingUrl || !captureUrlInput.trim()}
            className="inline-flex items-center justify-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg whitespace-nowrap shrink-0"
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>{capturingUrl ? 'Reading URL...' : 'Capture URL Note'}</span>
          </button>
        </form>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          {/* Vault Explorer Sidebar */}
          <section className="lg:col-span-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3.5 space-y-3">
            <div className="space-y-1.5">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-2.5" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={semanticMode ? 'Ask by meaning (AI semantic)...' : 'Search notes, folders, #tags...'}
                  className="w-full pl-8 pr-3 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100"
                />
              </div>
              <div className="flex items-center justify-between gap-2 text-[11px]">
                <button
                  type="button"
                  onClick={() => setSemanticMode((s) => !s)}
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border font-medium transition-colors ${
                    semanticMode
                      ? 'border-blue-600 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300'
                      : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                  }`}
                >
                  <Sparkles className="w-3 h-3" />
                  <span>AI Semantic Search</span>
                </button>
                {semanticLoading && (
                  <span className="text-slate-400 font-mono">Ranking...</span>
                )}
              </div>
            </div>

            {/* Templates quick create */}
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mr-1">
                Templates:
              </span>
              {NOTE_TEMPLATES.map((tpl) => (
                <button
                  key={tpl.label}
                  type="button"
                  onClick={() =>
                    void handleCreateNote(
                      `${tpl.label} ${new Date().toISOString().slice(0, 10)}`,
                      tpl.folder,
                      tpl.buildContent(tpl.label)
                    )
                  }
                  className="px-2 py-0.5 text-[11px] rounded border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  + {tpl.label}
                </button>
              ))}
            </div>

            {/* Folders */}
            <div className="flex flex-wrap gap-1">
              <button
                type="button"
                onClick={() => setSelectedFolder('all')}
                className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded border ${
                  selectedFolder === 'all'
                    ? 'border-blue-600 text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/40'
                    : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'
                }`}
              >
                <Folder className="w-2.5 h-2.5" />
                <span>All ({notes.length})</span>
              </button>
              {folders.map(([folder, count]) => (
                <button
                  key={folder}
                  type="button"
                  onClick={() => setSelectedFolder(folder === selectedFolder ? 'all' : folder)}
                  className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded border ${
                    selectedFolder === folder
                      ? 'border-blue-600 text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/40'
                      : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'
                  }`}
                >
                  <Folder className="w-2.5 h-2.5" />
                  <span>{folder}</span>
                  <span className="text-slate-400 tabular-nums">({count})</span>
                </button>
              ))}
            </div>

            {/* Tags */}
            {allTags.length > 0 && (
              <div className="flex flex-wrap gap-1 pt-1 border-t border-slate-100 dark:border-slate-800">
                {allTags.slice(0, 8).map(([tag, count]) => (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => setSelectedTag(tag === selectedTag ? 'all' : tag)}
                    className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-mono rounded border ${
                      selectedTag === tag
                        ? 'border-emerald-600 text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40'
                        : 'border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400'
                    }`}
                  >
                    <Hash className="w-2.5 h-2.5" />
                    <span>{tag}</span>
                    <span className="tabular-nums">({count})</span>
                  </button>
                ))}
              </div>
            )}

            <ul className="divide-y divide-slate-100 dark:divide-slate-800 max-h-[420px] overflow-y-auto">
              {filteredNotes.map((note) => {
                const active = activeNote?.id === note.id;
                const tasks = countChecklist(note.content);
                return (
                  <li key={note.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedId(note.id);
                        if (viewMode === 'graph') setViewMode('split');
                      }}
                      className={`w-full text-left px-2.5 py-2 rounded-lg transition-colors ${
                        active
                          ? 'bg-blue-50 dark:bg-blue-950/40'
                          : 'hover:bg-slate-50 dark:hover:bg-slate-800/40'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">
                          {note.title}
                        </span>
                        {tasks.total > 0 && (
                          <span className="text-[10px] font-mono text-emerald-700 dark:text-emerald-400 tabular-nums shrink-0">
                            {tasks.done}/{tasks.total}
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400 mt-0.5 flex items-center justify-between gap-2">
                        <span className="truncate">{note.folder}</span>
                        <span className="tabular-nums shrink-0">
                          {semanticMode && semanticScoreMap.has(note.id)
                            ? `${Math.round((semanticScoreMap.get(note.id) || 0) * 100)}% match`
                            : `${note.links?.length || 0} links`}
                        </span>
                      </div>
                    </button>
                  </li>
                );
              })}
              {filteredNotes.length === 0 && (
                <li className="py-6 text-center text-xs text-slate-500">
                  No notes match your filter.
                </li>
              )}
            </ul>
          </section>

          {/* Main Obsidian Editor / Preview / Graph */}
          <section
            className={`${
              showAppsRail ? 'lg:col-span-6' : 'lg:col-span-9'
            } rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 sm:p-5 space-y-4`}
          >
            {viewMode === '3d' ? (
              <BrainGraph3D
                notes={notes}
                onOpenNote={(id) => {
                  setSelectedId(id);
                }}
              />
            ) : viewMode === 'graph' ? (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Network className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                    <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      Obsidian Knowledge Graph ({graphData.nodes.length} nodes · {graphData.edges.length} links)
                    </h2>
                  </div>
                  <div className="flex items-center gap-3 text-[11px] text-slate-500 dark:text-slate-400">
                    <span className="inline-flex items-center gap-1">
                      <span className="w-2.5 h-2.5 rounded-full bg-blue-600 inline-block" /> Note
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <span className="w-2.5 h-2.5 rounded-full bg-emerald-600 inline-block" /> App Node
                    </span>
                  </div>
                </div>
                <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 overflow-hidden">
                  <svg
                    viewBox={`0 0 ${graphData.width} ${graphData.height}`}
                    className="w-full h-[460px] select-none"
                  >
                    {graphData.edges.map((edge, idx) => {
                      const highlighted =
                        hoveredGraphNode === edge.from.id || hoveredGraphNode === edge.to.id;
                      return (
                        <line
                          key={idx}
                          x1={edge.from.x}
                          y1={edge.from.y}
                          x2={edge.to.x}
                          y2={edge.to.y}
                          stroke="currentColor"
                          className={
                            highlighted
                              ? 'text-blue-500 dark:text-blue-400'
                              : 'text-slate-300 dark:text-slate-700'
                          }
                          strokeWidth={highlighted ? 2 : 1.2}
                        />
                      );
                    })}
                    {graphData.nodes.map((node) => {
                      const isActive = activeNote?.id === node.id;
                      return (
                        <g
                          key={node.id}
                          transform={`translate(${node.x}, ${node.y})`}
                          onMouseEnter={() => setHoveredGraphNode(node.id)}
                          onMouseLeave={() => setHoveredGraphNode(null)}
                          onClick={() => void handleOpenWikilink(node.title)}
                          className="cursor-pointer"
                        >
                          <circle
                            r={isActive ? 11 : node.isApp ? 9 : 7}
                            className={
                              isActive
                                ? 'fill-blue-600 stroke-white dark:stroke-slate-950'
                                : node.isApp
                                ? 'fill-emerald-600 dark:fill-emerald-500 hover:fill-blue-500'
                                : 'fill-slate-700 dark:fill-slate-300 hover:fill-blue-500'
                            }
                            strokeWidth={2}
                          />
                          <text
                            y={21}
                            textAnchor="middle"
                            className="text-[10px] font-medium fill-slate-700 dark:fill-slate-300"
                          >
                            {node.title.slice(0, 22)}
                          </text>
                        </g>
                      );
                    })}
                  </svg>
                </div>
              </div>
            ) : activeNote ? (
              <>
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 pb-3 border-b border-slate-200 dark:border-slate-800">
                  <div className="flex flex-wrap items-center gap-2 flex-1 min-w-0">
                    <FileText className="w-4 h-4 text-slate-400 shrink-0" />
                    <input
                      type="text"
                      value={draftTitle}
                      onChange={(e) => setDraftTitle(e.target.value)}
                      aria-label="Note title"
                      className="flex-1 min-w-[160px] px-2.5 py-1.5 text-sm font-semibold bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100"
                    />
                    <input
                      type="text"
                      value={draftFolder}
                      onChange={(e) => setDraftFolder(e.target.value)}
                      aria-label="Note folder"
                      placeholder="Folder"
                      className="w-28 px-2.5 py-1.5 text-xs font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-700 dark:text-slate-300"
                    />
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() =>
                        onAskJarvis(
                          `Read my Second Brain note "[[${draftTitle}]]", summarize key takeaways, organize checkboxes, and link relevant apps or notes.`
                        )
                      }
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                    >
                      <Sparkles className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
                      <span>Ask RAY</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleSaveCurrent()}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg"
                    >
                      <Save className="w-3.5 h-3.5" />
                      <span>Save</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void onDeleteNote(activeNote.id)}
                      aria-label="Delete note"
                      className="p-1.5 text-slate-400 hover:text-red-600 rounded-lg"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                <div
                  className={`grid gap-4 ${
                    viewMode === 'split' ? 'grid-cols-1 md:grid-cols-2' : 'grid-cols-1'
                  }`}
                >
                  {(viewMode === 'split' || viewMode === 'edit') && (
                    <textarea
                      value={draftContent}
                      onChange={(e) => setDraftContent(e.target.value)}
                      rows={18}
                      aria-label="Markdown note editor"
                      placeholder="Write Obsidian Markdown using [[Wikilinks]], - [ ] checklists, and #tags..."
                      className="w-full p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 font-mono text-xs leading-relaxed text-slate-900 dark:text-slate-100 resize-y"
                    />
                  )}

                  {(viewMode === 'split' || viewMode === 'preview') && (
                    <div className="p-4 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950/50 overflow-y-auto max-h-[420px]">
                      {renderObsidianMarkdown(draftContent)}
                    </div>
                  )}
                </div>

                <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2 text-xs">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="inline-flex items-center gap-1 text-slate-500 dark:text-slate-400 font-medium">
                      <GitFork className="w-3.5 h-3.5" />
                      Backlinks ({backlinks.length}):
                    </span>
                    {backlinks.length === 0 ? (
                      <span className="text-slate-400">
                        Mention [[{draftTitle}]] in another note to connect it
                      </span>
                    ) : (
                      backlinks.map((b) => (
                        <button
                          key={b.id}
                          type="button"
                          onClick={() => setSelectedId(b.id)}
                          className="px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-blue-600 dark:text-blue-400 font-medium hover:underline"
                        >
                          {b.title}
                        </button>
                      ))
                    )}
                  </div>
                  <span className="font-mono text-[11px] text-slate-400">
                    {draftContent.length} chars
                  </span>
                </div>
              </>
            ) : (
              <div className="py-12 text-center space-y-3">
                <p className="text-sm text-slate-600 dark:text-slate-400">
                  Your Obsidian Second Brain is ready. Create your first note or click Daily Note.
                </p>
                <button
                  type="button"
                  onClick={() => void handleOpenTodayNote()}
                  className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg"
                >
                  Open Today&apos;s Note
                </button>
              </div>
            )}
          </section>

          {/* All Apps Integrated Directly into the Second Brain */}
          {showAppsRail && (
            <aside className="lg:col-span-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3.5 space-y-4">
              <div className="flex items-center justify-between gap-2 pb-2 border-b border-slate-100 dark:border-slate-800">
                <div>
                  <h2 className="text-xs font-bold uppercase tracking-wider text-slate-900 dark:text-slate-100">
                    All Apps in Brain
                  </h2>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    Sync apps into Markdown notes or link via [[Wikilinks]].
                  </p>
                </div>
                <button
                  type="button"
                  onClick={onOpenAppsTab}
                  className="text-[11px] font-medium text-blue-600 dark:text-blue-400 hover:underline shrink-0"
                >
                  Configure
                </button>
              </div>

              {/* Google Workspace Section — Separate User Authorization */}
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-semibold text-slate-700 dark:text-slate-300">
                    Google Workspace (7)
                  </span>
                  {googleAccessToken ? (
                    <span className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
                      <CheckCircle2 className="w-3 h-3" /> Authorized
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void onConnectGoogleWorkspace()}
                      className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded"
                    >
                      <KeyRound className="w-2.5 h-2.5" />
                      <span>Authorize</span>
                    </button>
                  )}
                </div>

                <div className="space-y-1.5">
                  {GOOGLE_BRAIN_APPS.map((app) => (
                    <div
                      key={app.id}
                      className="flex items-center justify-between gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 px-2.5 py-1.5"
                    >
                      <button
                        type="button"
                        onClick={() => void handleOpenWikilink(app.name)}
                        className="text-xs font-medium text-slate-800 dark:text-slate-200 hover:text-blue-600 dark:hover:text-blue-400 truncate text-left"
                        title={`Open [[${app.name}]] note`}
                      >
                        {app.name}
                      </button>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => handleInsertWikilink(app.name)}
                          title={`Insert [[${app.name}]] link in current note`}
                          className="p-1 text-slate-400 hover:text-blue-600 dark:hover:text-blue-400"
                        >
                          <Link2 className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          disabled={busyApp === app.id}
                          onClick={() => void handlePullGoogleAppToBrain(app)}
                          title={
                            googleAccessToken
                              ? `Pull ${app.name} into Second Brain`
                              : 'Click Authorize above first'
                          }
                          className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium border border-slate-200 dark:border-slate-700 rounded hover:bg-white dark:hover:bg-slate-800 disabled:opacity-50"
                        >
                          <RefreshCw className={`w-2.5 h-2.5 ${busyApp === app.id ? 'animate-spin' : ''}`} />
                          <span>Sync</span>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Free External Apps & Custom Connectors */}
              <div className="space-y-2 pt-2 border-t border-slate-100 dark:border-slate-800">
                <span className="text-[11px] font-semibold text-slate-700 dark:text-slate-300 block">
                  External &amp; Custom Apps
                </span>
                <div className="space-y-1.5 max-h-[260px] overflow-y-auto">
                  {FREE_EXTERNAL_APPS.map((app) => (
                    <div
                      key={app.name}
                      className="flex items-center justify-between gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 px-2.5 py-1.5"
                    >
                      <button
                        type="button"
                        onClick={() => void handleOpenWikilink(app.name)}
                        className="text-xs font-medium text-slate-800 dark:text-slate-200 hover:text-blue-600 dark:hover:text-blue-400 truncate text-left"
                      >
                        {app.name}
                      </button>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => handleInsertWikilink(app.name)}
                          title={`Insert [[${app.name}]] link in current note`}
                          className="p-1 text-slate-400 hover:text-blue-600 dark:hover:text-blue-400"
                        >
                          <Link2 className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          disabled={busyApp === app.name}
                          onClick={() =>
                            void handleLinkExternalAppToBrain(app, app.connectorType === 'notion')
                          }
                          className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium border border-slate-200 dark:border-slate-700 rounded hover:bg-white dark:hover:bg-slate-800"
                        >
                          <ExternalLink className="w-2.5 h-2.5" />
                          <span>{app.connectorType === 'notion' ? 'Sync' : 'Wire'}</span>
                        </button>
                      </div>
                    </div>
                  ))}

                  {connectors
                    .filter(
                      (c) =>
                        !FREE_EXTERNAL_APPS.some(
                          (f) => f.name.toLowerCase() === c.name.toLowerCase()
                        )
                    )
                    .map((custom) => (
                      <div
                        key={custom.id}
                        className="flex items-center justify-between gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 px-2.5 py-1.5"
                      >
                        <button
                          type="button"
                          onClick={() => void handleOpenWikilink(custom.name)}
                          className="text-xs font-medium text-slate-800 dark:text-slate-200 hover:text-blue-600 dark:hover:text-blue-400 truncate text-left"
                        >
                          {custom.name}
                        </button>
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => handleInsertWikilink(custom.name)}
                            className="p-1 text-slate-400 hover:text-blue-600 dark:hover:text-blue-400"
                            title={`Insert [[${custom.name}]]`}
                          >
                            <Link2 className="w-3 h-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              void handleCreateNote(
                                custom.name,
                                'Apps/Custom',
                                `# ${custom.name}\n\nLinked to [[Ray Second Brain]].\n\nTarget: \`${custom.endpointOrTarget}\`\n\n${custom.description}\n\n#apps #custom`
                              )
                            }
                            className="px-1.5 py-0.5 text-[10px] font-medium border border-slate-200 dark:border-slate-700 rounded hover:bg-white dark:hover:bg-slate-800"
                          >
                            Note
                          </button>
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            </aside>
          )}
        </div>
      </div>
    </div>
  );
};
