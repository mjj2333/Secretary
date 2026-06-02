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

  it('rejects an unauthenticated subscribe', async () => {
    const { app } = await makeTestServer();
    const res = await app.inject({ method: 'POST', url: '/api/v1/push/subscribe', payload: SUB });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('GET /push/vapid-public-key returns the key when push is configured', async () => {
    const fakePush = {
      publicKey: 'BPUBLICKEY',
      sendTest: async () => ({ sent: 2 }),
      notifyDraftReady: async () => {},
    };
    const { app, session } = await makeTestServer({ push: fakePush });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/push/vapid-public-key',
      headers: { authorization: `Bearer ${session}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.publicKey).toBe('BPUBLICKEY');
    await app.close();
  });

  it('push endpoints 409 when push is not configured', async () => {
    const { app, session } = await makeTestServer();
    const key = await app.inject({
      method: 'GET',
      url: '/api/v1/push/vapid-public-key',
      headers: { authorization: `Bearer ${session}` },
    });
    const test = await app.inject({
      method: 'POST',
      url: '/api/v1/push/test',
      headers: { authorization: `Bearer ${session}` },
      payload: {},
    });
    expect(key.statusCode).toBe(409);
    expect(test.statusCode).toBe(409);
    expect(key.json().error.code).toBe('push_not_configured');
    expect(test.json().error.code).toBe('push_not_configured');
    await app.close();
  });

  it('POST /push/test triggers sendTest when configured', async () => {
    let called = 0;
    const fakePush = {
      publicKey: 'B',
      sendTest: async () => {
        called += 1;
        return { sent: 3 };
      },
      notifyDraftReady: async () => {},
    };
    const { app, session } = await makeTestServer({ push: fakePush });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/push/test',
      headers: { authorization: `Bearer ${session}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.sent).toBe(3);
    expect(called).toBe(1);
    await app.close();
  });
});
