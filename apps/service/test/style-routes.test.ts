import { describe, expect, it } from 'vitest';
import { makeTestServer } from './helpers/testServer.js';
import { ThreadsRepository } from '../server/db/repositories/ThreadsRepository.js';
import { MessagesRepository } from '../server/db/repositories/MessagesRepository.js';
import { StyleExamplesRepository } from '../server/db/repositories/StyleExamplesRepository.js';
import type { RawMessage } from '@secretary/shared-types';

function outbound(providerId: string, when: number): RawMessage {
  return {
    providerId,
    references: [],
    messageIdHeader: `<${providerId}@x>`,
    from: { address: 'me@b.com' },
    to: [{ address: 'alice@x.com' }],
    cc: [],
    bcc: [],
    subject: 'Re: Hi',
    bodyText: 'A real sent reply body.',
    snippet: 'A real sent reply body.',
    direction: 'outbound',
    dateSent: when,
    isRead: true,
    isStarred: false,
    folder: 'Sent',
    labels: [],
    attachmentsMeta: [],
  };
}

function seedMessage(db: Awaited<ReturnType<typeof makeTestServer>>['db']): string {
  db.prepare(
    `INSERT OR IGNORE INTO accounts (id, provider, display_name, email_address) VALUES ('a1','imap','A','me@b.com')`,
  ).run();
  const threadId = new ThreadsRepository(db).create('a1', 's', ['x@y.com'], 1000);
  return new MessagesRepository(db).insert('a1', threadId, outbound('p1', 2000))!;
}

describe('style routes — mining', () => {
  it('POST /style/mine enqueues outbound candidates and reports counts', async () => {
    const t = await makeTestServer();
    const threads = new ThreadsRepository(t.db);
    const messages = new MessagesRepository(t.db);
    t.db
      .prepare(`INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('a1','imap','A','me@b.com')`)
      .run();
    const threadId = threads.create('a1', 'hi', ['alice@x.com'], 1000);
    messages.insert('a1', threadId, outbound('o1', 2000));
    messages.insert('a1', threadId, outbound('o2', 3000));

    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/style/mine',
      headers: { authorization: `Bearer ${t.session}` },
      payload: {},
    });
    await t.app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json().data.enqueued).toBe(2);
    expect(res.json().data.alreadyMined).toBe(0);
    expect(t.mining.enqueued).toHaveLength(2);
  });

  it('GET /style/mining-status returns the job snapshot', async () => {
    const t = await makeTestServer();
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/v1/style/mining-status',
      headers: { authorization: `Bearer ${t.session}` },
    });
    await t.app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ running: false, total: 0, done: 0 });
  });

  it('POST /style/mine returns 409 when a job is already running', async () => {
    const t = await makeTestServer();
    t.mining.job.start(5);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/style/mine',
      headers: { authorization: `Bearer ${t.session}` },
      payload: {},
    });
    await t.app.close();
    expect(res.statusCode).toBe(409);
  });

  it('POST /style/mine returns 503 when the gateway is not configured', async () => {
    const t = await makeTestServer({ miningGatewayReady: false });
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/style/mine',
      headers: { authorization: `Bearer ${t.session}` },
      payload: {},
    });
    await t.app.close();
    expect(res.statusCode).toBe(503);
  });
});

describe('style routes — review', () => {
  it('GET /style/examples?status=pending returns mapped views; PATCH approves + edits', async () => {
    const t = await makeTestServer();
    const messageId = seedMessage(t.db);
    const repo = new StyleExamplesRepository(t.db);
    const id = repo.insertPending({
      sourceMessageId: messageId,
      contactCategory: 'vendor',
      contextSummary: 'ctx',
      replyText: 'reply',
      tags: '["concise"]',
    });

    const list = await t.app.inject({
      method: 'GET',
      url: '/api/v1/style/examples?status=pending',
      headers: { authorization: `Bearer ${t.session}` },
    });
    expect(list.statusCode).toBe(200);
    const views = list.json().data as Array<Record<string, unknown>>;
    expect(views).toHaveLength(1);
    expect(views[0]!.tags).toEqual(['concise']);
    expect(views[0]!.status).toBe('pending');

    const patch = await t.app.inject({
      method: 'PATCH',
      url: `/api/v1/style/examples/${id}`,
      headers: { authorization: `Bearer ${t.session}` },
      payload: { status: 'approved', contextSummary: 'edited ctx', tags: ['warm', 'brief'] },
    });
    await t.app.close();
    expect(patch.statusCode).toBe(200);
    const view = patch.json().data as Record<string, unknown>;
    expect(view.status).toBe('approved');
    expect(view.contextSummary).toBe('edited ctx');
    expect(view.tags).toEqual(['warm', 'brief']);
  });

  it('PATCH /style/examples/:id 404s for unknown id', async () => {
    const t = await makeTestServer();
    const res = await t.app.inject({
      method: 'PATCH',
      url: '/api/v1/style/examples/nope',
      headers: { authorization: `Bearer ${t.session}` },
      payload: { status: 'rejected' },
    });
    await t.app.close();
    expect(res.statusCode).toBe(404);
  });
});
