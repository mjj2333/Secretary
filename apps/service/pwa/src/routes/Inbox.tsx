import { useThreads } from '../api/hooks.js';
export function Inbox(): JSX.Element {
  const q = useThreads();
  if (q.isLoading) return <p>Loading…</p>;
  if (q.error) return <p className="text-red-600">{(q.error as Error).message}</p>;
  return (
    <ul className="divide-y divide-slate-100">
      {(q.data ?? []).map((t) => (
        <li key={t.id} className="py-2 text-sm">
          {t.subject ?? '(no subject)'} · {t.state}
        </li>
      ))}
    </ul>
  );
}
