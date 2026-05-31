import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemorySecretStore } from '../server/auth/SecretStore.js';
import { openDatabase } from '../server/db/connection.js';
import { ThreadsRepository } from '../server/db/repositories/ThreadsRepository.js';
import { FollowUpsRepository } from '../server/db/repositories/FollowUpsRepository.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'secretary-followups-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('FollowUpsRepository', () => {
  it('inserts, reports pending, lists, dismisses and resolves', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    db.prepare(
      `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','A','a@b.com')`,
    ).run();
    const threadId = new ThreadsRepository(db).create('acc1', 'hello', [], 1000);
    const repo = new FollowUpsRepository(db);

    expect(repo.hasPending(threadId)).toBe(false);
    const id = repo.insert({ threadId, triggerAt: 1000, reason: 'sla_breach', createdAt: 1000 });
    expect(id).toMatch(/[0-9a-f-]{36}/);
    expect(repo.hasPending(threadId)).toBe(true);
    expect(repo.listPending().map((f) => f.id)).toEqual([id]);

    repo.dismiss(id);
    expect(repo.hasPending(threadId)).toBe(false);
    expect(repo.listPending()).toHaveLength(0);

    const id2 = repo.insert({ threadId, triggerAt: 2000, reason: 'sla_breach', createdAt: 2000 });
    repo.resolve(id2);
    const row = db.prepare('SELECT status, resolved_at FROM follow_ups WHERE id = ?').get(id2) as {
      status: string;
      resolved_at: number | null;
    };
    db.close();
    expect(row.status).toBe('resolved');
    expect(row.resolved_at).not.toBeNull();
  });
});
