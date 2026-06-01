import { Link } from 'wouter';
import type { NeedsAttentionItem } from '@secretary/shared-types';
import { UrgencyPill } from './UrgencyPill.js';
import { formatTimeAgo } from '../util/timeAgo.js';

export function NeedsAttentionCard({
  item,
  onGenerate,
  generating,
}: {
  item: NeedsAttentionItem;
  onGenerate: (threadId: string) => void;
  generating: boolean;
}): JSX.Element {
  return (
    <li className="rounded-xl border border-slate-200 bg-white p-3">
      <Link href={`/threads/${item.id}`} className="block">
        <div className="flex items-center justify-between">
          <span className="text-[15px] font-semibold text-slate-900">{item.senderName}</span>
          <span className="text-xs text-slate-400">{formatTimeAgo(item.lastMessageAt)}</span>
        </div>
        <div className="my-1.5 flex items-center gap-2">
          <UrgencyPill urgency={item.urgency} />
          <span className="truncate text-xs text-slate-400">{item.subject ?? '(no subject)'}</span>
        </div>
        {item.summary ? (
          <p className="text-[13px] leading-snug text-slate-600">{item.summary}</p>
        ) : null}
      </Link>
      <div className="mt-2.5 flex justify-end">
        {item.hasDraft ? (
          <Link
            href={`/threads/${item.id}`}
            className="rounded-lg bg-slate-900 px-3.5 py-2 text-[13px] font-semibold text-white"
          >
            Review draft ▸
          </Link>
        ) : (
          <button
            type="button"
            disabled={generating}
            onClick={() => onGenerate(item.id)}
            className="rounded-lg border border-slate-300 px-3.5 py-2 text-[13px] font-medium text-slate-700 disabled:opacity-50"
          >
            {generating ? 'Generating…' : 'Generate draft'}
          </button>
        )}
      </div>
    </li>
  );
}
