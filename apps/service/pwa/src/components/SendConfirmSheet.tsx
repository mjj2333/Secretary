import type { DraftView } from '@secretary/shared-types';

export function SendConfirmSheet({
  draft,
  sending,
  onCancel,
  onConfirm,
}: {
  draft: DraftView;
  sending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}): JSX.Element {
  const to = draft.to[0]?.address ?? '(no recipient)';
  return (
    <div
      className="fixed inset-0 z-20 flex items-end justify-center bg-slate-900/35"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-[720px] rounded-t-2xl bg-white p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-[15px] font-bold text-slate-900">Send this draft as-is?</h2>
        <p className="mb-3 mt-1 text-xs text-slate-500">
          To: {to} · {draft.subject ?? '(no subject)'}
        </p>
        <div className="flex gap-2.5">
          <button
            type="button"
            onClick={onCancel}
            className="min-h-[44px] flex-1 rounded-lg border border-slate-300 text-slate-700"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={sending}
            onClick={onConfirm}
            className="min-h-[44px] flex-1 rounded-lg bg-slate-900 font-semibold text-white disabled:opacity-50"
          >
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}
