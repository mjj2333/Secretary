import { describe, expect, it } from 'vitest';
import { isQuietHours } from '../server/agent/quietHours.js';

const at = (h: number, m = 0): Date => new Date(2026, 0, 1, h, m, 0);

describe('isQuietHours', () => {
  it('overnight window 22:00–08:00', () => {
    expect(isQuietHours(at(23), '22:00', '08:00')).toBe(true);
    expect(isQuietHours(at(2), '22:00', '08:00')).toBe(true);
    expect(isQuietHours(at(7, 59), '22:00', '08:00')).toBe(true);
    expect(isQuietHours(at(8), '22:00', '08:00')).toBe(false); // end exclusive
    expect(isQuietHours(at(12), '22:00', '08:00')).toBe(false);
    expect(isQuietHours(at(22), '22:00', '08:00')).toBe(true); // start inclusive
  });
  it('same-day window 09:00–17:00', () => {
    expect(isQuietHours(at(10), '09:00', '17:00')).toBe(true);
    expect(isQuietHours(at(8), '09:00', '17:00')).toBe(false);
    expect(isQuietHours(at(17), '09:00', '17:00')).toBe(false);
  });
  it('empty/equal window is never quiet', () => {
    expect(isQuietHours(at(3), '00:00', '00:00')).toBe(false);
  });
});
