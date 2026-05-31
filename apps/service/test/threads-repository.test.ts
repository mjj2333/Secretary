import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemorySecretStore } from '../server/auth/SecretStore.js';
import { openDatabase } from '../server/db/connection.js';
import { ThreadsRepository } from '../server/db/repositories/ThreadsRepository.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'secretary-threads-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function withAccount(db: ReturnType<typeof openDatabase>) {
  db.prepare(
    `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','A','a@b.com')`,
  ).run();
}

describe('ThreadsRepository', () => {
  it('creates a thread and finds it by normalized subject', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    withAccount(db);
    const repo = new ThreadsRepository(db);
    const id = repo.create('acc1', 'hello world', ['a@b.com'], 1000);
    const found = repo.threadIdForSubject('acc1', 'hello world');
    db.close();
    expect(found).toBe(id);
  });

  it('lists threads for an account ordered by last_message_at desc', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    withAccount(db);
    const repo = new ThreadsRepository(db);
    const a = repo.create('acc1', 'older', [], 1000);
    const b = repo.create('acc1', 'newer', [], 2000);
    repo.touch(a, { lastMessageAt: 1000 });
    repo.touch(b, { lastMessageAt: 2000 });
    const list = repo.listByAccount('acc1', 10, 0);
    db.close();
    expect(list.map((t) => t.id)).toEqual([b, a]);
  });
});
