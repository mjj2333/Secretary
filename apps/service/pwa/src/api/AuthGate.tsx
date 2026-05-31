import { useEffect, useState, type ReactNode } from 'react';
import {
  bootstrapFromHash,
  exchangeBootstrap,
  getSession,
  SESSION_CLEARED_EVENT,
} from './session.js';

export function AuthGate({ children }: { children: ReactNode }): JSX.Element {
  const [authed, setAuthed] = useState<boolean>(() => getSession() !== null);
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (authed) return;
    void bootstrapFromHash()
      .then((did) => {
        if (did) setAuthed(true);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Bootstrap failed'));
  }, [authed]);

  useEffect(() => {
    const onCleared = (): void => setAuthed(false);
    window.addEventListener(SESSION_CLEARED_EVENT, onCleared);
    return () => window.removeEventListener(SESSION_CLEARED_EVENT, onCleared);
  }, []);

  if (authed) return <>{children}</>;

  return (
    <main className="mx-auto max-w-[480px] p-6">
      <h1 className="mb-2 text-lg font-semibold">Connect Secretary</h1>
      <p className="mb-4 text-sm text-slate-600">
        Paste the bootstrap token from <code>~/.secretary/bootstrap-token.txt</code>.
      </p>
      <input
        className="mb-2 w-full rounded border border-slate-300 p-2"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder="bootstrap token"
      />
      <button
        type="button"
        className="min-h-[44px] w-full rounded bg-slate-900 px-4 text-white"
        onClick={() => {
          setError(null);
          void exchangeBootstrap(token.trim())
            .then(() => setAuthed(true))
            .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Exchange failed'));
        }}
      >
        Connect
      </button>
      {error ? <p className="mt-2 text-sm text-red-600">{error}</p> : null}
    </main>
  );
}
