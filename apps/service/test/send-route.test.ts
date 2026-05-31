import { describe, expect, it } from 'vitest';
import { makeTestServer } from './helpers/testServer.js';

const body = {
  displayName: 'Me',
  emailAddress: 'me@example.com',
  imapHost: 'imap.example.com',
  imapPort: 993,
  useTls: true,
  smtpHost: 'smtp.example.com',
  smtpPort: 465,
  password: 'secret',
};

describe('send route', () => {
  it('sends via the account provider', async () => {
    const { app, session } = await makeTestServer();
    const add = await app.inject({
      method: 'POST',
      url: '/api/v1/accounts/imap',
      headers: { authorization: `Bearer ${session}` },
      payload: body,
    });
    const id = add.json().data.id as string;

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/accounts/${id}/send`,
      headers: { authorization: `Bearer ${session}` },
      payload: { to: [{ address: 'c@d.com' }], subject: 'Hi', bodyText: 'hello' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.providerMessageId).toMatch(/^fake-/);
    await app.close();
  });

  it('404s send for an unknown account', async () => {
    const { app, session } = await makeTestServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/accounts/nope/send',
      headers: { authorization: `Bearer ${session}` },
      payload: { to: [{ address: 'c@d.com' }], bodyText: 'hi' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
