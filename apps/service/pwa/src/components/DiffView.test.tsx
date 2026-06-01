import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DiffView } from './DiffView.js';

describe('DiffView', () => {
  it('renders eq/add/del lines', () => {
    render(
      <DiffView
        ops={[
          { op: 'eq', line: 'kept' },
          { op: 'add', line: 'added' },
          { op: 'del', line: 'removed' },
        ]}
      />,
    );
    expect(screen.getByText('kept')).toBeTruthy();
    expect(screen.getByText('added')).toBeTruthy();
    expect(screen.getByText('removed')).toBeTruthy();
  });
});
