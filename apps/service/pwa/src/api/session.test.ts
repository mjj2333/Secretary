import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearSession, exchangeBootstrap, getSession, setSession } from './session.js';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('session', () => {
  it('get/set/clear round-trips via localStorage', () => {
    expect(getSession()).toBeNull();
    setSession('abc');
    expect(getSession()).toBe('abc');
    clearSession();
    expect(getSession()).toBeNull();
  });

  it('exchangeBootstrap posts the token and stores the returned session', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: { token: 'sess-xyz', expiresAt: 1 } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    const tok = await exchangeBootstrap('boot-123');
    expect(tok).toBe('sess-xyz');
    expect(getSession()).toBe('sess-xyz');
    const call = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    expect(call[0]).toBe('/api/v1/auth/session');
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({
      bootstrapToken: 'boot-123',
    });
  });
});
