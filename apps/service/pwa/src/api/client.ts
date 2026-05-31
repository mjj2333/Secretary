import { getSession, clearSession } from './session.js';

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface Envelope<T> {
  data?: T;
  error?: { code: string; message: string };
}

/** Fetch wrapper: prefixes /api/v1, injects the bearer, unwraps {data}/{error}. */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const session = getSession();
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (session) headers.authorization = `Bearer ${session}`;
  const res = await fetch(`/api/v1${path}`, { ...init, headers });
  if (res.status === 401) {
    clearSession();
    throw new ApiError('unauthorized', 'Session expired', 401);
  }
  let body: Envelope<T>;
  try {
    body = (await res.json()) as Envelope<T>;
  } catch {
    throw new ApiError('bad_response', `Non-JSON response (${res.status})`, res.status);
  }
  if (!res.ok || body.error) {
    const e = body.error ?? { code: 'error', message: `Request failed (${res.status})` };
    throw new ApiError(e.code, e.message, res.status);
  }
  return body.data as T;
}
