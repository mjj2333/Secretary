import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RawMessage } from '@secretary/shared-types';
import { InMemorySecretStore } from '../server/auth/SecretStore.js';
import { openDatabase } from '../server/db/connection.js';
import { EventBus } from '../server/eventBus.js';
import { ProviderRegistry } from '../server/providers/ProviderRegistry.js';
import { SyncManager } from '../server/sync/SyncManager.js';
import { FakeEmailProvider } from './helpers/fakeProvider.js';
import { SettingsRepository } from '../server/db/repositories/SettingsRepository.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'secretary-sync-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function inbound(uid: string, subject: string, inReplyTo?: string, messageId?: string): RawMessage {
  return {
    providerId: uid,
    references: [],
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(messageId ? { messageIdHeader: messageId } : {}),
    from: { address: 'alice@example.com', name: 'Alice' },
    to: [{ address: 'me@example.com' }],
    cc: [],
    bcc: [],
    subject,
    bodyText: 'hello',
    direction: 'inbound',
    dateReceived: Number(uid) * 1000,
    isRead: false,
    isStarred: false,
    folder: 'INBOX',
    labels: ['INBOX'],
    attachmentsMeta: [],
  };
}

describe('SyncManager.initialSync', () => {
  it('persists messages, reconstructs the thread, writes contacts + action log', async () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    db.prepare(
      `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','Me','me@example.com')`,
    ).run();
    const registry = new ProviderRegistry();
    const provider = new FakeEmailProvider('acc1', [
      inbound('1', 'Project kickoff', undefined, '<m1@x>'),
      inbound('2', 'Re: Project kickoff', '<m1@x>'),
    ]);
    registry.set(provider);
    const sync = new SyncManager(db, registry, new EventBus());

    await sync.initialSync('acc1');

    const threads = db.prepare('SELECT COUNT(*) AS n FROM threads').get() as { n: number };
    const messages = db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number };
    const contacts = db.prepare('SELECT COUNT(*) AS n FROM contacts').get() as { n: number };
    const log = db.prepare('SELECT COUNT(*) AS n FROM action_log').get() as { n: number };
    db.close();
    expect(threads.n).toBe(1); // reply folded into the same thread
    expect(messages.n).toBe(2);
    expect(contacts.n).toBe(1);
    expect(log.n).toBe(2);
  });

  it('is idempotent on re-sync — counts and contact totals stay stable', async () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    db.prepare(
      `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','Me','me@example.com')`,
    ).run();
    const registry = new ProviderRegistry();
    registry.set(
      new FakeEmailProvider('acc1', [
        inbound('1', 'Project kickoff', undefined, '<m1@x>'),
        inbound('2', 'Re: Project kickoff', '<m1@x>'),
      ]),
    );
    const sync = new SyncManager(db, registry, new EventBus());
    await sync.initialSync('acc1');
    await sync.initialSync('acc1'); // re-sync: everything is a duplicate

    const messages = (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
    const contactIn = (
      db
        .prepare(
          "SELECT total_messages_in AS n FROM contacts WHERE email_address='alice@example.com'",
        )
        .get() as { n: number }
    ).n;
    db.close();
    expect(messages).toBe(2); // not 4
    expect(contactIn).toBe(2); // not 4 — recordSeen gated by the dedup check
  });

  it('incrementalSync persists a newly-arrived message', async () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    db.prepare(
      `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','Me','me@example.com')`,
    ).run();
    const registry = new ProviderRegistry();
    const provider = new FakeEmailProvider('acc1', []);
    registry.set(provider);
    const sync = new SyncManager(db, registry, new EventBus());
    await sync.initialSync('acc1'); // 0 messages

    provider.setIncremental([inbound('9', 'A brand new topic')]);
    await sync.incrementalSync('acc1');

    const messages = (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
    db.close();
    expect(messages).toBe(1);
  });
});

function outbound(uid: string, subject: string, sentMs: number): RawMessage {
  return {
    providerId: uid,
    references: [],
    from: { address: 'me@example.com', name: 'Me' },
    to: [{ address: 'alice@example.com' }],
    cc: [],
    bcc: [],
    subject,
    bodyText: 'reply',
    direction: 'outbound',
    dateSent: sentMs,
    isRead: true,
    isStarred: false,
    folder: 'Sent',
    labels: ['Sent'],
    attachmentsMeta: [],
  };
}

describe('SyncManager post-batch routing', () => {
  function makeHooks() {
    const enqueued: string[] = [];
    const outboundThreads: string[] = [];
    return {
      enqueued,
      outboundThreads,
      hooks: {
        enqueueClassification: (id: string) => enqueued.push(id),
        onOutbound: (threadId: string) => outboundThreads.push(threadId),
      },
    };
  }

  it('enqueues classification when the latest message in a thread is inbound', async () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    db.prepare(
      `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','Me','me@example.com')`,
    ).run();
    const registry = new ProviderRegistry();
    registry.set(new FakeEmailProvider('acc1', [inbound('1', 'Hello there')]));
    const { enqueued, outboundThreads, hooks } = makeHooks();
    const sync = new SyncManager(db, registry, new EventBus(), Date.now, hooks);

    await sync.initialSync('acc1');

    const latest = db.prepare("SELECT id FROM messages WHERE direction='inbound'").get() as {
      id: string;
    };
    db.close();
    expect(enqueued).toEqual([latest.id]);
    expect(outboundThreads).toEqual([]);
  });

  it('routes a thread whose latest message is outbound to onOutbound (no classify)', async () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    db.prepare(
      `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','Me','me@example.com')`,
    ).run();
    const registry = new ProviderRegistry();
    // Same thread (shared message-id chain): inbound first, she replied last.
    registry.set(
      new FakeEmailProvider('acc1', [
        inbound('1', 'Project kickoff', undefined, '<m1@x>'),
        outbound('2', 'Re: Project kickoff', 5000),
      ]),
    );
    const { enqueued, outboundThreads, hooks } = makeHooks();
    const sync = new SyncManager(db, registry, new EventBus(), Date.now, hooks);

    await sync.initialSync('acc1');

    const threadId = (db.prepare('SELECT id FROM threads LIMIT 1').get() as { id: string }).id;
    db.close();
    expect(outboundThreads).toEqual([threadId]);
    expect(enqueued).toEqual([]);
  });

  it('does not enqueue when agent.classify_on_inbound is false', async () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    db.prepare(
      `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','Me','me@example.com')`,
    ).run();
    new SettingsRepository(db).set('agent.classify_on_inbound', false);
    const registry = new ProviderRegistry();
    registry.set(new FakeEmailProvider('acc1', [inbound('1', 'Hello there')]));
    const { enqueued, hooks } = makeHooks();
    const sync = new SyncManager(db, registry, new EventBus(), Date.now, hooks);

    await sync.initialSync('acc1');
    db.close();
    expect(enqueued).toEqual([]);
  });
});
