import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RawMessage } from '@secretary/shared-types';
import { InMemorySecretStore } from '../server/auth/SecretStore.js';
import { openDatabase } from '../server/db/connection.js';
import { ActionLogRepository } from '../server/db/repositories/ActionLogRepository.js';
import { ContactsRepository } from '../server/db/repositories/ContactsRepository.js';
import { MessagesRepository } from '../server/db/repositories/MessagesRepository.js';
import { SettingsRepository } from '../server/db/repositories/SettingsRepository.js';
import { StyleExamplesRepository } from '../server/db/repositories/StyleExamplesRepository.js';
import { ThreadsRepository } from '../server/db/repositories/ThreadsRepository.js';
import { EventBus } from '../server/eventBus.js';
import { StateMachine } from '../server/agent/StateMachine.js';
import { PromptAssembler } from '../server/agent/PromptAssembler.js';
import { Classifier } from '../server/agent/Classifier.js';
import { FakeGateway, ThrowingGateway } from './helpers/fakeGateway.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'secretary-clf-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const NOOP_LOG = { info() {}, warn() {} };

function inbound(uid: string, body: string, when: number): RawMessage {
  return {
    providerId: uid,
    references: [],
    from: { address: 'alice@x.com', name: 'Alice' },
    to: [{ address: 'me@b.com' }],
    cc: [],
    bcc: [],
    subject: 'Booking?',
    bodyText: body,
    snippet: body.slice(0, 200),
    direction: 'inbound',
    dateReceived: when,
    isRead: false,
    isStarred: false,
    folder: 'INBOX',
    labels: [],
    attachmentsMeta: [],
  };
}

interface Ctx {
  db: ReturnType<typeof openDatabase>;
  threads: ThreadsRepository;
  messages: MessagesRepository;
  actions: ActionLogRepository;
  threadId: string;
  messageId: string;
}

function seed(): Ctx {
  const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
  db.prepare(
    `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','A','a@b.com')`,
  ).run();
  const threads = new ThreadsRepository(db);
  const messages = new MessagesRepository(db);
  const contacts = new ContactsRepository(db);
  const threadId = threads.create('acc1', 'booking', ['alice@x.com'], 1000);
  contacts.recordSeen({ address: 'alice@x.com', name: 'Alice' }, 'inbound', 1000);
  threads.touch(threadId, { lastInboundAt: 1000, lastMessageAt: 1000 });
  const messageId = messages.insert(
    'acc1',
    threadId,
    inbound('u1', 'Can we book a shoot next week?', 1000),
  )!;
  return { db, threads, messages, actions: new ActionLogRepository(db), threadId, messageId };
}

function makeClassifier(
  ctx: Ctx,
  gateway: FakeGateway | ThrowingGateway | null,
  onDraftEligible?: (threadId: string) => void,
): Classifier {
  const settings = new SettingsRepository(ctx.db);
  const contacts = new ContactsRepository(ctx.db);
  const eventBus = new EventBus();
  const stateMachine = new StateMachine(
    ctx.threads,
    contacts,
    settings,
    ctx.actions,
    eventBus,
    () => 10_000,
  );
  const prompts = new PromptAssembler(
    ctx.messages,
    ctx.threads,
    contacts,
    settings,
    new StyleExamplesRepository(ctx.db),
  );
  return new Classifier(
    prompts,
    gateway,
    stateMachine,
    ctx.threads,
    ctx.messages,
    ctx.actions,
    eventBus,
    settings,
    contacts,
    NOOP_LOG,
    () => 10_000,
    onDraftEligible,
  );
}

