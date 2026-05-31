import { describe, expect, it } from 'vitest';
import type { MessageRow, ThreadRow, ContactRow, ActionLogRow } from '../server/db/schema.js';

describe('new schema row types', () => {
  it('compile-checks the row shapes', () => {
    const t: Pick<ThreadRow, 'id' | 'state'> = { id: 't1', state: 'needs_classification' };
    const m: Pick<MessageRow, 'id' | 'direction'> = { id: 'm1', direction: 'inbound' };
    const c: Pick<ContactRow, 'id' | 'category'> = { id: 'c1', category: 'unknown' };
    const a: Pick<ActionLogRow, 'id' | 'actor'> = { id: 'a1', actor: 'system' };
    expect([t.state, m.direction, c.category, a.actor]).toEqual([
      'needs_classification',
      'inbound',
      'unknown',
      'system',
    ]);
  });
});
