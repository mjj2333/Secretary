import { describe, expect, it } from 'vitest';
import { formatTimeAgo } from './timeAgo.js';

const NOW = new Date('2026-05-31T12:00:00.000Z').getTime();

describe('formatTimeAgo', () => {
  it('formats recent, minutes, hours, and days', () => {
    expect(formatTimeAgo(new Date(NOW - 10_000).toISOString(), NOW)).toBe('just now');
    expect(formatTimeAgo(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe('5m');
    expect(formatTimeAgo(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe('3h');
    expect(formatTimeAgo(new Date(NOW - 2 * 86_400_000).toISOString(), NOW)).toBe('2d');
  });
  it('handles null and far past', () => {
    expect(formatTimeAgo(null, NOW)).toBe('');
    expect(formatTimeAgo(new Date(NOW - 40 * 86_400_000).toISOString(), NOW)).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
  });
});
