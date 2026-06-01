import { describe, expect, it } from 'vitest';
import { makeTestServer } from './helpers/testServer.js';
import { DraftsRepository } from '../server/db/repositories/DraftsRepository.js';

describe('threads routes', () => {
  it('lists threads and returns a thread with its messages', async () => {
    const { app, session, db } = await makeTestServer();
    db.prepare(
      `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','A','a@b.com')`,
    ).run();
    db.prepare(
      `INSERT INTO threads (id, account_id, subject_normalized, participants, message_count, last_message_at, state)
       VALUES ('th1','acc1','hello','["a@b.com"]',1,1000,'needs_classification')`,
    ).run();
    db.prepare(
      `INSERT INTO messages (id, account_id, provider_id, thread_id, from_address, direction, date_received, subject, snippet)
       VALUES ('m1','acc1','u1','th1','a@b.com','inbound',1000,'Hello','hi')`,
    ).run();

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/threads?accountId=acc1',
      headers: { authorization: `Bearer ${session}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toHaveLength(1);

    const detail = await app.inject({
      method: 'GET',
      url: '/api/v1/threads/th1',
      headers: { authorization: `Bearer ${session}` },
    });
    expect(detail.json().data.messages).toHaveLength(1);
    expect(detail.json().data.messages[0].subject).toBe('Hello');
    await app.close();
  });

  it('404s an unknown thread with the error envelope', async () => {
    const { app, session } = await makeTestServer();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/threads/nope',
      headers: { authorization: `Bearer ${session}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
    await app.close();
  });
});

describe('thread detail enrichment', () => {
  it('includes senderName (contact display name) and the current draft', async () => {
    const { app, session, db } = await makeTestServer();
    db.prepare(
      `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','A','me@x.com')`,
    ).run();
    db.prepare(
      `INSERT INTO contacts (id, email_address, display_name, category, total_messages_in, total_messages_out, do_not_auto_draft) VALUES ('c1','jane@x.com','Jane Doe','client_established',1,0,0)`,
    ).run();
    db.prepare(
      `INSERT INTO threads (id, account_id, subject_normalized, participants, message_count, last_message_at, state) VALUES ('th1','acc1','Hi','["jane@x.com"]',1,1000,'awaiting_your_reply')`,
    ).run();
    db.prepare(
      `INSERT INTO messages (id, account_id, provider_id, thread_id, from_address, from_name, direction, date_received, subject, snippet) VALUES ('m1','acc1','u1','th1','jane@x.com','J. Doe','inbound',1000,'Hi','hello')`,
    ).run();
    new DraftsRepository(db).insert({
      threadId: 'th1',
      accountId: 'acc1',
      version: 1,
      inReplyToMessageId: null,
      to: [{ address: 'jane@x.com' }],
      cc: [],
      subject: 'Re: Hi',
      bodyText: 'Hello back',
      rawIntent: null,
      polishDiff: null,
      systemPromptUsed: 'p',
      modelUsed: 'm',
      tokensIn: 1,
      tokensOut: 1,
      latencyMs: 1,
      createdAt: 2000,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/threads/th1',
      headers: { authorization: `Bearer ${session}` },
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.senderName).toBe('Jane Doe');
    expect(data.currentDraft).not.toBeNull();
    expect(data.currentDraft.bodyText).toBe('Hello back');
    await app.close();
  });

  it('currentDraft is null when there is no reviewable draft; senderName falls back to from_name then email', async () => {
    const { app, session, db } = await makeTestServer();
    db.prepare(
      `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','A','me@x.com')`,
    ).run();
    db.prepare(
      `INSERT INTO threads (id, account_id, subject_normalized, participants, message_count, last_message_at, state) VALUES ('th2','acc1','Hi','["bob@x.com"]',1,1000,'awaiting_your_reply')`,
    ).run();
    db.prepare(
      `INSERT INTO messages (id, account_id, provider_id, thread_id, from_address, from_name, direction, date_received) VALUES ('m2','acc1','u2','th2','bob@x.com','Bob','inbound',1000)`,
    ).run();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/threads/th2',
      headers: { authorization: `Bearer ${session}` },
    });
    const { data } = res.json();
    expect(data.currentDraft).toBeNull();
    expect(data.senderName).toBe('Bob'); // no contact row → from_name
    await app.close();
  });
});

