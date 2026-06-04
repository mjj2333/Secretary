import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RawMessage } from '@secretary/shared-types';
import { InMemorySecretStore } from '../server/auth/SecretStore.js';
import { openDatabase } from '../server/db/connection.js';
import { ContactsRepository } from '../server/db/repositories/ContactsRepository.js';
import { MessagesRepository } from '../server/db/repositories/MessagesRepository.js';
import { SettingsRepository } from '../server/db/repositories/SettingsRepository.js';
import { StyleExamplesRepository } from '../server/db/repositories/StyleExamplesRepository.js';
import { ThreadsRepository } from '../server/db/repositories/ThreadsRepository.js';
import { PromptAssembler } from '../server/agent/PromptAssembler.js';
import { MiningJob } from '../server/agent/MiningJob.js';
import { SentMailMiner } from '../server/agent/SentMailMiner.js';
import { EventBus } from '../server/eventBus.js';
import { FakeGateway, ThrowingGateway } from './helpers/fakeGateway.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'secretary-miner-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const NOOP_LOG = { info() {}, warn() {} };

function raw(p: { providerId: string; direction: 'inbound' | 'outbound'; body: string; when: number }): RawMessage {
  return {
    providerId: p.providerId,
    references: [],
    messageIdHeader: `<${p.providerId}@x>`,
    from: p.direction === 'inbound' ? { address: 'alice@x.com', name: 'Alice' } : { address: 'me@b.com' },
    to: p.direction === 'inbound' ? [{ address: 'me@b.com' }] : [{ address: 'alice@x.com' }],
    cc: [],
    bcc: [],
    subject: 'Re: Meeting',
    bodyText: p.body,
    snippet: p.body.slice(0, 200),
    direction: p.direction,
    ...(p.direction === 'inbound' ? { dateReceived: p.when } : { dateSent: p.when }),
    isRead: true,
    isStarred: false,
    folder: 'Sent',
    labels: [],
    attachmentsMeta: [],
  };
}

function setup(gateway: FakeGateway | ThrowingGateway | null) {
  const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
  db.prepare(
    `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('a1','imap','A','me@b.com')`,
  ).run();
  const threads = new ThreadsRepository(db);
  const messages = new MessagesRepository(db);
  const contacts = new ContactsRepository(db);
  const styleExamples = new StyleExamplesRepository(db);
  const threadId = threads.create('a1', 'meeting', ['alice@x.com'], 1000);
  contacts.recordSeen({ address: 'alice@x.com', name: 'Alice' }, 'inbound', 1000);
  db.prepare("UPDATE contacts SET category = 'client_established' WHERE email_address = 'alice@x.com'").run();
  messages.insert('a1', threadId, raw({ providerId: 'in1', direction: 'inbound', body: 'Are you free Tuesday?', when: 1000 }));
  const outId = messages.insert('a1', threadId, raw({ providerId: 'out1', direction: 'outbound', body: 'Tuesday at 2 works for me.', when: 2000 }))!;
  const job = new MiningJob();
  job.start(1);
  const prompts = new PromptAssembler(messages, threads, contacts, new SettingsRepository(db), styleExamples);
  const miner = new SentMailMiner(prompts, gateway, messages, contacts, styleExamples, job, new EventBus(), NOOP_LOG, new SettingsRepository(db));
  return { db, miner, styleExamples, outId, job };
}

describe('SentMailMiner.mine', () => {
  it('writes a pending style example with parsed fields + resolved category', async () => {
    const { db, miner, styleExamples, outId, job } = setup(
      new FakeGateway(['{"context_summary":"Replying to a meeting request.","tags":["concise","warm"]}']),
    );
    await miner.mine(outId);
    const rows = styleExamples.listByStatus('pending');
    const snap = job.snapshot();
    db.close();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.context_summary).toBe('Replying to a meeting request.');
    expect(rows[0]!.contact_category).toBe('client_established');
    expect(rows[0]!.reply_text).toBe('Tuesday at 2 works for me.');
    expect(JSON.parse(rows[0]!.tags!)).toEqual(['concise', 'warm']);
    expect(snap.done).toBe(1);
  });

  it('is idempotent: a second mine of the same message inserts nothing', async () => {
    const { db, miner, styleExamples, outId } = setup(
      new FakeGateway(['{"context_summary":"c","tags":[]}', '{"context_summary":"c2","tags":[]}']),
    );
    await miner.mine(outId);
    await miner.mine(outId);
    const rows = styleExamples.listAll();
    db.close();
    expect(rows).toHaveLength(1);
  });

  it('writes nothing on bad JSON but still ticks (never throws)', async () => {
    const { db, miner, styleExamples, outId, job } = setup(new FakeGateway(['not json at all']));
    await miner.mine(outId);
    const rows = styleExamples.listAll();
    const snap = job.snapshot();
    db.close();
    expect(rows).toHaveLength(0);
    expect(snap.done).toBe(1);
  });

  it('writes nothing on a gateway throw but still ticks', async () => {
    const { db, miner, styleExamples, outId, job } = setup(new ThrowingGateway());
    await miner.mine(outId);
    const rows = styleExamples.listAll();
    const snap = job.snapshot();
    db.close();
    expect(rows).toHaveLength(0);
    expect(snap.done).toBe(1);
  });

  it('parses JSON even when the model wraps it in prose', async () => {
    const { db, miner, styleExamples, outId } = setup(
      new FakeGateway([
        'Sure! Here is the analysis:\n{"context_summary":"A meeting reply.","tags":["warm"]}\nLet me know if you need changes.',
      ]),
    );
    await miner.mine(outId);
    const rows = styleExamples.listByStatus('pending');
    db.close();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.context_summary).toBe('A meeting reply.');
  });

  it('handles a closing brace inside a string value', async () => {
    const { db, miner, styleExamples, outId } = setup(
      new FakeGateway(['{"context_summary":"Used a } literal here","tags":[]}']),
    );
    await miner.mine(outId);
    const rows = styleExamples.listByStatus('pending');
    db.close();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.context_summary).toBe('Used a } literal here');
  });
});
