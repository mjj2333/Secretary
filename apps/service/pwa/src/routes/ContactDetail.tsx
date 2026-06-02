import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { useContact, usePatchContact } from '../api/hooks.js';

const CATEGORIES = [
  'client_established',
  'client_new',
  'screening',
  'personal',
  'vendor',
  'noise',
  'unknown',
] as const;

export function ContactDetail({ id }: { id: string }): JSX.Element {
  const q = useContact(id);
  const patch = usePatchContact();
  const [, setLocation] = useLocation();
  const [category, setCategory] = useState('unknown');
  const [notes, setNotes] = useState('');
  const [styleNotes, setStyleNotes] = useState('');
  const [doNotAutoDraft, setDoNotAutoDraft] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    const c = q.data;
    if (c) {
      setCategory(c.category);
      setNotes(c.notes ?? '');
      setStyleNotes(c.styleNotes ?? '');
      setDoNotAutoDraft(c.doNotAutoDraft);
    }
  }, [q.data?.id]);

  if (q.isLoading) return <p>Loading…</p>;
  if (q.error) return <p className="text-red-600">{(q.error as Error).message}</p>;
  const c = q.data;
  if (!c) return <p>Not found.</p>;

  const onSave = (): void => {
    setMsg(null);
    patch.mutate(
      { id, category, notes, styleNotes, doNotAutoDraft },
      {
        onSuccess: () => setMsg('Saved.'),
        onError: (e: unknown) => setMsg(e instanceof Error ? e.message : 'Save failed'),
      },
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        onClick={() => setLocation('/contacts')}
        className="self-start text-sm text-slate-500"
      >
        ‹ Contacts
      </button>
      <h2 className="font-semibold">{c.displayName ?? c.emailAddress}</h2>
      <p className="text-xs text-slate-500">
        {c.emailAddress} · in {c.totalMessagesIn} / out {c.totalMessagesOut}
      </p>

      <label className="text-xs font-semibold text-slate-700">
        Category
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="mt-1 block w-full rounded-lg border border-slate-300 p-2 text-sm"
        >
          {CATEGORIES.map((cat) => (
            <option key={cat} value={cat}>
              {cat}
            </option>
          ))}
        </select>
      </label>

      <label className="text-xs font-semibold text-slate-700">
        Notes
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className="mt-1 block min-h-[70px] w-full rounded-lg border border-slate-300 p-2 text-sm"
        />
      </label>

      <label className="text-xs font-semibold text-slate-700">
        Style notes (how the agent should write to them)
        <textarea
          value={styleNotes}
          onChange={(e) => setStyleNotes(e.target.value)}
          className="mt-1 block min-h-[70px] w-full rounded-lg border border-slate-300 p-2 text-sm"
        />
      </label>

      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          checked={doNotAutoDraft}
          onChange={(e) => setDoNotAutoDraft(e.target.checked)}
        />
        Don't auto-draft for this contact
      </label>

      <button
        type="button"
        disabled={patch.isPending}
        onClick={onSave}
        className="self-start rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
      >
        {patch.isPending ? 'Saving…' : 'Save'}
      </button>
      {msg ? <p className="text-xs text-slate-600">{msg}</p> : null}
    </div>
  );
}
