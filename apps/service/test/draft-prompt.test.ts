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
import { PromptAssembler, replySubject } from '../server/agent/PromptAssembler.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'secretary-dp-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function inbound(uid: string, body: string, when: number): RawMessage {
  return {
    providerId: uid,
    references: [],
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

function make(db: ReturnType<typeof openDatabase>): PromptAssembler {
  return new PromptAssembler(
    new MessagesRepository(db),
    new ThreadsRepository(db),
    new ContactsRepository(db),
    new SettingsRepository(db),
    new StyleExamplesRepository(db),
  );
}

describe('PromptAssembler.buildDraftPrompt', () => {
  it('assembles system (drafter.md + voice guide) + the message to reply to + raw intent', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    db.prepare(
      `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','A','a@b.com')`,
    ).run();
    const threads = new ThreadsRepository(db);
    const messages = new MessagesRepository(db);
    const contacts = new ContactsRepository(db);
    const threadId = threads.create('acc1', 'can we meet', ['alice@x.com'], 1000);
    contacts.recordSeen({ address: 'alice@x.com', name: 'Alice' }, 'inbound', 1000);
    messages.insert('acc1', threadId, inbound('u1', 'Are you free Tuesday?', 1000));

    const { system, prompt, systemPromptUsed } = make(db).buildDraftPrompt(threadId, {
      rawIntent: 'yes, tuesday 2pm works',
    });
    db.close();

    expect(system).toContain('Return ONLY the email body'); // drafter.md
    expect(system).toContain('Voice guide'); // voice-baseline.md
    expect(systemPromptUsed).toBe(system);
    expect(prompt).toContain('Are you free Tuesday?'); // the message to reply to
    expect(prompt).toContain('yes, tuesday 2pm works'); // raw intent
    expect(prompt).toContain('Tone:');
  });

  it('uses the style_guide setting override when set', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    db.prepare(
      `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','A','a@b.com')`,
    ).run();
    const threads = new ThreadsRepository(db);
    const messages = new MessagesRepository(db);
    const threadId = threads.create('acc1', 'x', [], 1000);
    messages.insert('acc1', threadId, inbound('u1', 'hi', 1000));
    new SettingsRepository(db).set('style_guide', 'CUSTOM VOICE GUIDE MARKER');

    const { system } = make(db).buildDraftPrompt(threadId);
    db.close();
    expect(system).toContain('CUSTOM VOICE GUIDE MARKER');
    expect(system).not.toContain('Voice guide (baseline)');
  });

  it('throws when the thread has no inbound message to reply to', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    db.prepare(
      `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','A','a@b.com')`,
    ).run();
    const threadId = new ThreadsRepository(db).create('acc1', 'x', [], 1000);
    expect(() => make(db).buildDraftPrompt(threadId)).toThrow(/no inbound message/i);
    db.close();
  });
});

describe('replySubject', () => {
  it('prepends Re: to a fresh subject', () => {
    expect(replySubject('Can we meet?')).toBe('Re: Can we meet?');
  });
  it('does not double-prefix an existing Re:', () => {
    expect(replySubject('Re: Can we meet?')).toBe('Re: Can we meet?');
    expect(replySubject('re: lowercase')).toBe('re: lowercase');
  });
  it('does not strip a Fwd: chain', () => {
    expect(replySubject('Fwd: Notes')).toBe('Re: Fwd: Notes');
  });
  it('handles null/empty/whitespace as (no subject)', () => {
    expect(replySubject(null)).toBe('Re: (no subject)');
    expect(replySubject('')).toBe('Re: (no subject)');
    expect(replySubject('   ')).toBe('Re: (no subject)');
  });
});
