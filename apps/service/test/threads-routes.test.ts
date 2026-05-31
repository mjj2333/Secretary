import { describe, expect, it } from 'vitest';
import { makeTestServer } from './helpers/testServer.js';

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
