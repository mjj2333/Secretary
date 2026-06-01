import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import {
  useThread,
  useGenerateDraft,
  useRegenerateDraft,
  useEditDraft,
  useDiscardDraft,
  useSendDraft,
} from '../api/hooks.js';
import { MessageList } from '../components/MessageList.js';
import { DraftPanel } from '../components/DraftPanel.js';
import { SendConfirmSheet } from '../components/SendConfirmSheet.js';

export function ThreadView({ id }: { id: string }): JSX.Element {
  const q = useThread(id);
  const generate = useGenerateDraft();
  const regenerate = useRegenerateDraft();
  const edit = useEditDraft();
  const discard = useDiscardDraft();
  const send = useSendDraft();
  const [, setLocation] = useLocation();

  const draft = q.data?.currentDraft ?? null;
  const [body, setBody] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Re-seed the editor when a new draft version arrives (generate/regenerate).
  useEffect(() => {
    if (draft) setBody(draft.bodyText);
  }, [draft?.id, draft?.version]);

  if (q.isLoading) return <p>Loading…</p>;
  if (q.error) return <p className="text-red-600">{(q.error as Error).message}</p>;
  const t = q.data;
  if (!t) return <p>Not found.</p>;

  const busy =
    generate.isPending ||
    regenerate.isPending ||
    edit.isPending ||
    discard.isPending ||
    send.isPending;
  const fail = (e: unknown): void =>
    setErr(e instanceof Error ? e.message : 'Something went wrong');

  return (
    <div className="flex min-h-[70vh] flex-col">
      <h2 className="mb-1 font-semibold">{t.subject ?? '(no subject)'}</h2>
      <p className="mb-3 text-xs text-slate-500">
        {t.senderName} · {t.state}
      </p>

      <MessageList messages={t.messages} />

      <div className="mt-4 flex flex-1 flex-col">
        {err ? <p className="mb-2 text-sm text-red-600">{err}</p> : null}
        {draft ? (
          <DraftPanel
            draft={draft}
            body={body}
            busy={busy}
            onBodyChange={setBody}
            onRegenerate={() => {
              setErr(null);
              regenerate.mutate({ threadId: id }, { onError: fail });
            }}
            onEditIntent={(intent) => {
              setErr(null);
              regenerate.mutate({ threadId: id, rawIntent: intent }, { onError: fail });
            }}
            onDiscard={() => {
              setErr(null);
              discard.mutate({ draftId: draft.id, threadId: id }, { onError: fail });
            }}
            onSend={() => setConfirming(true)}
          />
        ) : (
          <div className="flex flex-col items-center gap-3 py-8">
            <p className="text-sm text-slate-500">No draft yet.</p>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setErr(null);
                generate.mutate({ threadId: id }, { onError: fail });
              }}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {generate.isPending ? 'Generating…' : 'Generate draft'}
            </button>
          </div>
        )}
      </div>

      {confirming && draft ? (
        <SendConfirmSheet
          draft={draft}
          sending={send.isPending || edit.isPending}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setErr(null);
            // Save the current body, then send (what you see is what sends).
            // The UI edits only the body; subject is left as-is (omitted from the PATCH).
            edit.mutate(
              { draftId: draft.id, threadId: id, bodyText: body },
              {
                onError: (e) => {
                  setConfirming(false);
                  fail(e);
                },
                onSuccess: () => {
                  send.mutate(
                    { draftId: draft.id, threadId: id },
                    {
                      onSuccess: () => {
                        setConfirming(false);
                        setLocation('/needs-attention');
                      },
                      onError: (e) => {
                        setConfirming(false);
                        fail(e);
                      },
                    },
                  );
                },
              },
            );
          }}
        />
      ) : null}
    </div>
  );
}
