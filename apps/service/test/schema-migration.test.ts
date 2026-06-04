import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3-multiple-ciphers';
import { runMigrations } from '../server/db/migrate.js';
import { migrations } from '../server/db/migrations/index.js';
import { InMemorySecretStore } from '../server/auth/SecretStore.js';
import { openDatabase } from '../server/db/connection.js';

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

describe('migration 0002 (phase 6b)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'secretary-mig2-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('adds style_examples.status (default approved) and drafts.generated_body_text', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    db.prepare(
      `INSERT INTO style_examples (id, contact_category, context_summary, reply_text) VALUES ('s1','vendor','c','r')`,
    ).run();
    const ex = db.prepare("SELECT status FROM style_examples WHERE id='s1'").get() as {
      status: string;
    };
    const cols = (db.prepare('PRAGMA table_info(drafts)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    db.close();
    expect(ex.status).toBe('approved');
    expect(cols).toContain('generated_body_text');
  });

  it('accepts pending/approved/rejected status and rejects others', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    for (const status of ['pending', 'approved', 'rejected']) {
      db.prepare(
        `INSERT INTO style_examples (id, contact_category, context_summary, reply_text, status) VALUES (?, 'vendor', 'c', 'r', ?)`,
      ).run(`id-${status}`, status);
    }
    const count = (db.prepare('SELECT COUNT(*) AS n FROM style_examples').get() as { n: number }).n;
    const bad = (): void => {
      db.prepare(
        `INSERT INTO style_examples (id, contact_category, context_summary, reply_text, status) VALUES ('bad','vendor','c','r','flagged')`,
      ).run();
    };
    expect(bad).toThrow();
    db.close();
    expect(count).toBe(3);
  });
});
