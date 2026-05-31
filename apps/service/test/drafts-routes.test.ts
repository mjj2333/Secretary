import { describe, expect, it } from 'vitest';
import { makeTestServer, type TestServer } from './helpers/testServer.js';

describe('drafts routes', () => {
  function insertThreadWithInbound(db: TestServer['db']) {
    db.prepare(
      `INSERT INTO accounts (id, provider, display_name, email_address) VALUES ('acc1','imap','A','a@b.com')`,
    ).run();
    db.prepare(
      `INSERT INTO threads (id, account_id, subject_normalized, participants, message_count, last_message_at, last_inbound_at, state)
       VALUES ('t1','acc1','can we meet','[]',1,1000,1000,'awaiting_your_reply')`,
    ).run();
    db.prepare(
      `INSERT INTO messages (id, account_id, provider_id, thread_id, message_id_header, from_address, from_name, direction, date_received, subject)
       VALUES ('m1','acc1','u1','t1','<u1@x>','alice@x.com','Alice','inbound',1000,'Can we meet?')`,
    ).run();
  }

  it('POST /drafts creates a draft synchronously, GET returns it, PATCH edits it', async () => {
    const { app, session, db } = await makeTestServer({ draftBody: 'Tuesday works.' });
    insertThreadWithInbound(db);

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/drafts',
      headers: { authorization: `Bearer ${session}` },
      payload: { threadId: 't1' },
    });
    expect(created.statusCode).toBe(200);
    const draft = created.json().data;
    expect(draft.bodyText).toBe('Tuesday works.');
    expect(draft.subject).toBe('Re: Can we meet?');
    expect(draft.to[0].address).toBe('alice@x.com');
    expect(draft.status).toBe('pending_review');

    const got = await app.inject({
      method: 'GET',
      url: `/api/v1/drafts/${draft.id}`,
      headers: { authorization: `Bearer ${session}` },
    });
    expect(got.json().data.id).toBe(draft.id);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/drafts/${draft.id}`,
      headers: { authorization: `Bearer ${session}` },
      payload: { bodyText: 'Tuesday 2pm works.' },
    });
    expect(patched.json().data.bodyText).toBe('Tuesday 2pm works.');
    await app.close();
  });

  it('POST /drafts/:id/send sends the edited body, sets threading header, flips thread to awaiting_their_reply', async () => {
    const { app, session, db, providers } = await makeTestServer({ draftBody: 'Original.' });
    insertThreadWithInbound(db);
    const { FakeEmailProvider } = await import('./helpers/fakeProvider.js');
    const provider = new FakeEmailProvider('acc1', []);
    providers.set(provider);

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/drafts',
      headers: { authorization: `Bearer ${session}` },
      payload: { threadId: 't1' },
    });
    const { id } = created.json().data as { id: string };
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/drafts/${id}`,
      headers: { authorization: `Bearer ${session}` },
      payload: { bodyText: 'Edited final.' },
    });

    const sent = await app.inject({
      method: 'POST',
      url: `/api/v1/drafts/${id}/send`,
      headers: { authorization: `Bearer ${session}` },
      payload: {},
    });
    expect(sent.statusCode).toBe(200);
    expect(sent.json().data.threadState).toBe('awaiting_their_reply');

    const draftRow = db
      .prepare('SELECT status, final_body_sent FROM drafts WHERE id = ?')
      .get(id) as {
      status: string;
      final_body_sent: string;
    };
    const threadRow = db.prepare("SELECT state FROM threads WHERE id='t1'").get() as {
      state: string;
    };
    expect(draftRow.status).toBe('sent');
    expect(draftRow.final_body_sent).toBe('Edited final.');
    expect(threadRow.state).toBe('awaiting_their_reply');
    expect(provider.lastSend?.inReplyToMessageId).toBe('<u1@x>'); // RFC Message-ID, not internal id
    await app.close();
  });

  it('DELETE /drafts/:id discards; POST /drafts/:id/send on a discarded draft is 400', async () => {
    const { app, session, db } = await makeTestServer({ draftBody: 'x' });
    insertThreadWithInbound(db);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/drafts',
      headers: { authorization: `Bearer ${session}` },
      payload: { threadId: 't1' },
    });
    const { id } = created.json().data as { id: string };
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/drafts/${id}`,
      headers: { authorization: `Bearer ${session}` },
    });
    expect(del.json().data.discarded).toBe(true);
    const send = await app.inject({
      method: 'POST',
      url: `/api/v1/drafts/${id}/send`,
      headers: { authorization: `Bearer ${session}` },
      payload: {},
    });
    expect(send.statusCode).toBe(400);
    await app.close();
  });

  it('POST /drafts/:id/send returns 502 + marks failed + leaves thread unchanged when the provider throws', async () => {
    const { app, session, db, providers } = await makeTestServer({ draftBody: 'x' });
    insertThreadWithInbound(db);
    const { FakeEmailProvider } = await import('./helpers/fakeProvider.js');
    const provider = new FakeEmailProvider('acc1', []);
    provider.failSend = true;
    providers.set(provider);

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/drafts',
      headers: { authorization: `Bearer ${session}` },
      payload: { threadId: 't1' },
    });
    const { id } = created.json().data as { id: string };
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/drafts/${id}/send`,
      headers: { authorization: `Bearer ${session}` },
      payload: {},
    });
    expect(res.statusCode).toBe(502);
    const draftRow = db.prepare('SELECT status FROM drafts WHERE id = ?').get(id) as {
      status: string;
    };
    const threadRow = db.prepare("SELECT state FROM threads WHERE id='t1'").get() as {
      state: string;
    };
    expect(draftRow.status).toBe('failed');
    expect(threadRow.state).toBe('awaiting_your_reply'); // NOT flipped on send failure
    await app.close();
  });

  it('POST /drafts/:id/send returns 404 when the account has no connected provider', async () => {
    const { app, session, db } = await makeTestServer({ draftBody: 'x' });
    insertThreadWithInbound(db);
    // no provider registered for acc1
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/drafts',
      headers: { authorization: `Bearer ${session}` },
      payload: { threadId: 't1' },
    });
    const { id } = created.json().data as { id: string };
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/drafts/${id}/send`,
      headers: { authorization: `Bearer ${session}` },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('GET unknown draft -> 404', async () => {
    const { app, session } = await makeTestServer();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/drafts/nope',
      headers: { authorization: `Bearer ${session}` },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
