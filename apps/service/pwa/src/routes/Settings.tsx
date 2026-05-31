import { useSettings } from '../api/hooks.js';
export function Settings(): JSX.Element {
  const q = useSettings();
  if (q.isLoading) return <p>Loading…</p>;
  if (q.error) return <p className="text-red-600">{(q.error as Error).message}</p>;
  return <pre className="overflow-auto text-xs">{JSON.stringify(q.data ?? {}, null, 2)}</pre>;
}
