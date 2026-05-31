import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RawMessage } from '@secretary/shared-types';
import { InMemorySecretStore } from '../server/auth/SecretStore.js';
import { openDatabase } from '../server/db/connection.js';
import { ActionLogRepository } from '../server/db/repositories/ActionLogRepository.js';
import { ContactsRepository } from '../server/db/repositories/ContactsRepository.js';
import { DraftsRepository } from '../server/db/repositories/DraftsRepository.js';
import { MessagesRepository } from '../server/db/repositories/MessagesRepository.js';
import { SettingsRepository } from '../server/db/repositories/SettingsRepository.js';
import { StyleExamplesRepository } from '../server/db/repositories/StyleExamplesRepository.js';
import { ThreadsRepository } from '../server/db/repositories/ThreadsRepository.js';
import { EventBus } from '../server/eventBus.js';
import { PromptAssembler } from '../server/agent/PromptAssembler.js';
import { Drafter } from '../server/agent/Drafter.js';
import { FakeGateway, ThrowingGateway } from './helpers/fakeGateway.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'secretary-drafter-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const NOOP_LOG = { info() {}, warn() {} };

function inbound(uid: string, body: string, when: number): RawMessage {
  return {
    providerId: uid,
    references: [],
    messageIdHeader: `<${uid}@x>`,
    from: { address: 'alice@x.com', name: 'Alice' },
    to: [{ address: 'me@b.com' }],
    cc: [],
    bcc: [],
    subject: 'Can we meet?',
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
  drafts: DraftsRepository;
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
  const threadId = threads.create('acc1', 'can we meet', ['alice@x.com'], 1000);
  contacts.recordSeen({ address: 'alice@x.com', name: 'Alice' }, 'inbound', 1000);
  const messageId = messages.insert(
    'acc1',
    threadId,
    inbound('u1', 'Are you free Tuesday?', 1000),
  )!;
  return { db, drafts: new DraftsRepository(db), threadId, messageId };
}

function makeDrafter(ctx: Ctx, gateway: FakeGateway | ThrowingGateway | null): Drafter {
  const settings = new SettingsRepository(ctx.db);
  const prompts = new PromptAssembler(
    new MessagesRepository(ctx.db),
    new ThreadsRepository(ctx.db),
    new ContactsRepository(ctx.db),
    settings,
    new StyleExamplesRepository(ctx.db),
  );
  return new Drafter(
    prompts,
    gateway,
    ctx.drafts,
    new MessagesRepository(ctx.db),
    new ThreadsRepository(ctx.db),
    new ActionLogRepository(ctx.db),
    new EventBus(),
    settings,
    NOOP_LOG,
    () => 5000,
  );
}

describe('Drafter.draft', () => {
  it('writes a pending_review draft with derived recipients + metadata', async () => {
    const ctx = seed();
    const drafter = makeDrafter(
      ctx,
      new FakeGateway(['Tuesday at 2pm works great. See you then.']),
    );
    const row = await drafter.draft(ctx.threadId);
    ctx.db.close();
    expect(row).not.toBeNull();
    expect(row!.version).toBe(1);
    expect(row!.status).toBe('pending_review');
    expect(row!.body_text).toBe('Tuesday at 2pm works great. See you then.');
    expect(JSON.parse(row!.to_addresses!)).toEqual([{ address: 'alice@x.com', name: 'Alice' }]);
    expect(row!.subject).toBe('Re: Can we meet?');
    expect(row!.in_reply_to_message_id).toBe(ctx.messageId);
    expect(row!.model_used).toBeTruthy();
  });

  it('computes polish_diff when rawIntent is given', async () => {
    const ctx = seed();
    const drafter = makeDrafter(ctx, new FakeGateway(['Yes — Tuesday at 2pm works.']));
    const row = await drafter.draft(ctx.threadId, { rawIntent: 'tuesday 2pm ok' });
    ctx.db.close();
    expect(row!.raw_intent).toBe('tuesday 2pm ok');
    expect(JSON.parse(row!.polish_diff!).length).toBeGreaterThan(0);
  });

  it('bumps the version on a second draft', async () => {
    const ctx = seed();
    const drafter = makeDrafter(ctx, new FakeGateway(['v1', 'v2']));
    await drafter.draft(ctx.threadId);
    const second = await drafter.draft(ctx.threadId);
    ctx.db.close();
    expect(second!.version).toBe(2);
  });

  it('returns null when the gateway is null (no row written)', async () => {
    const ctx = seed();
    const row = await makeDrafter(ctx, null).draft(ctx.threadId);
    const { n } = ctx.db.prepare('SELECT COUNT(*) AS n FROM drafts').get() as { n: number };
    ctx.db.close();
    expect(row).toBeNull();
    expect(n).toBe(0);
  });

  it('returns null + records draft_failed when the gateway throws', async () => {
    const ctx = seed();
    const row = await makeDrafter(ctx, new ThrowingGateway()).draft(ctx.threadId);
    const failed = (
      ctx.db.prepare("SELECT COUNT(*) AS n FROM action_log WHERE action='draft_failed'").get() as {
        n: number;
      }
    ).n;
    ctx.db.close();
    expect(row).toBeNull();
    expect(failed).toBe(1);
  });
});
