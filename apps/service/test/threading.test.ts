import { describe, expect, it } from 'vitest';
import { normalizeSubject, resolveThreadId, type ThreadLookups } from '../server/sync/threading.js';

describe('normalizeSubject', () => {
  it('strips Re/Fwd prefixes and lowercases', () => {
    expect(normalizeSubject('Re: Fwd: Hello World')).toBe('hello world');
    expect(normalizeSubject(undefined)).toBe('');
  });
});

describe('resolveThreadId', () => {
  const base = { references: [] as string[], subject: 'Hello' };
  it('matches an existing thread by reply-chain message ids', () => {
    const lookups: ThreadLookups = {
      threadIdForMessageIds: (ids) => (ids.includes('<a@x>') ? 'T1' : undefined),
      threadIdForSubject: () => undefined,
    };
    expect(resolveThreadId({ ...base, inReplyTo: '<a@x>' }, lookups)).toBe('T1');
  });

  it('falls back to normalized subject', () => {
    const lookups: ThreadLookups = {
      threadIdForMessageIds: () => undefined,
      threadIdForSubject: (s) => (s === 'hello' ? 'T2' : undefined),
    };
    expect(resolveThreadId(base, lookups)).toBe('T2');
  });

  it('returns null when nothing matches (caller creates a new thread)', () => {
    const lookups: ThreadLookups = {
      threadIdForMessageIds: () => undefined,
      threadIdForSubject: () => undefined,
    };
    expect(resolveThreadId(base, lookups)).toBeNull();
  });
});
