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

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'secretary-pa-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function msg(
  uid: string,
  from: string,
  body: string,
  when: number,
  dir2: 'inbound' | 'outbound' = 'inbound',
): RawMessage {
  return {
    providerId: uid,
    references: [],
    from: { address: from },
    to: [{ address: 'me@b.com' }],
    cc: [],
    bcc: [],
    subject: `Subject ${uid}`,
    bodyText: body,
    snippet: body.slice(0, 200),
    direction: dir2,
    ...(dir2 === 'inbound' ? { dateReceived: when } : { dateSent: when }),
    isRead: false,
    isStarred: false,
    folder: dir2 === 'inbound' ? 'INBOX' : 'Sent',
    labels: [],
    attachmentsMeta: [],
  };
}

describe('PromptAssembler.buildClassificationPrompt', () => {
  it('assembles contact + recent context + the new message, with truncation', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    db.prepare(
      `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','A','a@b.com')`,
    ).run();
    const threads = new ThreadsRepository(db);
    const messages = new MessagesRepository(db);
    const contacts = new ContactsRepository(db);
    const threadId = threads.create('acc1', 'subject', ['alice@x.com'], 1000);

    contacts.recordSeen({ address: 'alice@x.com', name: 'Alice' }, 'inbound', 1000);
    contacts.patch(contacts.findByEmail('alice@x.com')!.id, {
      category: 'client_established',
      notes: 'N'.repeat(800),
    });

    // 4 prior messages; only the last 3 should appear, oldest-first.
    messages.insert('acc1', threadId, msg('1', 'alice@x.com', 'oldest', 1000));
    messages.insert('acc1', threadId, msg('2', 'me@b.com', 'reply', 2000, 'outbound'));
    messages.insert('acc1', threadId, msg('3', 'alice@x.com', 'third', 3000));
    messages.insert('acc1', threadId, msg('4', 'me@b.com', 'fourth', 4000, 'outbound'));
    const targetId = messages.insert(
      'acc1',
      threadId,
      msg('5', 'alice@x.com', 'B'.repeat(2500), 5000),
    )!;

    const assembler = new PromptAssembler(
      messages,
      threads,
      contacts,
      new SettingsRepository(db),
      new StyleExamplesRepository(db),
    );
    const { system, prompt } = assembler.buildClassificationPrompt(targetId);

    expect(system).toContain('requires_response'); // classifier.md loaded
    expect(prompt).toContain('Category: client_established');
    expect(prompt).toContain('N'.repeat(500)); // notes truncated to 500
    expect(prompt).not.toContain('N'.repeat(501));
    expect(prompt).not.toContain('oldest'); // dropped: only last 3 prior
    expect(prompt).toContain('third');
    expect(prompt).toContain('fourth');
    expect(prompt).toContain('…[truncated]'); // body truncated at 2000
    expect(prompt.includes('B'.repeat(2000))).toBe(true);
    expect(prompt.includes('B'.repeat(2001))).toBe(false);
    db.close();
  });

  it('throws NotFoundError for a missing message', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    const assembler = new PromptAssembler(
      new MessagesRepository(db),
      new ThreadsRepository(db),
      new ContactsRepository(db),
      new SettingsRepository(db),
      new StyleExamplesRepository(db),
    );
    expect(() => assembler.buildClassificationPrompt('nope')).toThrow(/not found/i);
    db.close();
  });
});
