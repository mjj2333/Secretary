import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { NeedsAttentionCard } from './NeedsAttentionCard.js';
import type { NeedsAttentionItem } from '@secretary/shared-types';

const base: NeedsAttentionItem = {
  id: 't1',
  accountId: 'a',
  subject: 'Reschedule',
  participants: [],
  messageCount: 1,
  lastMessageAt: new Date(Date.now() - 3_600_000).toISOString(),
  state: 'awaiting_your_reply',
  senderName: 'Jane Doe',
  hasDraft: true,
  urgency: 'high',
  slaDeadline: null,
  summary: 'Asking to reschedule.',
  hasPendingFollowUp: false,
};

describe('NeedsAttentionCard', () => {
  it('shows sender, urgency, summary, and "Review draft" when a draft exists', () => {
    render(
      <Router>
        <NeedsAttentionCard item={base} onGenerate={vi.fn()} generating={false} />
      </Router>,
    );
    expect(screen.getByText('Jane Doe')).toBeTruthy();
    expect(screen.getByText('high')).toBeTruthy();
    expect(screen.getByText('Asking to reschedule.')).toBeTruthy();
    expect(screen.getByText(/Review draft/)).toBeTruthy();
  });

  it('shows "Generate draft" when no draft exists', () => {
    render(
      <Router>
        <NeedsAttentionCard
          item={{ ...base, hasDraft: false }}
          onGenerate={vi.fn()}
          generating={false}
        />
      </Router>,
    );
    expect(screen.getByText('Generate draft')).toBeTruthy();
  });
});