describe('threads attention/state/classify routes', () => {
  it('needs-attention returns awaiting_your_reply ordered, with follow-up flag', async () => {
    const { app, session, db } = await makeTestServer();
    db.prepare(
      `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','A','a@b.com')`,
    ).run();
    db.prepare(
      `INSERT INTO threads (id, account_id, subject_normalized, participants, message_count, last_message_at, state, urgency, sla_deadline, last_agent_summary)
       VALUES ('hi','acc1','urgent','[]',1,1000,'awaiting_your_reply','high',5000,'Reply needed')`,
    ).run();
    db.prepare(
      `INSERT INTO threads (id, account_id, subject_normalized, participants, message_count, last_message_at, state, urgency, sla_deadline)
       VALUES ('lo','acc1','later','[]',1,1000,'awaiting_your_reply','normal',9000)`,
    ).run();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/threads/needs-attention',
      headers: { authorization: `Bearer ${session}` },
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.map((t: { id: string }) => t.id)).toEqual(['hi', 'lo']);
    expect(data[0].urgency).toBe('high');
    expect(data[0].summary).toBe('Reply needed');
    expect(data[0].slaDeadline).toBe(new Date(5000).toISOString());
    expect(data[0].hasPendingFollowUp).toBe(false);
    await app.close();
  });

  it('needs-attention items carry senderName and hasDraft', async () => {
    const { app, session, db } = await makeTestServer();
    db.prepare(
      `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','A','me@x.com')`,
    ).run();
    db.prepare(
      `INSERT INTO contacts (id, email_address, display_name, category, total_messages_in, total_messages_out, do_not_auto_draft) VALUES ('c1','jane@x.com','Jane Doe','client_established',1,0,0)`,
    ).run();
    db.prepare(
      `INSERT INTO threads (id, account_id, subject_normalized, participants, message_count, last_message_at, state, urgency, sla_deadline) VALUES ('th1','acc1','Hi','["jane@x.com"]',1,1000,'awaiting_your_reply','high',5000)`,
    ).run();
    db.prepare(
      `INSERT INTO messages (id, account_id, provider_id, thread_id, from_address, direction, date_received) VALUES ('m1','acc1','u1','th1','jane@x.com','inbound',1000)`,
    ).run();
    new DraftsRepository(db).insert({
      threadId: 'th1',
      accountId: 'acc1',
      version: 1,
      inReplyToMessageId: null,
      to: [{ address: 'jane@x.com' }],
      cc: [],
      subject: 'Re',
      bodyText: 'b',
      rawIntent: null,
      polishDiff: null,
      systemPromptUsed: 'p',
      modelUsed: 'm',
      tokensIn: 1,
      tokensOut: 1,
      latencyMs: 1,
      createdAt: 2000,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/threads/needs-attention',
      headers: { authorization: `Bearer ${session}` },
    });
    const item = res.json().data[0];
    expect(item.senderName).toBe('Jane Doe');
    expect(item.hasDraft).toBe(true);
    await app.close();
  });

  it('POST /threads/:id/state applies a manual override', async () => {
    const { app, session, db } = await makeTestServer();
    db.prepare(
      `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','A','a@b.com')`,
    ).run();
    db.prepare(
      `INSERT INTO threads (id, account_id, subject_normalized, participants, message_count, last_message_at, state)
       VALUES ('t1','acc1','x','[]',1,1000,'awaiting_your_reply')`,
    ).run();

    const ok = await app.inject({
      method: 'POST',
      url: '/api/v1/threads/t1/state',
      headers: { authorization: `Bearer ${session}` },
      payload: { state: 'closed', reason: 'handled offline' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.state).toBe('closed');

    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/threads/t1/state',
      headers: { authorization: `Bearer ${session}` },
      payload: { state: 'not_a_state' },
    });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });

  it('POST /threads/:id/classify enqueues the latest inbound; 400 when none', async () => {
    const { app, session, db, classificationQueue } = await makeTestServer();
    db.prepare(
      `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','A','a@b.com')`,
    ).run();
    db.prepare(
      `INSERT INTO threads (id, account_id, subject_normalized, participants, message_count, last_message_at, state)
       VALUES ('t1','acc1','x','[]',1,1000,'needs_classification')`,
    ).run();
    db.prepare(
      `INSERT INTO messages (id, account_id, provider_id, thread_id, from_address, direction, date_received)
       VALUES ('m1','acc1','u1','t1','a@b.com','inbound',1000)`,
    ).run();

    const ok = await app.inject({
      method: 'POST',
      url: '/api/v1/threads/t1/classify',
      headers: { authorization: `Bearer ${session}` },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.queued).toBe(true);
    expect(classificationQueue.enqueued).toEqual(['m1']);

    db.prepare(
      `INSERT INTO threads (id, account_id, subject_normalized, participants, message_count, last_message_at, state)
       VALUES ('t2','acc1','y','[]',0,1000,'needs_classification')`,
    ).run();
    const none = await app.inject({
      method: 'POST',
      url: '/api/v1/threads/t2/classify',
      headers: { authorization: `Bearer ${session}` },
    });
    expect(none.statusCode).toBe(400);
    await app.close();
  });

  it('POST /threads/:id/state 404s an unknown thread', async () => {
    const { app, session } = await makeTestServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/threads/nope/state',
      headers: { authorization: `Bearer ${session}` },
      payload: { state: 'closed' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
    await app.close();
  });

  it('POST /threads/:id/classify 404s an unknown thread', async () => {
    const { app, session } = await makeTestServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/threads/nope/classify',
      headers: { authorization: `Bearer ${session}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
    await app.close();
  });
});
