import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3-multiple-ciphers';

describe('native module smoke test', () => {
  it('loads better-sqlite3-multiple-ciphers and runs a query', () => {
    const db = new Database(':memory:');
    const row = db.prepare('SELECT 1 AS n').get() as { n: number };
    db.close();
    expect(row.n).toBe(1);
  });
});
