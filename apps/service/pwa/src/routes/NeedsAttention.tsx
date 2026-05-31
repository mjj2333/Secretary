import { Link } from 'wouter';
import { useNeedsAttention } from '../api/hooks.js';

export function NeedsAttention(): JSX.Element {
  const q = useNeedsAttention();
  if (q.isLoading) return <p>Loading…</p>;
  if (q.error) return <p className="text-red-600">{(q.error as Error).message}</p>;
  const items = q.data ?? [];
  if (items.length === 0) return <p className="text-slate-500">Nothing needs attention.</p>;
  return (
    <ul className="divide-y divide-slate-100">
      {items.map((t) => (
        <li key={t.id} className="py-3">
          <Link href={`/threads/${t.id}`} className="block">
            <span className="font-medium">{t.subject ?? '(no subject)'}</span>
            <span className="ml-2 text-xs text-slate-500">
              {t.urgency ?? ''} · {t.state}
            </span>
            {t.summary ? <p className="text-sm text-slate-600">{t.summary}</p> : null}
          </Link>
        </li>
      ))}
    </ul>
  );
}
