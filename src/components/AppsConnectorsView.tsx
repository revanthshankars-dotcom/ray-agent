import React, { useState } from 'react';
import {
  CheckCircle2,
  ExternalLink,
  Globe,
  KeyRound,
  Mail,
  Play,
  Plus,
  ShieldAlert,
  Sparkles,
  Trash2,
} from 'lucide-react';
import type {
  AppConnector,
  AppConnectorCategory,
  AppConnectorType,
  ConfirmationRequest,
} from '../types/relay';
import { playHudSound } from '../utils/hudAudio';
import { authFetch } from '../utils/roomAuth';

interface AppsConnectorsViewProps {
  roomId: string;
  googleAccessToken: string | null;
  notionToken: string;
  onChangeNotionToken: (token: string) => void;
  onConnectGoogleWorkspace: () => Promise<string | null>;
  connectors: AppConnector[];
  onSaveConnector: (connector: AppConnector) => Promise<void> | void;
  onDeleteConnector: (connectorId: string) => Promise<void> | void;
  onConfirmationRequired: (req: ConfirmationRequest) => void;
  onAskJarvis: (prompt: string) => void;
}

const GOOGLE_APPS = [
  { id: 'gmail', name: 'Gmail', readAction: 'gmail_list_messages', scopeNote: 'Read inbox & send email (confirmed)' },
  { id: 'calendar', name: 'Google Calendar', readAction: 'calendar_list_events', scopeNote: 'Read agenda & create/delete events (confirmed)' },
  { id: 'drive', name: 'Google Drive', readAction: 'drive_search_files', scopeNote: 'Search & list workspace files' },
  { id: 'docs', name: 'Google Docs', readAction: 'drive_search_files', scopeNote: 'Read & create Google Docs (confirmed)' },
  { id: 'sheets', name: 'Google Sheets', readAction: 'drive_search_files', scopeNote: 'Read ranges & append rows (confirmed)' },
  { id: 'tasks', name: 'Google Tasks', readAction: 'tasks_list_tasks', scopeNote: 'Read, create & complete tasks (confirmed)' },
  { id: 'contacts', name: 'Google Contacts', readAction: 'contacts_search', scopeNote: 'Search directory & phone/email' },
];

const FREE_APP_PRESETS: Array<Omit<AppConnector, 'id' | 'createdAt' | 'updatedAt'>> = [
  {
    name: 'Brave Browser',
    category: 'browser',
    connectorType: 'bridge_app',
    endpointOrTarget: 'brave',
    method: 'LAUNCH',
    description: 'Launch Brave Browser locally via OS Bridge.',
    headersJson: '{}',
    enabled: true,
    requiresConfirmation: false,
  },
  {
    name: 'Brave Search',
    category: 'browser',
    connectorType: 'url_template',
    endpointOrTarget: 'https://search.brave.com/search?q={{query}}',
    method: 'LAUNCH',
    description: 'Open privacy-first Brave Search with any query.',
    headersJson: '{}',
    enabled: true,
    requiresConfirmation: false,
  },
  {
    name: 'Notion API Search',
    category: 'notes',
    connectorType: 'notion',
    endpointOrTarget: 'https://api.notion.com/v1/search',
    method: 'POST',
    description: 'Free Notion Integration token search across your pages & databases.',
    headersJson: '{}',
    enabled: true,
    requiresConfirmation: false,
  },
  {
    name: 'NotebookLM',
    category: 'notes',
    connectorType: 'url_template',
    endpointOrTarget: 'https://notebooklm.google.com/',
    method: 'LAUNCH',
    description: 'Launch Google NotebookLM in your browser.',
    headersJson: '{}',
    enabled: true,
    requiresConfirmation: false,
  },
  {
    name: 'WhatsApp Messenger',
    category: 'social',
    connectorType: 'url_template',
    endpointOrTarget: 'https://wa.me/{{phone}}?text={{text}}',
    method: 'LAUNCH',
    description: 'Free zero-API-fee prefilled WhatsApp message composer.',
    headersJson: '{}',
    enabled: true,
    requiresConfirmation: true,
  },
  {
    name: 'Instagram',
    category: 'social',
    connectorType: 'url_template',
    endpointOrTarget: 'https://www.instagram.com/',
    method: 'LAUNCH',
    description: 'Open Instagram directly in Brave / desktop browser.',
    headersJson: '{}',
    enabled: true,
    requiresConfirmation: false,
  },
  {
    name: 'Obsidian Desktop',
    category: 'notes',
    connectorType: 'bridge_app',
    endpointOrTarget: 'obsidian',
    method: 'LAUNCH',
    description: 'Open the Obsidian desktop app via OS Bridge.',
    headersJson: '{}',
    enabled: true,
    requiresConfirmation: false,
  },
];

