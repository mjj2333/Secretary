import type { Urgency } from '@secretary/shared-types';

export function UrgencyPill({ urgency }: { urgency: Urgency | null }): JSX.Element | null {
  if (!urgency) return null;
  // Conditional (not a Record index) to stay clean under noUncheckedIndexedAccess.
  const cls =
    urgency === 'high'
      ? 'bg-red-100 text-red-700'
      : urgency === 'normal'
        ? 'bg-amber-100 text-amber-800'
        : 'bg-slate-100 text-slate-600';
  return <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}>{urgency}</span>;
}
