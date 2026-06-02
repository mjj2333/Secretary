import { Link } from 'wouter';
import { useContacts } from '../api/hooks.js';
export function Contacts(): JSX.Element {
  const q = useContacts();
  if (q.isLoading) return <p>Loading…</p>;
  if (q.error) return <p className="text-red-600">{(q.error as Error).message}</p>;
  return (
    <ul className="divide-y divide-slate-100">
      {(q.data ?? []).map((c) => (
        <li key={c.id} className="py-2 text-sm">
          <Link href={`/contacts/${c.id}`} className="block">
            {c.displayName ?? c.emailAddress} · {c.category}
          </Link>
        </li>
      ))}
    </ul>
  );
}
