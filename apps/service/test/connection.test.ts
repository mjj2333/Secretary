import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3-multiple-ciphers';
import { InMemorySecretStore } from '../server/auth/SecretStore.js';
import { openDatabase, DB_KEY_SECRET } from '../server/db/connection.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'secretary-db-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('openDatabase', () => {
  it('generates and stores a db key on first run, applies migrations and seeds', () => {
    const store = new InMemorySecretStore();
    const db = openDatabase(join(dir, 'secretary.db'), store);
    expect(store.has(DB_KEY_SECRET)).toBe(true);
    const settings = db.prepare('SELECT COUNT(*) AS n FROM settings').get() as { n: number };
    expect(settings.n).toBeGreaterThan(0);
    db.close();
  });

  it('fails to read the encrypted file with a wrong key', () => {
    const store = new InMemorySecretStore();
    const dbPath = join(dir, 'secretary.db');
    openDatabase(dbPath, store).close();

    const wrong = new Database(dbPath);
    wrong.pragma(`key='${'0'.repeat(64)}'`);
    expect(() => wrong.prepare('SELECT COUNT(*) FROM settings').get()).toThrow();
    wrong.close();
  });
});
