import React, { useState } from 'react';
import { Check, Copy, ExternalLink, MessageSquare, Send, Trash2 } from 'lucide-react';
import type { DeviceInfo, HandoffItem } from '../types/relay';

interface HandoffViewProps {
  handoffs: HandoffItem[];
  devices: DeviceInfo[];
  onPushHandoff: (params: {
    label: string;
    content: string;
    kind: HandoffItem['kind'];
    targetDevice: string;
  }) => void;
  onDeleteHandoff: (id: string) => void;
  onAskAssistant: (prompt: string) => void;
}

export const HandoffView: React.FC<HandoffViewProps> = ({
  handoffs,
  devices,
  onPushHandoff,
  onDeleteHandoff,
  onAskAssistant,
}) => {
  const [label, setLabel] = useState('');
  const [content, setContent] = useState('');
  const [kind, setKind] = useState<HandoffItem['kind']>('text');
  const [targetDevice, setTargetDevice] = useState('all');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim()) return;
    const detectedKind: HandoffItem['kind'] =
      kind === 'text' && /^https?:\/\//i.test(content.trim()) ? 'link' : kind;

    onPushHandoff({
      label: label.trim() || (detectedKind === 'link' ? 'Shared Link' : 'Clipboard Note'),
      content: content.trim(),
      kind: detectedKind,
      targetDevice,
    });
    setLabel('');
    setContent('');
  };

  const handleCopy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      window.setTimeout(() => setCopiedId(null), 1600);
    } catch {
      // Clipboard unavailable
    }
  };

  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6 space-y-6">
      <div>
        <h1 className="font-display text-xl font-bold text-slate-900 dark:text-slate-100">
          Cross-Device Handoff
        </h1>
        <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
          Push text, code, links, or snapshots between connected devices in real time.
        </p>
      </div>

      <form
        onSubmit={handleSubmit}
        className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3"
      >
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label (optional, e.g. API snippet)"
            className="px-3 py-2 text-sm bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100"
          />
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as HandoffItem['kind'])}
            aria-label="Handoff content type"
            className="px-3 py-2 text-sm bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100"
          >
            <option value="text">Note / Text</option>
            <option value="link">URL / Link</option>
            <option value="code">Code Snippet</option>
          </select>
          <select
            value={targetDevice}
            onChange={(e) => setTargetDevice(e.target.value)}
            aria-label="Target device"
            className="px-3 py-2 text-sm bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100"
          >
            <option value="all">All Online Devices</option>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} {d.online ? '' : '(Offline)'}
              </option>
            ))}
          </select>
        </div>

        <textarea
          rows={3}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Paste text, a URL, or code to push to another device..."
          className="w-full px-3 py-2.5 text-sm bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100 resize-y"
        />

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={!content.trim()}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            <Send className="w-3.5 h-3.5" />
            <span>Push to Device</span>
          </button>
        </div>
      </form>

      {handoffs.length === 0 ? (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8 text-center">
          <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
            No handoff items yet
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Push a note above, or ask the Assistant to send text or links to your phone or desktop.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {handoffs.map((item) => (
            <div
              key={item.id}
              className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-2.5"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
                    {item.label}
                  </h3>
                  <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 tabular-nums">
                    <span>From {item.sourceDevice}</span>
                    <span aria-hidden="true"> · </span>
                    <span>To {item.targetDevice}</span>
                    <span aria-hidden="true"> · </span>
                    <span>{new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  {item.kind !== 'image' && (
                    <button
                      type="button"
                      onClick={() => handleCopy(item.id, item.content)}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800"
                    >
                      {copiedId === item.id ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>{copiedId === item.id ? 'Copied' : 'Copy'}</span>
                    </button>
                  )}
                  {item.kind === 'link' && (
                    <a
                      href={item.content}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      <span>Open</span>
                    </a>
                  )}
                  {item.kind !== 'image' && (
                    <button
                      type="button"
                      onClick={() => onAskAssistant(`Summarize or act on this handoff item ("${item.label}"):\n\n${item.content}`)}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800"
                    >
                      <MessageSquare className="w-3.5 h-3.5" />
                      <span>Ask AI</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onDeleteHandoff(item.id)}
                    aria-label="Delete handoff item"
                    className="p-1.5 text-slate-400 hover:text-red-600 rounded-lg"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {item.kind === 'image' ? (
                <img
                  src={item.content}
                  alt={item.label}
                  className="max-h-64 rounded-lg border border-slate-200 dark:border-slate-800 object-contain"
                />
              ) : item.kind === 'code' ? (
                <pre className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 font-mono text-xs text-slate-800 dark:text-slate-200 overflow-x-auto">
                  {item.content}
                </pre>
              ) : (
                <p className="text-sm text-slate-700 dark:text-slate-300 whitespace-pre-wrap break-words">
                  {item.content}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
