import { describe, expect, it } from 'vitest';
import { makeTestServer } from './helpers/testServer.js';

describe('contacts routes', () => {
  it('lists, gets, and patches a contact (category override is recorded)', async () => {
    const { app, session, db } = await makeTestServer();
    db.prepare(
      `INSERT INTO contacts (id, email_address, display_name, category, total_messages_in, total_messages_out, do_not_auto_draft, last_contact_at)
       VALUES ('c1','alice@x.com','Alice','unknown',3,1,0,2000)`,
    ).run();

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/contacts',
      headers: { authorization: `Bearer ${session}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().data[0].emailAddress).toBe('alice@x.com');
    expect(list.json().data[0].lastContactAt).toBe(new Date(2000).toISOString());

    const get = await app.inject({
      method: 'GET',
      url: '/api/v1/contacts/c1',
      headers: { authorization: `Bearer ${session}` },
    });
    expect(get.json().data.category).toBe('unknown');

    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/v1/contacts/c1',
      headers: { authorization: `Bearer ${session}` },
      payload: { category: 'client_established', notes: 'VIP' },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().data.category).toBe('client_established');

    const log = db
      .prepare("SELECT COUNT(*) AS n FROM action_log WHERE action='contact_updated'")
      .get() as { n: number };
    expect(log.n).toBe(1);

    const bad = await app.inject({
      method: 'PATCH',
      url: '/api/v1/contacts/c1',
      headers: { authorization: `Bearer ${session}` },
      payload: { category: 'bogus' },
    });
    expect(bad.statusCode).toBe(400);

    const missing = await app.inject({
      method: 'GET',
      url: '/api/v1/contacts/nope',
      headers: { authorization: `Bearer ${session}` },
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it('PATCH styleNotes stores + returns a plain string (not JSON-quoted)', async () => {
    const { app, session, db } = await makeTestServer();
    db.prepare(
      `INSERT INTO contacts (id, email_address, display_name, category, total_messages_in, total_messages_out, do_not_auto_draft) VALUES ('c1','jane@x.com','Jane','client_established',1,0,0)`,
    ).run();
    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/v1/contacts/c1',
      headers: { authorization: `Bearer ${session}` },
      payload: { styleNotes: 'Keep it warm and brief.' },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().data.styleNotes).toBe('Keep it warm and brief.');
    const get = await app.inject({
      method: 'GET',
      url: '/api/v1/contacts/c1',
      headers: { authorization: `Bearer ${session}` },
    });
    expect(get.json().data.styleNotes).toBe('Keep it warm and brief.');
    await app.close();
  });
});
