import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DraftPanel } from './DraftPanel.js';
import type { DraftView } from '@secretary/shared-types';

const draft = (over: Partial<DraftView> = {}): DraftView => ({
  id: 'd1',
  threadId: 't1',
  accountId: 'a',
  version: 2,
  to: [{ address: 'x@y.com' }],
  cc: [],
  subject: 'Re',
  bodyText: 'Hello',
  rawIntent: 'be brief',
  polishDiff: [{ op: 'eq', line: 'Hello' }],
  status: 'pending_review',
  modelUsed: 'm',
  createdAt: null,
  sentAt: null,
  ...over,
});

const noop = vi.fn();
const handlers = {
  onBodyChange: noop,
  onRegenerate: noop,
  onEditIntent: noop,
  onSend: noop,
  onDiscard: noop,
};

describe('DraftPanel', () => {
  it('shows the diff when toggled (raw intent present)', () => {
    render(<DraftPanel draft={draft()} body="Hello" busy={false} {...handlers} />);
    fireEvent.click(screen.getByText('diff'));
    expect(screen.getByText('Hello')).toBeTruthy(); // diff line rendered
  });
  it('disables the diff toggle when there is no polish diff', () => {
    render(
      <DraftPanel
        draft={draft({ polishDiff: null, rawIntent: null })}
        body="Hello"
        busy={false}
        {...handlers}
      />,
    );
    expect((screen.getByText('diff') as HTMLButtonElement).disabled).toBe(true);
  });
});
