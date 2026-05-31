import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestServer } from './helpers/testServer.js';

let pwaDir: string;
beforeEach(() => {
  pwaDir = mkdtempSync(join(tmpdir(), 'secretary-pwa-'));
  writeFileSync(
    join(pwaDir, 'index.html'),
    '<!doctype html><title>Secretary SPA</title><div id="root"></div>',
  );
  mkdirSync(join(pwaDir, 'assets'));
  writeFileSync(join(pwaDir, 'assets', 'app.js'), 'console.log("app");');
});
afterEach(() => {
  rmSync(pwaDir, { recursive: true, force: true });
});

describe('SPA serving', () => {
  it('serves index.html at / and a built asset', async () => {
    const { app } = await makeTestServer({ pwaDir });
    const root = await app.inject({ method: 'GET', url: '/' });
    const asset = await app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain('Secretary SPA');
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toContain('console.log');
    await app.close();
  });

  it('falls back to index.html for a client route (SPA routing)', async () => {
    const { app } = await makeTestServer({ pwaDir });
    const res = await app.inject({ method: 'GET', url: '/needs-attention' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Secretary SPA');
    await app.close();
  });

  it('keeps the {error} 404 for unknown /api/v1 routes (no SPA fallback)', async () => {
    const { app, session } = await makeTestServer({ pwaDir });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/does-not-exist',
      headers: { authorization: `Bearer ${session}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
    await app.close();
  });
});
