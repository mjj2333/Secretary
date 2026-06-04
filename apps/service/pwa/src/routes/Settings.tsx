import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { useSettings, useStyleGuide, useSaveStyleGuide } from '../api/hooks.js';
import { enablePush, sendTestPush, type EnableResult } from '../push/subscribe.js';

function StyleGuideEditor(): JSX.Element {
  const q = useStyleGuide();
  const save = useSaveStyleGuide();
  const [text, setText] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (q.data) setText(q.data.styleGuide);
  }, [q.data?.styleGuide]);

  if (q.isLoading) return <p>Loading…</p>;
  if (q.error) return <p className="text-red-600">{(q.error as Error).message}</p>;

  const onSave = (value: string): void => {
    setMsg(null);
    save.mutate(
      { styleGuide: value },
      {
        onSuccess: () => setMsg(value.trim() ? 'Saved.' : 'Reset to default.'),
        onError: (e: unknown) => setMsg(e instanceof Error ? e.message : 'Save failed'),
      },
    );
  };

  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold text-slate-900">
        Voice / style guide{q.data?.isDefault ? ' (using default)' : ''}
      </h2>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="min-h-[200px] w-full rounded-lg border border-slate-300 p-2.5 text-[13px] leading-relaxed"
      />
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          disabled={save.isPending}
          onClick={() => onSave(text)}
          className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          Save
        </button>
        <button
          type="button"
          disabled={save.isPending}
          onClick={() => {
            setText('');
            onSave('');
          }}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 disabled:opacity-50"
        >
          Reset to default
        </button>
      </div>
      {msg ? <p className="mt-1 text-xs text-slate-600">{msg}</p> : null}
      <Link href="/voice/examples" className="block text-sm text-sky-700 underline">
        Review mined style examples →
      </Link>
    </section>
  );
}

export function Settings(): JSX.Element {
  const q = useSettings();
  const [pushState, setPushState] = useState<string>(
    typeof Notification !== 'undefined' ? Notification.permission : 'unsupported',
  );
  const [msg, setMsg] = useState<string | null>(null);

  const onEnable = (): void => {
    setMsg(null);
    enablePush()
      .then((r: EnableResult) => {
        setPushState(r);
        setMsg(
          r === 'subscribed'
            ? 'Notifications enabled.'
            : r === 'denied'
              ? 'Permission denied.'
              : 'Not supported on this browser.',
        );
      })
      .catch((e: unknown) => setMsg(e instanceof Error ? e.message : 'Failed to enable'));
  };
  const onTest = (): void => {
    setMsg(null);
    sendTestPush()
      .then((sent) => setMsg(`Test sent to ${sent} subscription(s).`))
      .catch((e: unknown) => setMsg(e instanceof Error ? e.message : 'Test failed'));
  };

  return (
    <div className="flex flex-col gap-4">
      <StyleGuideEditor />
      <section>
        <h2 className="mb-2 text-sm font-semibold text-slate-900">Notifications</h2>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onEnable}
            className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white"
          >
            Enable notifications
          </button>
          <button
            type="button"
            onClick={onTest}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700"
          >
            Send test
          </button>
        </div>
        <p className="mt-2 text-xs text-slate-500">Permission: {pushState}</p>
        {msg ? <p className="mt-1 text-xs text-slate-600">{msg}</p> : null}
      </section>
      <section>
        <h2 className="mb-2 text-sm font-semibold text-slate-900">Settings</h2>
        {q.isLoading ? (
          <p>Loading…</p>
        ) : q.error ? (
          <p className="text-red-600">{(q.error as Error).message}</p>
        ) : (
          <pre className="overflow-auto text-xs">{JSON.stringify(q.data ?? {}, null, 2)}</pre>
        )}
      </section>
    </div>
  );
}
