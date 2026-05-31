import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadHttpsOptions } from '../server/httpsOptions.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'secretary-cert-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadHttpsOptions', () => {
  it('throws a helpful error when certs are missing', () => {
    expect(() => loadHttpsOptions(join(dir, 'x.pem'), join(dir, 'x-key.pem'))).toThrow(/mkcert/);
  });

  it('loads cert and key buffers when present', () => {
    const cert = join(dir, 'c.pem');
    const key = join(dir, 'c-key.pem');
    writeFileSync(cert, 'CERT');
    writeFileSync(key, 'KEY');
    const opts = loadHttpsOptions(cert, key);
    expect(opts.cert.toString()).toBe('CERT');
    expect(opts.key.toString()).toBe('KEY');
  });
});
