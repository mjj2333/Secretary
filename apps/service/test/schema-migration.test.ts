import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3-multiple-ciphers';
import { runMigrations } from '../server/db/migrate.js';
import { migrations } from '../server/db/migrations/index.js';

const TABLES = [
  'accounts',
  'messages',
  'threads',
  'contacts',
  'drafts',
  'follow_ups',
  'action_log',
  'settings',
  'push_subscriptions',
  'style_examples',
];

describe('0001_init migration', () => {
  it('creates every table from the brief schema', () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((r) => r.name);
    for (const t of TABLES) expect(names).toContain(t);
  });
});
