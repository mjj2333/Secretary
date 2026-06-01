import { useState } from 'react';
import { useLocation } from 'wouter';
import { useNeedsAttention, useGenerateDraft } from '../api/hooks.js';
import { NeedsAttentionCard } from '../components/NeedsAttentionCard.js';

export function NeedsAttention(): JSX.Element {
  const q = useNeedsAttention();
  const generate = useGenerateDraft();
  const [, setLocation] = useLocation();
  const [generatingId, setGeneratingId] = useState<string | null>(null);

  if (q.isLoading) return <p>Loading…</p>;
  if (q.error) return <p className="text-red-600">{(q.error as Error).message}</p>;
  const items = q.data ?? [];
  if (items.length === 0) return <p className="text-slate-500">Nothing needs attention.</p>;

  const onGenerate = (threadId: string): void => {
    setGeneratingId(threadId);
    generate.mutate(
      { threadId },
      {
        onSuccess: () => setLocation(`/threads/${threadId}`),
        onSettled: () => setGeneratingId(null),
      },
    );
  };

  return (
    <ul className="flex flex-col gap-2.5">
      {items.map((item) => (
        <NeedsAttentionCard
          key={item.id}
          item={item}
          onGenerate={onGenerate}
          generating={generatingId === item.id}
        />
      ))}
    </ul>
  );
}
