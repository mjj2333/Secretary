import { useThread } from '../api/hooks.js';

export function ThreadView({ id }: { id: string }): JSX.Element {
  const q = useThread(id);
  if (q.isLoading) return <p>Loading…</p>;
  if (q.error) return <p className="text-red-600">{(q.error as Error).message}</p>;
  const t = q.data;
  if (!t) return <p>Not found.</p>;
  return (
    <div>
      <h2 className="mb-2 font-semibold">{t.subject ?? '(no subject)'}</h2>
      <p className="mb-3 text-xs text-slate-500">{t.state}</p>
      <ul className="space-y-3">
        {t.messages.map((m) => (
          <li key={m.id} className="rounded border border-slate-200 p-2">
            <p className="text-xs text-slate-500">
              {m.direction} · {m.from.address}
            </p>
            <p className="text-sm">{m.snippet ?? m.bodyText ?? ''}</p>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-xs text-slate-400">Draft review UI arrives in the next phase.</p>
    </div>
  );
}
