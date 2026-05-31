import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from './client.js';
import { setSession, getSession } from './session.js';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

function mockFetch(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  );
}

describe('apiFetch', () => {
  it('unwraps {data} and injects the bearer token', async () => {
    setSession('sess-123');
    mockFetch(200, { data: { ok: true } });
    const out = await apiFetch<{ ok: boolean }>('/threads/needs-attention');
    expect(out).toEqual({ ok: true });
    const call = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    const init = call[1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sess-123');
    expect(call[0]).toBe('/api/v1/threads/needs-attention');
  });

  it('throws ApiError on an {error} envelope', async () => {
    setSession('s');
    mockFetch(400, { error: { code: 'validation_error', message: 'bad' } });
    await expect(apiFetch('/drafts')).rejects.toMatchObject({
      code: 'validation_error',
      status: 400,
    });
  });

  it('clears the session and throws on 401', async () => {
    setSession('s');
    mockFetch(401, { error: { code: 'unauthorized', message: 'no' } });
    await expect(apiFetch('/threads')).rejects.toBeInstanceOf(ApiError);
    expect(getSession()).toBeNull();
  });
});
