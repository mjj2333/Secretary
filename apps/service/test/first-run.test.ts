import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemorySecretStore } from '../server/auth/SecretStore.js';
import { evaluateFirstRun, NEEDS_SETUP_FILE } from '../server/setup/firstRun.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'secretary-setup-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('evaluateFirstRun', () => {
  it('needs setup and writes the flag when required secrets are missing', () => {
    const status = evaluateFirstRun(new InMemorySecretStore(), dir, false);
    expect(status.needsSetup).toBe(true);
    expect(existsSync(join(dir, NEEDS_SETUP_FILE))).toBe(true);
  });

  it('does not need setup once required secrets exist (local-direct: api key + payload key)', () => {
    const store = new InMemorySecretStore();
    store.set('app.gateway-api-key', 'x');
    store.set('app.payload-key', 'y');
    const status = evaluateFirstRun(store, dir, false);
    expect(status.needsSetup).toBe(false);
    expect(existsSync(join(dir, NEEDS_SETUP_FILE))).toBe(false);
  });

  it('requires the Cloudflare token when CF headers are enabled', () => {
    const store = new InMemorySecretStore();
    store.set('app.gateway-api-key', 'x');
    store.set('app.payload-key', 'y');
    const status = evaluateFirstRun(store, dir, true);
    expect(status.needsSetup).toBe(true);
    expect(status.missing).toContain('app.cf-access-id');
  });
});