export const AppsConnectorsView: React.FC<AppsConnectorsViewProps> = ({
  roomId,
  googleAccessToken,
  notionToken,
  onChangeNotionToken,
  onConnectGoogleWorkspace,
  connectors,
  onSaveConnector,
  onDeleteConnector,
  onConfirmationRequired,
  onAskJarvis,
}) => {
  const [workspaceOutput, setWorkspaceOutput] = useState<string | null>(null);
  const [testingApp, setTestingApp] = useState<string | null>(null);
  const [connectorOutput, setConnectorOutput] = useState<string | null>(null);

  // Custom App Builder state
  const [name, setName] = useState('');
  const [category, setCategory] = useState<AppConnectorCategory>('automation');
  const [connectorType, setConnectorType] = useState<AppConnectorType>('url_template');
  const [endpointOrTarget, setEndpointOrTarget] = useState('');
  const [method, setMethod] = useState<AppConnector['method']>('LAUNCH');
  const [description, setDescription] = useState('');
  const [headersJson, setHeadersJson] = useState('{}');
  const [requiresConfirmation, setRequiresConfirmation] = useState(false);

  // Explicit Google Workspace confirmation modal state (mutating action test)
  const [pendingGoogleMutate, setPendingGoogleMutate] = useState<{
    action: string;
    label: string;
    args: Record<string, unknown>;
  } | null>(null);
  const [quickTaskTitle, setQuickTaskTitle] = useState('');

  const handleRunWorkspaceRead = async (action: string, label: string) => {
    setTestingApp(label);
    setWorkspaceOutput(null);
    try {
      const res = await authFetch(
        '/api/workspace/execute',
        roomId,
        {
          method: 'POST',
          body: JSON.stringify({ roomId, action, args: { query: '' } }),
        },
        { googleAccessToken }
      );
      const data = (await res.json()) as { result?: string; error?: string };
      if (!res.ok) throw new Error(data.error || 'Workspace request failed');
      setWorkspaceOutput(`${label}: ${(data.result || '').slice(0, 600)}`);
      playHudSound('affirmative');
    } catch (err) {
      setWorkspaceOutput(err instanceof Error ? err.message : 'Workspace call failed');
    } finally {
      setTestingApp(null);
    }
  };

  const handleConfirmGoogleMutate = async () => {
    if (!pendingGoogleMutate) return;
    const { action, label, args } = pendingGoogleMutate;
    setPendingGoogleMutate(null);
    setTestingApp(label);
    try {
      const res = await authFetch(
        '/api/workspace/execute',
        roomId,
        {
          method: 'POST',
          body: JSON.stringify({ roomId, action, args, confirmed: true }),
        },
        { googleAccessToken }
      );
      const data = (await res.json()) as { result?: string; error?: string };
      if (!res.ok) throw new Error(data.error || 'Action failed');
      setWorkspaceOutput(data.result || 'Completed.');
      playHudSound('affirmative');
    } catch (err) {
      setWorkspaceOutput(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setTestingApp(null);
    }
  };

  const handleAddPreset = async (preset: (typeof FREE_APP_PRESETS)[number]) => {
    const existing = connectors.find((c) => c.name.toLowerCase() === preset.name.toLowerCase());
    if (existing) {
      setConnectorOutput(`${preset.name} is already connected.`);
      return;
    }
    const now = Date.now();
    const next: AppConnector = {
      ...preset,
      id: `conn-${now}-${Math.random().toString(36).slice(2, 6)}`,
      createdAt: now,
      updatedAt: now,
    };
    await onSaveConnector(next);
    await authFetch('/api/connectors', roomId, {
      method: 'POST',
      body: JSON.stringify({ roomId, connector: next }),
    }).catch(() => {});
    playHudSound('affirmative');
    setConnectorOutput(`Connected ${preset.name} — RAY can now invoke it automatically.`);
  };

  const handleCreateCustom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !endpointOrTarget.trim()) return;
    const now = Date.now();
    const next: AppConnector = {
      id: `conn-${now}-${Math.random().toString(36).slice(2, 6)}`,
      name: name.trim().slice(0, 80),
      category,
      connectorType,
      endpointOrTarget: endpointOrTarget.trim(),
      method: connectorType === 'webhook' ? method : 'LAUNCH',
      description: description.trim() || `${name.trim()} connector`,
      headersJson: headersJson.trim() || '{}',
      enabled: true,
      requiresConfirmation,
      createdAt: now,
      updatedAt: now,
    };
    const res = await authFetch('/api/connectors', roomId, {
      method: 'POST',
      body: JSON.stringify({ roomId, connector: next }),
    });
    const data = (await res.json()) as { error?: string };
    if (!res.ok) {
      setConnectorOutput(`Blocked by security validator: ${data.error || 'Invalid connector'}`);
      return;
    }
    await onSaveConnector(next);
    setName('');
    setEndpointOrTarget('');
    setDescription('');
    setHeadersJson('{}');
    playHudSound('affirmative');
    setConnectorOutput(`Registered custom app "${next.name}".`);
  };

  const handleTestConnector = async (connector: AppConnector) => {
    setConnectorOutput(null);
    const res = await authFetch(
      '/api/connectors/test',
      roomId,
      {
        method: 'POST',
        body: JSON.stringify({
          roomId,
          connector,
          args: { query: 'RAY', text: 'Hello from RAY.' },
        }),
      },
      { notionToken }
    );
    const data = (await res.json()) as {
      result?: string;
      confirmation?: ConfirmationRequest;
      error?: string;
    };
    if (data.confirmation) {
      onConfirmationRequired(data.confirmation);
    }
    setConnectorOutput(data.result || data.error || 'Tested connector.');
  };

  return (
    <div className="max-w-6xl mx-auto p-4 sm:p-6 space-y-8">
      <div>
        <h1 className="font-display text-xl font-bold text-slate-900 dark:text-slate-100">
          Connected Apps & Free Integrations
        </h1>
        <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
          Authorize Google Workspace apps via zero-cost client OAuth (tokens kept strictly in memory), enable free desktop/web connectors, or add any custom app or webhook.
        </p>
      </div>

      {/* Section 1: Google Workspace Suite */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Google Workspace Suite (Client-Side OAuth)
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Access tokens live strictly in memory for this tab session and are wiped automatically on sign-out. Mutating actions always ask confirmation.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void onConnectGoogleWorkspace()}
            className={`inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg whitespace-nowrap shrink-0 ${
              googleAccessToken
                ? 'border border-emerald-500/40 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300'
                : 'bg-blue-600 hover:bg-blue-700 text-white'
            }`}
          >
            {googleAccessToken ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Mail className="w-3.5 h-3.5" />}
            <span>{googleAccessToken ? 'Workspace Connected (Refresh)' : 'Connect Google Workspace'}</span>
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {GOOGLE_APPS.map((app) => (
            <div
              key={app.id}
              className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 p-3.5 flex flex-col justify-between gap-3"
            >
              <div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                    {app.name}
                  </span>
                  <span
                    className={`font-mono text-[10px] font-semibold ${
                      googleAccessToken
                        ? 'text-emerald-700 dark:text-emerald-400'
                        : 'text-slate-400'
                    }`}
                  >
                    {googleAccessToken ? 'READY' : 'LOCKED'}
                  </span>
                </div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
                  {app.scopeNote}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={!googleAccessToken || testingApp === app.name}
                  onClick={() => void handleRunWorkspaceRead(app.readAction, app.name)}
                  className="px-2.5 py-1 text-[11px] font-medium border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 rounded hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40"
                >
                  {testingApp === app.name ? 'Reading...' : 'Test Read'}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    onAskJarvis(`Check my ${app.name} and summarize anything important for me, Ray.`)
                  }
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium text-blue-600 dark:text-blue-400 hover:underline"
                >
                  <Sparkles className="w-3 h-3" />
                  <span>Ask RAY</span>
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Confirmation-gated Google Task Write Test */}
        {googleAccessToken && (
          <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
            <input
              type="text"
              value={quickTaskTitle}
              onChange={(e) => setQuickTaskTitle(e.target.value)}
              placeholder="Create a Google Task (confirmation-gated)..."
              className="flex-1 min-w-[220px] px-3 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100"
            />
            <button
              type="button"
              disabled={!quickTaskTitle.trim()}
              onClick={() =>
                setPendingGoogleMutate({
                  action: 'tasks_create_task',
                  label: 'Google Tasks',
                  args: { title: quickTaskTitle.trim() },
                })
              }
              className="px-3 py-1.5 text-xs font-semibold bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 rounded-lg disabled:opacity-40"
            >
              Create Task (Confirm)
            </button>
          </div>
        )}

        {workspaceOutput && (
          <pre className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 font-mono text-[11px] text-slate-700 dark:text-slate-300 whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
            {workspaceOutput}
          </pre>
        )}
      </section>

      {/* Explicit Confirmation Modal for Workspace Write */}
      {pendingGoogleMutate && (
        <div className="rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50/70 dark:bg-amber-950/30 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-start gap-2.5 text-xs">
            <ShieldAlert className="w-4 h-4 text-amber-700 dark:text-amber-400 shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold text-slate-900 dark:text-slate-100">
                Confirm Google Workspace Action ({pendingGoogleMutate.label})
              </div>
              <div className="text-slate-700 dark:text-slate-300 mt-0.5">
                Execute <span className="font-mono">{pendingGoogleMutate.action}</span> with{' '}
                <span className="font-mono">{JSON.stringify(pendingGoogleMutate.args)}</span>?
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setPendingGoogleMutate(null)}
              className="px-3 py-1.5 text-xs font-medium border border-slate-300 dark:border-slate-700 rounded-lg"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleConfirmGoogleMutate()}
              className="px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg"
            >
              Confirm & Execute
            </button>
          </div>
        </div>
      )}

      {/* Section 2: Free External App Presets + Notion Session Token */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Free External App Pack (Brave, Notion, Notebook, WhatsApp, Instagram, Obsidian)
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Zero-cost launchers, URI templates, and Notion free integration REST support.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <KeyRound className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            <input
              type="password"
              value={notionToken}
              onChange={(e) => onChangeNotionToken(e.target.value)}
              placeholder="Optional Notion Token (memory-only)"
              aria-label="Notion Integration Token"
              className="w-64 px-2.5 py-1.5 text-xs font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {FREE_APP_PRESETS.map((preset) => {
            const added = connectors.some((c) => c.name.toLowerCase() === preset.name.toLowerCase());
            return (
              <div
                key={preset.name}
                className="rounded-lg border border-slate-200 dark:border-slate-800 p-3.5 flex flex-col justify-between gap-2.5"
              >
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                      {preset.name}
                    </span>
                    <span className="font-mono text-[10px] uppercase text-slate-400">
                      {preset.connectorType}
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-600 dark:text-slate-400 mt-1">
                    {preset.description}
                  </p>
                </div>
                <div className="flex items-center justify-between">
                  <button
                    type="button"
                    disabled={added}
                    onClick={() => void handleAddPreset(preset)}
                    className={`inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded-md ${
                      added
                        ? 'text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/30'
                        : 'text-white bg-blue-600 hover:bg-blue-700'
                    }`}
                  >
                    {added ? <CheckCircle2 className="w-3 h-3" /> : <Plus className="w-3 h-3" />}
                    <span>{added ? 'Enabled' : 'Add Free App'}</span>
                  </button>
                  {preset.endpointOrTarget.startsWith('http') && !preset.endpointOrTarget.includes('{{') && (
                    <a
                      href={preset.endpointOrTarget}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[11px] text-slate-500 hover:text-blue-600"
                    >
                      <ExternalLink className="w-3 h-3" />
                      <span>Open</span>
                    </a>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Section 3: Add Any Custom App / Webhook + Active Connectors */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <section className="lg:col-span-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Add Any Custom App or Webhook
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Connect Spotify, Discord, Telegram bot, ntfy.sh, Home Assistant, or any desktop executable. Private/SSRF targets are blocked automatically.
            </p>
          </div>

          <form onSubmit={handleCreateCustom} className="space-y-3 text-xs">
            <div className="grid grid-cols-2 gap-2">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="App Name (e.g. Discord)"
                className="px-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100"
              />
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as AppConnectorCategory)}
                aria-label="Connector category"
                className="px-2.5 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100"
              >
                <option value="automation">Automation</option>
                <option value="social">Social</option>
                <option value="notes">Notes</option>
                <option value="browser">Browser</option>
                <option value="productivity">Productivity</option>
              </select>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <select
                value={connectorType}
                onChange={(e) => setConnectorType(e.target.value as AppConnectorType)}
                aria-label="Connector type"
                className="px-2.5 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100"
              >
                <option value="url_template">URL / Deep-Link Template</option>
                <option value="bridge_app">Desktop OS Bridge App</option>
                <option value="webhook">HTTPS Webhook / REST API</option>
                <option value="notion">Notion API</option>
              </select>

              {connectorType === 'webhook' && (
                <select
                  value={method}
                  onChange={(e) => setMethod(e.target.value as AppConnector['method'])}
                  aria-label="HTTP method"
                  className="px-2.5 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100"
                >
                  <option value="POST">POST</option>
                  <option value="GET">GET</option>
                  <option value="PUT">PUT</option>
                </select>
              )}
            </div>

            <input
              type="text"
              value={endpointOrTarget}
              onChange={(e) => setEndpointOrTarget(e.target.value)}
              placeholder={
                connectorType === 'bridge_app'
                  ? 'App name or URI (e.g. spotify:, discord, vscode)'
                  : connectorType === 'webhook'
                  ? 'https://ntfy.sh/my-topic or Discord webhook URL'
                  : 'https://example.com/search?q={{query}}'
              }
              className="w-full px-3 py-2 font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100"
            />

            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="When should RAY use this app?"
              className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100"
            />

            {connectorType === 'webhook' && (
              <input
                type="text"
                value={headersJson}
                onChange={(e) => setHeadersJson(e.target.value)}
                placeholder='Optional headers JSON e.g. {"X-Auth":"..."}'
                className="w-full px-3 py-2 font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100"
              />
            )}

            <label className="flex items-center gap-2 text-slate-600 dark:text-slate-300">
              <input
                type="checkbox"
                checked={requiresConfirmation}
                onChange={(e) => setRequiresConfirmation(e.target.checked)}
                className="accent-blue-600"
              />
              <span>Require confirmation before RAY invokes</span>
            </label>

            <button
              type="submit"
              disabled={!name.trim() || !endpointOrTarget.trim()}
              className="w-full py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-40 rounded-lg"
            >
              Save Connector
            </button>
          </form>
        </section>

        <section className="lg:col-span-7 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Active Connectors ({connectors.length})
            </h2>
            <span className="text-xs text-slate-500">Available to RAY tools</span>
          </div>

          {connectorOutput && (
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-xs text-slate-700 dark:text-slate-300 break-words">
              {connectorOutput}
            </div>
          )}

          {connectors.length === 0 ? (
            <div className="py-10 text-center text-xs text-slate-500 dark:text-slate-400">
              No external apps added yet. Click any free app preset above or build your own connector on the left.
            </div>
          ) : (
            <ul className="divide-y divide-slate-200 dark:divide-slate-800">
              {connectors.map((c) => (
                <li key={c.id} className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Globe className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                      <span className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
                        {c.name}
                      </span>
                      <span className="font-mono text-[10px] uppercase text-slate-400">
                        {c.connectorType}
                      </span>
                    </div>
                    <div className="text-xs font-mono text-slate-500 dark:text-slate-400 truncate mt-0.5">
                      {c.endpointOrTarget}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => void handleTestConnector(c)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium border border-slate-200 dark:border-slate-700 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800"
                    >
                      <Play className="w-3 h-3" />
                      <span>Test</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void onDeleteConnector(c.id)}
                      aria-label={`Delete connector ${c.name}`}
                      className="p-1.5 text-slate-400 hover:text-red-600 rounded-lg"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
};
