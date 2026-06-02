import { useState } from 'react';
import { useSettings } from '../api/hooks.js';
import { enablePush, sendTestPush, type EnableResult } from '../push/subscribe.js';

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