describe('Classifier.classify', () => {
  it('applies a successful classification to the thread and logs it', async () => {
    const ctx = seed();
    const gw = new FakeGateway([
      '{"intent":"booking_request","category_suggestion":"client_new","urgency":"high","requires_response":true,"summary":"Wants a shoot"}',
    ]);
    await makeClassifier(ctx, gw).classify(ctx.messageId);

    const t = ctx.threads.get(ctx.threadId)!;
    const log = ctx.db
      .prepare("SELECT COUNT(*) AS n FROM action_log WHERE action='classified'")
      .get() as { n: number };
    ctx.db.close();
    expect(t.state).toBe('awaiting_your_reply');
    expect(t.urgency).toBe('high');
    expect(t.last_agent_summary).toBe('Wants a shoot');
    expect(t.sla_deadline).toBe(1000 + 24 * 3_600_000); // unknown category -> 24h fallback
    expect(log.n).toBe(1);
    expect(gw.requests[0]?.format).toBe('json');
  });

  it('retries once on a garbage first response, then succeeds', async () => {
    const ctx = seed();
    const gw = new FakeGateway([
      'I think this is a booking request, probably high urgency.',
      '{"requires_response":true,"urgency":"normal","summary":"ok"}',
    ]);
    await makeClassifier(ctx, gw).classify(ctx.messageId);
    const t = ctx.threads.get(ctx.threadId)!;
    ctx.db.close();
    expect(gw.requests).toHaveLength(2);
    expect(t.state).toBe('awaiting_your_reply');
  });

  it('marks classification_failed and leaves needs_classification after two failures', async () => {
    const ctx = seed();
    const gw = new FakeGateway(['nope', 'still nope']);
    await makeClassifier(ctx, gw).classify(ctx.messageId);
    const t = ctx.threads.get(ctx.threadId)!;
    const log = ctx.db
      .prepare("SELECT COUNT(*) AS n FROM action_log WHERE action='classification_failed'")
      .get() as { n: number };
    ctx.db.close();
    expect(t.state).toBe('needs_classification');
    expect(log.n).toBe(1);
  });

  it('skips entirely when the gateway is not configured (null)', async () => {
    const ctx = seed();
    await makeClassifier(ctx, null).classify(ctx.messageId);
    const t = ctx.threads.get(ctx.threadId)!;
    ctx.db.close();
    expect(t.state).toBe('needs_classification');
  });

  it('treats a thrown gateway error like a failure (no crash)', async () => {
    const ctx = seed();
    await makeClassifier(ctx, new ThrowingGateway()).classify(ctx.messageId);
    const t = ctx.threads.get(ctx.threadId)!;
    const log = ctx.db
      .prepare("SELECT COUNT(*) AS n FROM action_log WHERE action='classification_failed'")
      .get() as { n: number };
    ctx.db.close();
    expect(t.state).toBe('needs_classification');
    expect(log.n).toBe(1);
  });
});

describe('Classifier auto-draft eligibility', () => {
  it('fires onDraftEligible when requires_response + autodraft_on_inbound + not do_not_auto_draft', async () => {
    const ctx = seed();
    new SettingsRepository(ctx.db).set('agent.autodraft_on_inbound', true);
    const eligible: string[] = [];
    const gw = new FakeGateway([
      '{"requires_response":true,"urgency":"normal","summary":"needs reply"}',
    ]);
    await makeClassifier(ctx, gw, (id) => eligible.push(id)).classify(ctx.messageId);
    ctx.db.close();
    expect(eligible).toEqual([ctx.threadId]);
  });

  it('does NOT fire when requires_response is false', async () => {
    const ctx = seed();
    new SettingsRepository(ctx.db).set('agent.autodraft_on_inbound', true);
    const eligible: string[] = [];
    const gw = new FakeGateway(['{"requires_response":false,"summary":"fyi"}']);
    await makeClassifier(ctx, gw, (id) => eligible.push(id)).classify(ctx.messageId);
    ctx.db.close();
    expect(eligible).toEqual([]);
  });

  it('does NOT fire when autodraft_on_inbound is false', async () => {
    const ctx = seed();
    new SettingsRepository(ctx.db).set('agent.autodraft_on_inbound', false);
    const eligible: string[] = [];
    const gw = new FakeGateway(['{"requires_response":true,"summary":"x"}']);
    await makeClassifier(ctx, gw, (id) => eligible.push(id)).classify(ctx.messageId);
    ctx.db.close();
    expect(eligible).toEqual([]);
  });

  it('does NOT fire when the contact is do_not_auto_draft', async () => {
    const ctx = seed();
    new SettingsRepository(ctx.db).set('agent.autodraft_on_inbound', true);
    const contacts = new ContactsRepository(ctx.db);
    contacts.patch(contacts.findByEmail('alice@x.com')!.id, { doNotAutoDraft: true });
    const eligible: string[] = [];
    const gw = new FakeGateway(['{"requires_response":true,"summary":"x"}']);
    await makeClassifier(ctx, gw, (id) => eligible.push(id)).classify(ctx.messageId);
    ctx.db.close();
    expect(eligible).toEqual([]);
  });
});
