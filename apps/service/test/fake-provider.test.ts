import { describe, expect, it } from 'vitest';
import type { RawMessage } from '@secretary/shared-types';
import { FakeEmailProvider } from './helpers/fakeProvider.js';

const msg: RawMessage = {
  providerId: 'u1',
  references: [],
  from: { address: 'a@b.com' },
  to: [{ address: 'c@d.com' }],
  cc: [],
  bcc: [],
  direction: 'inbound',
  isRead: false,
  isStarred: false,
  folder: 'INBOX',
  labels: [],
  attachmentsMeta: [],
};

describe('FakeEmailProvider', () => {
  it('returns scripted messages from syncFull and fires the watcher', async () => {
    const p = new FakeEmailProvider('acc1', [msg]);
    expect(await p.syncFull(0)).toHaveLength(1);
    let fired = 0;
    await p.startWatching(() => {
      fired += 1;
    });
    p.emitChange();
    expect(fired).toBe(1);
    const sent = await p.sendMessage({ to: [{ address: 'c@d.com' }], bodyText: 'hi' });
    expect(sent.providerMessageId).toMatch(/^fake-/);
  });
});
