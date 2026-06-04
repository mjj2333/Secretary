import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RawMessage, MessageDirection } from '@secretary/shared-types';
import { InMemorySecretStore } from '../server/auth/SecretStore.js';
import { openDatabase } from '../server/db/connection.js';
import { MessagesRepository } from '../server/db/repositories/MessagesRepository.js';
import { ThreadsRepository } from '../server/db/repositories/ThreadsRepository.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'secretary-messages-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function raw(uid: string, direction: MessageDirection, when: number): RawMessage {
  return {
    providerId: uid,
    references: [],
    from: direction === 'inbound' ? { address: 'a@b.com' } : { address: 'me@b.com' },
    to: [{ address: direction === 'inbound' ? 'me@b.com' : 'a@b.com' }],
    cc: [],
    bcc: [],
    subject: 'hello',
    bodyText: 'hi',
    direction,
    ...(direction === 'inbound' ? { dateReceived: when } : { dateSent: when }),
    isRead: false,
    isStarred: false,
    folder: direction === 'inbound' ? 'INBOX' : 'Sent',
    labels: [],
    attachmentsMeta: [],
  };
}

function msg(overrides: Partial<RawMessage> & { providerId: string; direction: 'inbound' | 'outbound' }): RawMessage {
  return {
    references: [],
    messageIdHeader: `<${overrides.providerId}@x>`,
    from: { address: 'me@b.com' },
    to: [{ address: 'x@y.com' }],
    cc: [],
    bcc: [],
    subject: 's',
    bodyText: 'body',
    snippet: 'body',
    isRead: true,
    isStarred: false,
    folder: 'Sent',
    labels: [],
    attachmentsMeta: [],
    ...overrides,
  };
}

describe('MessagesRepository', () => {
  it('insert returns the new id and is idempotent on (account_id, provider_id)', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    db.prepare(
      `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','A','a@b.com')`,
    ).run();
    const threads = new ThreadsRepository(db);
    const threadId = threads.create('acc1', 'hello', ['a@b.com'], 1000);
    const repo = new MessagesRepository(db);

    const id = repo.insert('acc1', threadId, raw('u1', 'inbound', 1000));
    expect(id).toMatch(/[0-9a-f-]{36}/);
    const again = repo.insert('acc1', threadId, raw('u1', 'inbound', 1000)); // duplicate provider_id
    db.close();
    expect(again).toBeNull();
  });

  it('listByThread orders mixed inbound/outbound messages chronologically', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    db.prepare(
      `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','A','a@b.com')`,
    ).run();
    const threads = new ThreadsRepository(db);
    const threadId = threads.create('acc1', 'hello', ['a@b.com'], 1000);
    const repo = new MessagesRepository(db);
    // Insert out of order; an outbound (date_sent only) sits chronologically in the middle.
    const third = repo.insert('acc1', threadId, raw('u3', 'inbound', 3000))!;
    const first = repo.insert('acc1', threadId, raw('u1', 'inbound', 1000))!;
    const second = repo.insert('acc1', threadId, raw('u2', 'outbound', 2000))!;
    const ordered = repo.listByThread(threadId).map((m) => m.id);
    db.close();
    expect(ordered).toEqual([first, second, third]);
  });

  it('getById, latestForThread, latestInboundForThread', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    db.prepare(
      `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','A','a@b.com')`,
    ).run();
    const threads = new ThreadsRepository(db);
    const threadId = threads.create('acc1', 'hello', ['a@b.com'], 1000);
    const repo = new MessagesRepository(db);

    const inId = repo.insert('acc1', threadId, raw('u1', 'inbound', 1000))!;
    const outId = repo.insert('acc1', threadId, raw('u2', 'outbound', 2000))!;

    expect(repo.getById(inId)?.id).toBe(inId);
    expect(repo.getById('nope')).toBeUndefined();
    expect(repo.latestForThread(threadId)?.id).toBe(outId); // newest overall
    expect(repo.latestInboundForThread(threadId)?.id).toBe(inId); // newest inbound
    db.close();
  });

  it('recentOutbound returns non-empty outbound messages, newest first, within limit; excludes drafts', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    db.prepare(
      `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('a1','imap','A','me@b.com')`,
    ).run();
    const threads = new ThreadsRepository(db);
    const messages = new MessagesRepository(db);
    const threadId = threads.create('a1', 's', ['x@y.com'], 1000);
    messages.insert('a1', threadId, msg({ providerId: 'in1', direction: 'inbound', dateReceived: 1000 }));
    messages.insert('a1', threadId, msg({ providerId: 'out-old', direction: 'outbound', dateSent: 2000 }));
    messages.insert('a1', threadId, msg({ providerId: 'out-new', direction: 'outbound', dateSent: 3000 }));
    messages.insert('a1', threadId, msg({ providerId: 'out-empty', direction: 'outbound', dateSent: 4000, bodyText: '   ' }));
    const out = messages.recentOutbound(10).map((m) => m.provider_id);
    db.prepare("UPDATE messages SET is_draft = 1 WHERE provider_id = 'out-old'").run();
    const afterDraftFlag = messages.recentOutbound(10).map((m) => m.provider_id);
    db.close();
    expect(out).toEqual(['out-new', 'out-old']); // newest first; inbound + empty excluded
    expect(afterDraftFlag).toEqual(['out-new']); // is_draft excluded
  });
});
