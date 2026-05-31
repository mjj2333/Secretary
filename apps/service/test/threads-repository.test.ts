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

  it('applyClassification + setState update the right columns', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    withAccount(db);
    const repo = new ThreadsRepository(db);
    const id = repo.create('acc1', 'hello', ['a@b.com'], 1000);

    repo.applyClassification(id, {
      state: 'awaiting_your_reply',
      urgency: 'high',
      summary: 'Needs a reply',
      slaDeadline: 5000,
      stateChangedAt: 2000,
      stateReason: 'classified',
    });
    let t = repo.get(id)!;
    expect([t.state, t.urgency, t.last_agent_summary, t.sla_deadline]).toEqual([
      'awaiting_your_reply',
      'high',
      'Needs a reply',
      5000,
    ]);

    repo.setState(id, {
      state: 'awaiting_their_reply',
      slaDeadline: 9000,
      stateChangedAt: 3000,
      stateReason: 'outbound_sent',
    });
    t = repo.get(id)!;
    db.close();
    expect([t.state, t.sla_deadline, t.urgency]).toEqual(['awaiting_their_reply', 9000, 'high']); // urgency untouched
  });

  it('findNeedsClassification returns only unclassified threads', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    withAccount(db);
    const repo = new ThreadsRepository(db);
    const a = repo.create('acc1', 'a', [], 1000);
    const b = repo.create('acc1', 'b', [], 2000);
    repo.setState(b, {
      state: 'awaiting_your_reply',
      slaDeadline: null,
      stateChangedAt: 1,
      stateReason: 'x',
    });
    const ids = repo.findNeedsClassification().map((t) => t.id);
    db.close();
    expect(ids).toEqual([a]);
  });

  it('findSlaBreaches finds overdue active threads without a pending follow-up', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    withAccount(db);
    const repo = new ThreadsRepository(db);
    const overdue = repo.create('acc1', 'overdue', [], 1000);
    const future = repo.create('acc1', 'future', [], 1000);
    const informational = repo.create('acc1', 'fyi', [], 1000);
    repo.setState(overdue, {
      state: 'awaiting_your_reply',
      slaDeadline: 500,
      stateChangedAt: 1,
      stateReason: 'x',
    });
    repo.setState(future, {
      state: 'awaiting_your_reply',
      slaDeadline: 9999,
      stateChangedAt: 1,
      stateReason: 'x',
    });
    repo.setState(informational, {
      state: 'informational',
      slaDeadline: 500,
      stateChangedAt: 1,
      stateReason: 'x',
    });

    let ids = repo.findSlaBreaches(1000).map((t) => t.id);
    expect(ids).toEqual([overdue]); // future not due; informational not an active state

    db.prepare(
      `INSERT INTO follow_ups (id, thread_id, trigger_at, reason, status, created_at)
       VALUES ('f1', ?, 1000, 'sla_breach', 'pending', 1000)`,
    ).run(overdue);
    ids = repo.findSlaBreaches(1000).map((t) => t.id);
    db.close();
    expect(ids).toEqual([]); // suppressed once a pending follow-up exists
  });

  it('needsAttention returns awaiting_your_reply plus pending-follow-up threads, urgency then SLA ordered', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    withAccount(db);
    const repo = new ThreadsRepository(db);
    const high = repo.create('acc1', 'high', [], 1000);
    const normalSoon = repo.create('acc1', 'normal-soon', [], 1000);
    const normalLate = repo.create('acc1', 'normal-late', [], 1000);
    const followUpOnly = repo.create('acc1', 'follow', [], 1000);
    const ignored = repo.create('acc1', 'ignored', [], 1000);

    repo.applyClassification(high, {
      state: 'awaiting_your_reply',
      urgency: 'high',
      summary: 's',
      slaDeadline: 8000,
      stateChangedAt: 1,
      stateReason: 'x',
    });
    repo.applyClassification(normalSoon, {
      state: 'awaiting_your_reply',
      urgency: 'normal',
      summary: 's',
      slaDeadline: 3000,
      stateChangedAt: 1,
      stateReason: 'x',
    });
    repo.applyClassification(normalLate, {
      state: 'awaiting_your_reply',
      urgency: 'normal',
      summary: 's',
      slaDeadline: 9000,
      stateChangedAt: 1,
      stateReason: 'x',
    });
    repo.setState(followUpOnly, {
      state: 'awaiting_their_reply',
      slaDeadline: 1,
      stateChangedAt: 1,
      stateReason: 'x',
    });
    repo.setState(ignored, {
      state: 'closed',
      slaDeadline: null,
      stateChangedAt: 1,
      stateReason: 'x',
    });
    db.prepare(
      `INSERT INTO follow_ups (id, thread_id, trigger_at, reason, status, created_at)
       VALUES ('f1', ?, 1, 'sla_breach', 'pending', 1)`,
    ).run(followUpOnly);

    const rows = repo.needsAttention();
    db.close();
    // high urgency first; then normal by sla asc; follow-up-only thread (null urgency) last; closed excluded.
    expect(rows.map((r) => r.id)).toEqual([high, normalSoon, normalLate, followUpOnly]);
    expect(rows.find((r) => r.id === followUpOnly)?.has_pending).toBe(1);
  });
});
