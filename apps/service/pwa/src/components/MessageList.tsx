import { useState } from 'react';
import type { MessageView } from '@secretary/shared-types';

function MessageItem({ m, defaultOpen }: { m: MessageView; defaultOpen: boolean }): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <li className="rounded-lg border border-slate-200">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-left"
      >
        <span className="text-xs text-slate-500">
          {m.direction} · {m.from.name ?? m.from.address}
        </span>
        <span className="text-xs text-slate-400">{open ? '▾' : '▸'}</span>
      </button>
      {open ? (
        <p className="whitespace-pre-wrap px-3 pb-3 text-[13px] leading-relaxed text-slate-700">
          {m.bodyText ?? m.snippet ?? ''}
        </p>
      ) : (
        <p className="truncate px-3 pb-2 text-[13px] text-slate-400">{m.snippet ?? ''}</p>
      )}
    </li>
  );
}

export function MessageList({ messages }: { messages: MessageView[] }): JSX.Element {
  // Expand the latest inbound message by default.
  let lastInbound = -1;
  messages.forEach((m, i) => {
    if (m.direction === 'inbound') lastInbound = i;
  });
  return (
    <ul className="flex flex-col gap-2">
      {messages.map((m, i) => (
        <MessageItem key={m.id} m={m} defaultOpen={i === lastInbound} />
      ))}
    </ul>
  );
}
