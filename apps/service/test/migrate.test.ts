import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3-multiple-ciphers';
import { runMigrations } from '../server/db/migrate.js';

const M1 = {
  version: 1,
  name: 'create_widgets',
  sql: 'CREATE TABLE widgets (id INTEGER PRIMARY KEY);',
};

describe('runMigrations', () => {
  it('applies pending migrations and records them', () => {
    const db = new Database(':memory:');
    const applied = runMigrations(db, [M1]);
    expect(applied).toEqual([1]);
    const row = db.prepare('SELECT COUNT(*) AS n FROM _migrations').get() as { n: number };
    expect(row.n).toBe(1);
  });

  it('is idempotent — running again applies nothing', () => {
    const db = new Database(':memory:');
    runMigrations(db, [M1]);
    const second = runMigrations(db, [M1]);
    expect(second).toEqual([]);
  });
});
