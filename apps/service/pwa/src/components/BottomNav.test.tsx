import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Router } from 'wouter';
import { BottomNav } from './BottomNav.js';

describe('BottomNav', () => {
  it('renders the five primary destinations', () => {
    render(
      <Router>
        <BottomNav />
      </Router>,
    );
    for (const label of ['Attention', 'Follow-ups', 'Inbox', 'Contacts', 'Settings']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });
});
