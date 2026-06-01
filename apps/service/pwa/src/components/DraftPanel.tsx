import { useState } from 'react';
import type { DraftView } from '@secretary/shared-types';
import { DiffView } from './DiffView.js';

export function DraftPanel({
  draft,
  body,
  busy,
  onBodyChange,
  onRegenerate,
  onEditIntent,
  onSend,
  onDiscard,
}: {
  draft: DraftView;
  body: string;
  busy: boolean;
  onBodyChange: (v: string) => void;
  onRegenerate: () => void;
  onEditIntent: (intent: string) => void;
  onSend: () => void;
  onDiscard: () => void;
}): JSX.Element {
  const [showDiff, setShowDiff] = useState(false);
  const [editingIntent, setEditingIntent] = useState(false);
  const [intent, setIntent] = useState(draft.rawIntent ?? '');
  const hasDiff = !!draft.polishDiff && draft.polishDiff.length > 0;

  return (
    <div className="flex flex-1 flex-col">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wide text-slate-400">
          Draft · v{draft.version}
          {draft.status === 'failed' ? (
            <span className="ml-2 text-red-600">send failed</span>
          ) : null}
        </span>
        <button
          type="button"
          disabled={!hasDiff}
          onClick={() => setShowDiff((v) => !v)}
          className="text-xs text-blue-600 underline disabled:text-slate-300 disabled:no-underline"
        >
          diff
        </button>
      </div>

      {showDiff && hasDiff ? (
        <DiffView ops={draft.polishDiff ?? []} />
      ) : (
        <textarea
          value={body}
          onChange={(e) => onBodyChange(e.target.value)}
          className="min-h-[140px] flex-1 rounded-lg border border-slate-300 p-2.5 text-[13px] leading-relaxed text-slate-900"
        />
      )}

      {editingIntent ? (
        <div className="mt-2 flex gap-2">
          <input
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            placeholder="what should this say?"
            className="flex-1 rounded-lg border border-slate-300 px-2 py-1.5 text-[13px]"
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              onEditIntent(intent);
              setEditingIntent(false);
            }}
            className="rounded-lg bg-slate-900 px-3 text-xs font-semibold text-white disabled:opacity-50"
          >
            Regenerate
          </button>
        </div>
      ) : draft.rawIntent ? (
        <p className="mt-1.5 text-xs text-slate-500">
          intent: <em>"{draft.rawIntent}"</em>
        </p>
      ) : null}

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={onRegenerate}
          className="rounded-lg border border-slate-300 px-2.5 py-2 text-xs text-slate-700 disabled:opacity-50"
        >
          ↻ Regenerate
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => setEditingIntent((v) => !v)}
          className="rounded-lg border border-slate-300 px-2.5 py-2 text-xs text-slate-700 disabled:opacity-50"
        >
          Edit intent
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onDiscard}
          className="rounded-lg border border-slate-300 px-2.5 py-2 text-xs text-slate-500 disabled:opacity-50"
        >
          Discard
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onSend}
          className="flex-1 rounded-lg bg-slate-900 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </div>
  );
}
