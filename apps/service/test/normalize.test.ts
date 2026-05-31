import { describe, expect, it } from 'vitest';
import type { RawMessage } from '@secretary/shared-types';
import { snippetOf, participantsOf } from '../server/sync/normalize.js';

const raw: RawMessage = {
  providerId: 'u1',
  references: [],
  from: { address: 'Alice@Example.com', name: 'Alice' },
  to: [{ address: 'bob@example.com' }],
  cc: [{ address: 'carol@example.com' }],
  bcc: [],
  subject: 'Hi',
  bodyText: '  Hello there, this is a long body. '.repeat(20),
  direction: 'inbound',
  isRead: false,
  isStarred: false,
  folder: 'INBOX',
  labels: [],
  attachmentsMeta: [],
};

describe('snippetOf', () => {
  it('trims and caps to 200 chars', () => {
    const s = snippetOf(raw.bodyText);
    expect(s.length).toBeLessThanOrEqual(200);
    expect(s.startsWith('Hello there')).toBe(true);
  });
  it('handles missing body', () => {
    expect(snippetOf(undefined)).toBe('');
  });
});

describe('participantsOf', () => {
  it('collects unique lowercased addresses from from/to/cc', () => {
    expect(participantsOf(raw).sort()).toEqual(
      ['alice@example.com', 'bob@example.com', 'carol@example.com'].sort(),
    );
  });
});
