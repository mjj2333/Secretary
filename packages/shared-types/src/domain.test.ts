import { describe, expect, it } from 'vitest';
import type { RawMessage, SendInput } from './domain.js';

describe('domain types', () => {
  it('constructs a RawMessage and SendInput (compile + shape check)', () => {
    const raw: RawMessage = {
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
    const send: SendInput = { to: [{ address: 'c@d.com' }], bodyText: 'hi' };
    expect(raw.from.address).toBe('a@b.com');
    expect(send.bodyText).toBe('hi');
  });
});
