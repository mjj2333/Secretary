import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemorySecretStore } from '../server/auth/SecretStore.js';
import { openDatabase } from '../server/db/connection.js';
import { ThreadsRepository } from '../server/db/repositories/ThreadsRepository.js';
import { DraftsRepository } from '../server/db/repositories/DraftsRepository.js';
import { makeTestServer } from './helpers/testServer.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'secretary-drafts-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const db = openDatabase(join(dir, 'secretary.db'), new InMemorySecretStore());
  db.prepare(
    `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','A','a@b.com')`,
  ).run();
  const threadId = new ThreadsRepository(db).create('acc1', 'hi', [], 1000);
  return { db, threadId };
}

function insertInput(threadId: string, version: number) {
  return {
    threadId,
    accountId: 'acc1',
    version,
    inReplyToMessageId: null,
    to: [{ address: 'alice@x.com' }],
    cc: [],
    subject: 'Re: hi',
    bodyText: 'Hello there.',
    rawIntent: null,
    polishDiff: null,
    systemPromptUsed: 'sys',
    modelUsed: 'm',
    tokensIn: 1,
    tokensOut: 2,
    latencyMs: 3,
    createdAt: 1000,
  };
}

describe('DraftsRepository', () => {
  it('inserts with incrementing versions and reads back', () => {
    const { db, threadId } = setup();
    const repo = new DraftsRepository(db);
    expect(repo.nextVersion(threadId)).toBe(1);
    const id1 = repo.insert(insertInput(threadId, repo.nextVersion(threadId)));
    expect(repo.nextVersion(threadId)).toBe(2);
    const id2 = repo.insert(insertInput(threadId, repo.nextVersion(threadId)));

    const d2 = repo.getById(id2)!;
    expect(d2.version).toBe(2);
    expect(d2.status).toBe('pending_review');
    expect(JSON.parse(d2.to_addresses!)).toEqual([{ address: 'alice@x.com' }]);
    expect(repo.latestForThread(threadId)?.id).toBe(id2);
    expect(repo.getById(id1)?.version).toBe(1);
    db.close();
  });

  it('updateBody, markSent, markDiscarded, markFailed', () => {
    const { db, threadId } = setup();
    const repo = new DraftsRepository(db);
    const id = repo.insert(insertInput(threadId, 1));

    repo.updateBody(id, { bodyText: 'Edited body.', subject: 'Re: hi (edited)' });
    let d = repo.getById(id)!;
    expect([d.body_text, d.subject]).toEqual(['Edited body.', 'Re: hi (edited)']);

    repo.markSent(id, { sentAt: 5000, finalBodySent: 'Edited body.' });
    d = repo.getById(id)!;
    expect([d.status, d.sent_at, d.final_body_sent]).toEqual(['sent', 5000, 'Edited body.']);

    const id2 = repo.insert(insertInput(threadId, 2));
    repo.markDiscarded(id2);
    expect(repo.getById(id2)?.status).toBe('discarded');
    // latestForThread skips discarded -> the sent v1 is the latest non-discarded
    expect(repo.latestForThread(threadId)?.id).toBe(id);

    const id3 = repo.insert(insertInput(threadId, 3));
    repo.markFailed(id3);
    expect(repo.getById(id3)?.status).toBe('failed');
    // A send-failed draft is still re-sendable, so it remains the latest non-discarded draft.
    expect(repo.latestForThread(threadId)?.id).toBe(id3);
    db.close();
  });
});

function seedDraft(db: import('better-sqlite3-multiple-ciphers').Database, version: number) {
  return new DraftsRepository(db).insert({
    threadId: 'th1',
    accountId: 'acc1',
    version,
    inReplyToMessageId: null,
    to: [{ address: 'a@b.com' }],
    cc: [],
    subject: 'Re: hi',
    bodyText: 'body',
    rawIntent: null,
    polishDiff: null,
    systemPromptUsed: 'p',
    modelUsed: 'm',
    tokensIn: 1,
    tokensOut: 1,
    latencyMs: 1,
    createdAt: 1000 * version,
  });
}

describe('DraftsRepository.currentForThread', () => {
  it('returns the latest draft that is not sent or discarded', async () => {
    const { app, db } = await makeTestServer();
    // drafts has FK on thread_id/account_id (ON DELETE CASCADE) -> seed parents.
    db.prepare(
      `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','A','a@b.com')`,
    ).run();
    db.prepare(
      `INSERT INTO threads (id, account_id, message_count, state) VALUES ('th1','acc1',0,'needs_classification')`,
    ).run();
    const repo = new DraftsRepository(db);
    const v1 = seedDraft(db, 1);
    const v2 = seedDraft(db, 2);
    // v2 is pending_review (default) → current
    expect(repo.currentForThread('th1')?.id).toBe(v2);
    // discard v2 → falls back to v1 (still pending)
    repo.markDiscarded(v2);
    expect(repo.currentForThread('th1')?.id).toBe(v1);
    // send v1 → no current draft
    repo.markSent(v1, { sentAt: 1, finalBodySent: 'body' });
    expect(repo.currentForThread('th1')).toBeUndefined();
    await app.close();
  });
});
