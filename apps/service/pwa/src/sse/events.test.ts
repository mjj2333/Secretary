import { describe, expect, it } from 'vitest';
import { eventToInvalidations } from './events.js';

describe('eventToInvalidations', () => {
  it('thread:updated invalidates needs-attention, the thread, and threads', () => {
    const keys = eventToInvalidations({ type: 'thread:updated', payload: { threadId: 't1' } });
    expect(keys).toEqual([['needs-attention'], ['thread', 't1'], ['threads']]);
  });

  it('draft:ready invalidates the thread (and needs-attention)', () => {
    const keys = eventToInvalidations({
      type: 'draft:ready',
      payload: { threadId: 't2', draftId: 'd1' },
    });
    expect(keys).toContainEqual(['thread', 't2']);
    expect(keys).toContainEqual(['needs-attention']);
  });

  it('account:status invalidates accounts; unknown/no-payload events yield []', () => {
    expect(eventToInvalidations({ type: 'account:status', payload: {} })).toEqual([['accounts']]);
    expect(eventToInvalidations({ type: 'sync:progress', payload: {} })).toEqual([]);
    expect(eventToInvalidations({ type: 'thread:updated', payload: {} })).toEqual([
      ['needs-attention'],
      ['threads'],
    ]);
  });

  it('mining:progress yields no query invalidations (handled via setQueryData)', () => {
    expect(eventToInvalidations({ type: 'mining:progress', payload: { done: 1, total: 3 } })).toEqual(
      [],
    );
  });
});
