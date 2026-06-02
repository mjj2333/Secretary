import { describe, expect, it } from 'vitest';
import { makeTestServer } from './helpers/testServer.js';

describe('settings routes', () => {
  it('GET returns seeded settings for an authenticated request', async () => {
    const { app, session } = await makeTestServer();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/settings',
      headers: { authorization: `Bearer ${session}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data['llm.model']).toBe('qwen2.5:14b-instruct-q5_K_M');
    await app.close();
  });

  it('PATCH updates a key and returns the merged view', async () => {
    const { app, session } = await makeTestServer();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers: { authorization: `Bearer ${session}` },
      payload: { 'agent.poll_interval_seconds': 30 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data['agent.poll_interval_seconds']).toBe(30);
    await app.close();
  });

  it('rejects an unauthenticated GET /settings', async () => {
    const { app } = await makeTestServer();
    const res = await app.inject({ method: 'GET', url: '/api/v1/settings' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('GET /settings/style-guide returns the baseline + isDefault when unset', async () => {
    const { app, session } = await makeTestServer();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/settings/style-guide',
      headers: { authorization: `Bearer ${session}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.isDefault).toBe(true);
    expect(res.json().data.styleGuide.length).toBeGreaterThan(0);
    await app.close();
  });

  it('GET /settings/style-guide returns the override when style_guide is set', async () => {
    const { app, session } = await makeTestServer();
    await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers: { authorization: `Bearer ${session}` },
      payload: { style_guide: 'Write tersely.' },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/settings/style-guide',
      headers: { authorization: `Bearer ${session}` },
    });
    expect(res.json().data).toEqual({ styleGuide: 'Write tersely.', isDefault: false });
    await app.close();
  });
});
