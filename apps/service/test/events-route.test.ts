import { afterEach, describe, expect, it } from 'vitest';
import { makeTestServer } from './helpers/testServer.js';

afterEach(() => {
  delete process.env.SSE_TEST_CLOSE_MS;
});

describe('SSE events route', () => {
  it('streams an emitted event as an SSE data frame', async () => {
    process.env.SSE_TEST_CLOSE_MS = '150';
    const { app, session, eventBus } = await makeTestServer();
    // Emit shortly after the request handler has subscribed.
    setTimeout(() => eventBus.emit({ type: 'thread:updated', payload: { id: 't1' } }), 40);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/events',
      headers: { authorization: `Bearer ${session}`, accept: 'text/event-stream' },
    });

    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain('event: thread:updated');
    expect(res.body).toContain('"id":"t1"');
    await app.close();
  });

  it('requires authentication', async () => {
    const { app } = await makeTestServer();
    const res = await app.inject({ method: 'GET', url: '/api/v1/events' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
