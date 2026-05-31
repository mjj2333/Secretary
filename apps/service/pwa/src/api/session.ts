const KEY = 'secretary.session';

export function getSession(): string | null {
  return localStorage.getItem(KEY);
}
export function setSession(token: string): void {
  localStorage.setItem(KEY, token);
}
/** Event dispatched (same-tab) whenever the stored session is cleared, so the auth gate can re-gate. */
export const SESSION_CLEARED_EVENT = 'secretary:session-cleared';

export function clearSession(): void {
  localStorage.removeItem(KEY);
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(SESSION_CLEARED_EVENT));
}

/** Exchange a bootstrap token for a session token and store it. Returns the session token. */
export async function exchangeBootstrap(bootstrapToken: string): Promise<string> {
  const res = await fetch('/api/v1/auth/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bootstrapToken }),
  });
  const body = (await res.json()) as { data?: { token: string }; error?: { message: string } };
  if (!res.ok || !body.data) {
    throw new Error(body.error?.message ?? `Bootstrap exchange failed (${res.status})`);
  }
  setSession(body.data.token);
  return body.data.token;
}

/** If the URL carries #bootstrap=<token>, exchange it and clear the hash. Returns true if it did. */
export async function bootstrapFromHash(): Promise<boolean> {
  const m = window.location.hash.match(/bootstrap=([^&]+)/);
  if (!m || !m[1]) return false;
  await exchangeBootstrap(decodeURIComponent(m[1]));
  history.replaceState(null, '', window.location.pathname + window.location.search);
  return true;
}
