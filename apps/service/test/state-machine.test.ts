import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClassificationResult, ThreadState } from '@secretary/shared-types';
import { NotFoundError } from '@secretary/shared-types';
import { InMemorySecretStore } from '../server/auth/SecretStore.js';
import { openDatabase } from '../server/db/connection.js';
import { ActionLogRepository } from '../server/db/repositories/ActionLogRepository.js';
import { ContactsRepository } from '../server/db/repositories/ContactsRepository.js';
import { SettingsRepository } from '../server/db/repositories/SettingsRepository.js';
import { ThreadsRepository } from '../server/db/repositories/ThreadsRepository.js';
import { EventBus } from '../server/eventBus.js';
import {
  nextStateForInbound,
  nextStateForOutbound,
  StateMachine,
} from '../server/agent/StateMachine.js';
import type { MessageRow, ThreadRow } from '../server/db/schema.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'secretary-sm-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('nextStateForInbound', () => {
  const cases: Array<[ThreadState, boolean, ThreadState]> = [
    ['needs_classification', true, 'awaiting_your_reply'],
    ['needs_classification', false, 'informational'],
    ['awaiting_their_reply', true, 'awaiting_your_reply'],
    ['awaiting_their_reply', false, 'informational'],
    ['awaiting_your_reply', true, 'awaiting_your_reply'],
    ['awaiting_your_reply', false, 'awaiting_your_reply'],
    ['informational', true, 'awaiting_your_reply'],
    ['informational', false, 'informational'],
    ['scheduled_followup', true, 'awaiting_your_reply'],
    ['scheduled_followup', false, 'scheduled_followup'],
    ['closed', true, 'awaiting_your_reply'],
    ['closed', false, 'closed'],
  ];
  it.each(cases)('%s + requires=%s -> %s', (prev, requires, expected) => {
    expect(nextStateForInbound(prev, requires)).toBe(expected);
  });
  it('outbound is always awaiting_their_reply', () => {
    expect(nextStateForOutbound()).toBe('awaiting_their_reply');
  });
});

function makeSM(db: ReturnType<typeof openDatabase>, now = () => 10_000): StateMachine {
  return new StateMachine(
    new ThreadsRepository(db),
    new ContactsRepository(db),
    new SettingsRepository(db),
    new ActionLogRepository(db),
    new EventBus(),
    now,
  );
}

describe('StateMachine SLA + writes', () => {
  it('computes awaiting_your_reply SLA from last_inbound_at by contact category', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    const sm = makeSM(db);
    const thread = { last_inbound_at: 1_000, last_outbound_at: null } as ThreadRow;
    // client_new = 4h (seeded), client_established = 12h, unknown -> 24h fallback
    expect(sm.computeSlaDeadline('awaiting_your_reply', 'client_new', thread)).toBe(
      1_000 + 4 * 3_600_000,
    );
    expect(sm.computeSlaDeadline('awaiting_your_reply', 'client_established', thread)).toBe(
      1_000 + 12 * 3_600_000,
    );
    expect(sm.computeSlaDeadline('awaiting_your_reply', 'vendor', thread)).toBe(
      1_000 + 24 * 3_600_000,
    );
    db.close();
  });

  it('computes awaiting_their_reply SLA from last_outbound_at and nulls non-active states', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    const sm = makeSM(db);
    const thread = { last_inbound_at: null, last_outbound_at: 2_000 } as ThreadRow;
    expect(sm.computeSlaDeadline('awaiting_their_reply', 'unknown', thread)).toBe(
      2_000 + 72 * 3_600_000,
    );
    expect(sm.computeSlaDeadline('informational', 'unknown', thread)).toBeNull();
    expect(sm.computeSlaDeadline('closed', 'unknown', thread)).toBeNull();
    db.close();
  });

  it('onInboundClassified returns state/urgency/sla using the sender category', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    db.prepare(
      `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','A','a@b.com')`,
    ).run();
    const contacts = new ContactsRepository(db);
    contacts.recordSeen({ address: 'vip@client.com' }, 'inbound', 500);
    contacts.patch(contacts.findByEmail('vip@client.com')!.id, { category: 'client_new' });
    const sm = makeSM(db);
    const thread = {
      state: 'needs_classification',
      last_inbound_at: 1_000,
      last_outbound_at: null,
    } as ThreadRow;
    const result: ClassificationResult = {
      intent: 'booking_request',
      category_suggestion: 'client_new',
      urgency: 'high',
      requires_response: true,
      summary: 'Wants a booking',
    };
    const message = { from_address: 'vip@client.com' } as MessageRow;
    const out = sm.onInboundClassified(thread, result, message);
    db.close();
    expect(out).toEqual({
      state: 'awaiting_your_reply',
      urgency: 'high',
      slaDeadline: 1_000 + 4 * 3_600_000,
    });
  });

  it('onOutbound writes awaiting_their_reply + SLA and logs', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    db.prepare(
      `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','A','a@b.com')`,
    ).run();
    const threads = new ThreadsRepository(db);
    const id = threads.create('acc1', 'hi', [], 1000);
    threads.touch(id, { lastOutboundAt: 2_000 });
    makeSM(db).onOutbound(id);
    const t = threads.get(id)!;
    const log = db
      .prepare("SELECT COUNT(*) AS n FROM action_log WHERE action='state_outbound'")
      .get() as { n: number };
    db.close();
    expect(t.state).toBe('awaiting_their_reply');
    expect(t.sla_deadline).toBe(2_000 + 72 * 3_600_000);
    expect(log.n).toBe(1);
  });

  it('onManual sets the state, clears SLA for closed, and logs a user override', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    db.prepare(
      `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','A','a@b.com')`,
    ).run();
    const threads = new ThreadsRepository(db);
    const id = threads.create('acc1', 'hi', [], 1000);
    makeSM(db).onManual(id, 'closed', 'handled offline');
    const t = threads.get(id)!;
    const log = db.prepare("SELECT actor FROM action_log WHERE action='state_override'").get() as {
      actor: string;
    };
    db.close();
    expect(t.state).toBe('closed');
    expect(t.sla_deadline).toBeNull();
    expect(log.actor).toBe('user');
  });

  it('onManual throws NotFoundError for a missing thread', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    const sm = makeSM(db);
    expect(() => sm.onManual('no-such-id', 'closed')).toThrow(NotFoundError);
    db.close();
  });
});
