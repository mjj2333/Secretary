import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { makeTestServer } from './helpers/testServer.js';

const pwaDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'pwa');

describe('static PWA placeholder', () => {
  it('serves the placeholder page at / without auth', async () => {
    const { app } = await makeTestServer({ pwaDir });
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Secretary');
    await app.close();
  });

  it('still guards /api/v1 routes when serving static assets', async () => {
    const { app } = await makeTestServer({ pwaDir });
    const res = await app.inject({ method: 'GET', url: '/api/v1/settings' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
