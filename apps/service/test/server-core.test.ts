import { describe, expect, it } from 'vitest';
import { makeTestServer } from './helpers/testServer.js';

describe('server core', () => {
  it('serves unauthenticated health', async () => {
    const { app } = await makeTestServer();
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: { ok: true } });
    await app.close();
  });

  it('rejects an unauthenticated protected route with the error envelope', async () => {
    const { app } = await makeTestServer();
    const res = await app.inject({ method: 'GET', url: '/api/v1/settings' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthorized');
    await app.close();
  });
});
