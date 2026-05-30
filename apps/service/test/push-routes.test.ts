import { describe, expect, it } from 'vitest';
import { makeTestServer } from './helpers/testServer.js';

const SUB = { endpoint: 'https://push.example/x', keys: { p256dh: 'p', auth: 'a' } };

describe('push routes', () => {
  it('subscribes successfully for an authenticated request', async () => {
    const { app, session } = await makeTestServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/push/subscribe',
      headers: { authorization: `Bearer ${session}` },
      payload: SUB,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.subscribed).toBe(true);
    await app.close();
  });

  it('push/test reports not configured until VAPID exists (Phase 5.5)', async () => {
    const { app, session } = await makeTestServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/push/test',
      headers: { authorization: `Bearer ${session}` },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('push_not_configured');
    await app.close();
  });

  it('rejects an unauthenticated subscribe', async () => {
    const { app } = await makeTestServer();
    const res = await app.inject({ method: 'POST', url: '/api/v1/push/subscribe', payload: SUB });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
