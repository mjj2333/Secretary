import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemorySecretStore } from '../server/auth/SecretStore.js';
import { openDatabase } from '../server/db/connection.js';
import { MessagesRepository } from '../server/db/repositories/MessagesRepository.js';
import { StyleExamplesRepository } from '../server/db/repositories/StyleExamplesRepository.js';
import { ThreadsRepository } from '../server/db/repositories/ThreadsRepository.js';
import type { RawMessage } from '@secretary/shared-types';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'secretary-style-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('StyleExamplesRepository.sample', () => {
  it('returns [] when the table is empty (v1)', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    const repo = new StyleExamplesRepository(db);
    const out = repo.sample('client_new', 3);
    db.close();
    expect(out).toEqual([]);
  });

  it('prefers category matches, then falls back to any', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    db.prepare(
      `INSERT INTO style_examples (id, contact_category, context_summary, reply_text) VALUES ('s1','client_new','ctx','reply-cn')`,
    ).run();
    db.prepare(
      `INSERT INTO style_examples (id, contact_category, context_summary, reply_text) VALUES ('s2','vendor','ctx','reply-v')`,
    ).run();
    const repo = new StyleExamplesRepository(db);
    const matched = repo.sample('client_new', 3).map((r) => r.id);
    const fallback = repo
      .sample('personal', 3)
      .map((r) => r.id)
      .sort();
    db.close();
    expect(matched).toEqual(['s1']); // category match only
    expect(fallback).toEqual(['s1', 's2']); // no 'personal' match -> any
  });
});

function outboundMsg(providerId: string): RawMessage {
  return {
    providerId,
    references: [],
    messageIdHeader: `<${providerId}@x>`,
    from: { address: 'me@b.com' },
    to: [{ address: 'x@y.com' }],
    cc: [],
    bcc: [],
    subject: 's',
    bodyText: 'sent body',
    snippet: 'sent body',
    direction: 'outbound',
    dateSent: 2000,
    isRead: true,
    isStarred: false,
    folder: 'Sent',
    labels: [],
    attachmentsMeta: [],
  };
}

function seedMessage(db: ReturnType<typeof openDatabase>): string {
  db.prepare(
    `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('a1','imap','A','me@b.com')`,
  ).run();
  const threadId = new ThreadsRepository(db).create('a1', 's', ['x@y.com'], 1000);
  return new MessagesRepository(db).insert('a1', threadId, outboundMsg('p1'))!;
}

describe('StyleExamplesRepository — mining/review', () => {
  it('insertPending writes a pending row; sample() ignores non-approved', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    const messageId = seedMessage(db);
    const repo = new StyleExamplesRepository(db);
    const id = repo.insertPending({
      sourceMessageId: messageId,
      contactCategory: 'vendor',
      contextSummary: 'ctx',
      replyText: 'reply',
      tags: '["concise"]',
    });
    const pendingSample = repo.sample('vendor', 3);
    repo.setStatus(id, 'approved');
    const approvedSample = repo.sample('vendor', 3).map((r) => r.id);
    db.close();
    expect(pendingSample).toEqual([]);
    expect(approvedSample).toEqual([id]);
  });

  it('existsForMessage, listByStatus, and update behave', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    const messageId = seedMessage(db);
    const repo = new StyleExamplesRepository(db);
    const id = repo.insertPending({
      sourceMessageId: messageId,
      contactCategory: 'personal',
      contextSummary: 'ctx',
      replyText: 'reply',
      tags: '[]',
    });
    repo.update(id, { contextSummary: 'edited', tags: '["warm"]' });
    const pending = repo.listByStatus('pending');
    db.close();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.context_summary).toBe('edited');
    expect(pending[0]!.tags).toBe('["warm"]');
  });

  it('existsForMessage is true only for an inserted source message', () => {
    const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
    const messageId = seedMessage(db);
    const repo = new StyleExamplesRepository(db);
    repo.insertPending({
      sourceMessageId: messageId,
      contactCategory: null,
      contextSummary: 'c',
      replyText: 'r',
      tags: '[]',
    });
    const yes = repo.existsForMessage(messageId);
    const no = repo.existsForMessage('nope');
    db.close();
    expect(yes).toBe(true);
    expect(no).toBe(false);
  });
});
