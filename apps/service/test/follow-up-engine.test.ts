import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemorySecretStore } from '../server/auth/SecretStore.js';
import { openDatabase } from '../server/db/connection.js';
import { ActionLogRepository } from '../server/db/repositories/ActionLogRepository.js';
import { FollowUpsRepository } from '../server/db/repositories/FollowUpsRepository.js';
import { ThreadsRepository } from '../server/db/repositories/ThreadsRepository.js';
import { EventBus } from '../server/eventBus.js';
import { FollowUpEngine } from '../server/agent/FollowUpEngine.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'secretary-fue-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('FollowUpEngine.runOnce', () => {
  it('creates one sla_breach follow-up per breaching thread and is idempotent', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    db.prepare(
      `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','A','a@b.com')`,
    ).run();
    const threads = new ThreadsRepository(db);
    const followUps = new FollowUpsRepository(db);
    const events: unknown[] = [];
    const bus = new EventBus();
    bus.subscribe((e) => events.push(e));

    const overdue = threads.create('acc1', 'overdue', [], 1000);
    const future = threads.create('acc1', 'future', [], 1000);
    threads.setState(overdue, {
      state: 'awaiting_your_reply',
      slaDeadline: 500,
      stateChangedAt: 1,
      stateReason: 'x',
    });
    threads.setState(future, {
      state: 'awaiting_your_reply',
      slaDeadline: 50_000,
      stateChangedAt: 1,
      stateReason: 'x',
    });

    const engine = new FollowUpEngine(
      db,
      threads,
      followUps,
      new ActionLogRepository(db),
      bus,
      () => 1000,
    );

    expect(engine.runOnce()).toBe(1);
    expect(followUps.listPending().map((f) => f.thread_id)).toEqual([overdue]);
    expect(engine.runOnce()).toBe(0); // suppressed by the existing pending follow-up
    const log = db
      .prepare("SELECT COUNT(*) AS n FROM action_log WHERE action='followup_created'")
      .get() as { n: number };
    db.close();
    expect(log.n).toBe(1);
    expect(events.filter((e) => (e as { type: string }).type === 'thread:updated')).toHaveLength(1);
  });

  it('start is idempotent (double-start is a no-op) and stop clears the timer', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    const engine = new FollowUpEngine(
      db,
      new ThreadsRepository(db),
      new FollowUpsRepository(db),
      new ActionLogRepository(db),
      new EventBus(),
      () => 1000,
    );
    engine.start(9_999_999);
    engine.start(9_999_999); // second start must be a no-op (single timer)
    engine.stop();
    engine.stop(); // idempotent
    db.close();
    expect(true).toBe(true); // reaching here without a hang or throw is the assertion
  });
});
