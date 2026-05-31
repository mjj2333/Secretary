import { describe, expect, it } from 'vitest';
import { makeTestServer } from './helpers/testServer.js';

describe('auth routes', () => {
  it('rejects an invalid bootstrap token with a 401 envelope', async () => {
    const { app } = await makeTestServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/session',
      payload: { bootstrapToken: 'wrong' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthorized');
    await app.close();
  });

  it('exchanges a valid bootstrap token for a session token', async () => {
    const { app, bootstrap } = await makeTestServer({ consumeBootstrap: false });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/session',
      payload: { bootstrapToken: bootstrap },
    });
    expect(res.statusCode).toBe(200);
    expect(typeof res.json().data.token).toBe('string');
    expect(typeof res.json().data.expiresAt).toBe('string');
    await app.close();
  });

  it('DELETE /auth/session revokes sessions (token no longer authorizes)', async () => {
    const { app, bootstrap } = await makeTestServer({ consumeBootstrap: false });
    const ex = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/session',
      payload: { bootstrapToken: bootstrap },
    });
    const token = ex.json().data.token as string;

    // Revoke requires auth (it is NOT a public route); present the session token.
    const del = await app.inject({
      method: 'DELETE',
      url: '/api/v1/auth/session',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().data.revoked).toBe(true);

    // After revokeAll, the previously-issued token must fail on a protected route.
    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/protected-probe',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(after.statusCode).toBe(401);
    await app.close();
  });

  it('rejects an unauthenticated DELETE /auth/session', async () => {
    const { app } = await makeTestServer();
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/auth/session' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthorized');
    await app.close();
  });
});
