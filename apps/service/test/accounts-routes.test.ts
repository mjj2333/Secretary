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

describe('accounts routes', () => {
  it('adds an IMAP account (healthcheck passes), stores password, lists it', async () => {
    const { app, session, store } = await makeTestServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/accounts/imap',
      headers: { authorization: `Bearer ${session}` },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    const id = res.json().data.id as string;
    expect(store.get(`imap.${id}`)).toBe('secret');

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/accounts',
      headers: { authorization: `Bearer ${session}` },
    });
    expect(list.json().data).toHaveLength(1);
    await app.close();
  });

  it('rejects unauthenticated', async () => {
    const { app } = await makeTestServer();
    const res = await app.inject({ method: 'GET', url: '/api/v1/accounts' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
