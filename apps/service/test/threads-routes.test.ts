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
