import { useState } from 'react';
import type { StyleExampleView } from '@secretary/shared-types';
import {
  useStyleExamples,
  useMiningStatus,
  useMineSentMail,
  usePatchStyleExample,
} from '../api/hooks.js';

type Filter = 'pending' | 'approved' | 'rejected';
const FILTERS: Filter[] = ['pending', 'approved', 'rejected'];

export function StyleExamples(): JSX.Element {
  const [filter, setFilter] = useState<Filter>('pending');
  const q = useStyleExamples(filter);
  const status = useMiningStatus();
  const mine = useMineSentMail();

  const running = status.data?.running ?? false;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Mined style examples</h1>
        <button
          type="button"
          className="rounded bg-slate-800 px-3 py-1.5 text-sm text-white disabled:opacity-50"
          disabled={running || mine.isPending}
          onClick={() => mine.mutate()}
        >
          Mine sent mail
        </button>
      </div>

      {running && status.data ? (
        <p className="text-sm text-slate-500">
          Mining {status.data.done} / {status.data.total}…
        </p>
      ) : null}
      {mine.data ? (
        <p className="text-sm text-slate-500">
          Enqueued {mine.data.enqueued} (already mined {mine.data.alreadyMined}).
        </p>
      ) : null}

      <div className="flex gap-2 text-sm">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            className={`rounded px-2 py-1 ${filter === f ? 'bg-slate-200 font-medium' : 'text-slate-500'}`}
            onClick={() => setFilter(f)}
          >
            {f[0]!.toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      {q.isLoading ? <p>Loading…</p> : null}
      {q.error ? <p className="text-red-600">{(q.error as Error).message}</p> : null}
      {q.data && q.data.length === 0 ? (
        <p className="text-sm text-slate-500">
          {filter === 'pending'
            ? 'No mined examples yet — tap Mine sent mail to analyze your last 200 sent messages.'
            : `No ${filter} examples.`}
        </p>
      ) : null}

      <ul className="space-y-3">
        {(q.data ?? []).map((ex) => (
          <ExampleCard key={ex.id} ex={ex} />
        ))}
      </ul>
    </div>
  );
}

function ExampleCard({ ex }: { ex: StyleExampleView }): JSX.Element {
  const patch = usePatchStyleExample();
  const [editing, setEditing] = useState(false);
  const [contextSummary, setContextSummary] = useState(ex.contextSummary);
  const [replyText, setReplyText] = useState(ex.replyText);
  const [tags, setTags] = useState(ex.tags.join(', '));

  const save = (): void => {
    patch.mutate({
      id: ex.id,
      contextSummary,
      replyText,
      tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
    });
    setEditing(false);
  };

  return (
    <li className="rounded border border-slate-200 p-3 text-sm">
      <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
        <span className="rounded bg-slate-100 px-1.5 py-0.5">{ex.category ?? 'unknown'}</span>
        {ex.tags.length > 0 ? <span>{ex.tags.join(' · ')}</span> : null}
        <span className="ml-auto uppercase">{ex.status}</span>
      </div>

      {editing ? (
        <div className="space-y-2">
          <textarea
            className="w-full rounded border p-1"
            value={contextSummary}
            onChange={(e) => setContextSummary(e.target.value)}
          />
          <textarea
            className="w-full rounded border p-1"
            rows={4}
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
          />
          <input
            className="w-full rounded border p-1"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="tags, comma-separated"
          />
          <div className="flex gap-2">
            <button type="button" className="rounded bg-slate-800 px-2 py-1 text-white" onClick={save}>
              Save
            </button>
            <button type="button" className="px-2 py-1 text-slate-500" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="text-slate-600">Context: {ex.contextSummary}</p>
          <p className="mt-1 whitespace-pre-wrap">Reply: {ex.replyText}</p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className="rounded bg-emerald-600 px-2 py-1 text-white disabled:opacity-50"
              disabled={patch.isPending}
              onClick={() => patch.mutate({ id: ex.id, status: 'approved' })}
            >
              Approve
            </button>
            <button
              type="button"
              className="rounded bg-slate-200 px-2 py-1 disabled:opacity-50"
              disabled={patch.isPending}
              onClick={() => patch.mutate({ id: ex.id, status: 'rejected' })}
            >
              Reject
            </button>
            <button type="button" className="px-2 py-1 text-slate-500" onClick={() => setEditing(true)}>
              Edit
            </button>
          </div>
        </>
      )}
    </li>
  );
}
