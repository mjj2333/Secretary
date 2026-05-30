import { describe, expect, it } from 'vitest';
import { TokenBucket } from '../src/ratelimit.js';

describe('TokenBucket', () => {
  it('rejects invalid configuration', () => {
    expect(() => new TokenBucket({ capacity: 0, refillPerSecond: 1 })).toThrow();
    expect(() => new TokenBucket({ capacity: 10, refillPerSecond: 0 })).toThrow();
  });

  it('allows up to capacity bursts then rate-limits', () => {
    const bucket = new TokenBucket({ capacity: 3, refillPerSecond: 1 });
    const now = 1_000_000;
    expect(bucket.check('k', now).allowed).toBe(true);
    expect(bucket.check('k', now).allowed).toBe(true);
    expect(bucket.check('k', now).allowed).toBe(true);
    const blocked = bucket.check('k', now);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it('refills tokens over time', () => {
    const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 1 });
    const t0 = 0;
    expect(bucket.check('k', t0).allowed).toBe(true);
    expect(bucket.check('k', t0).allowed).toBe(true);
    expect(bucket.check('k', t0).allowed).toBe(false);
    expect(bucket.check('k', t0 + 1500).allowed).toBe(true);
  });

  it('isolates buckets by key', () => {
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 1 });
    expect(bucket.check('a').allowed).toBe(true);
    expect(bucket.check('a').allowed).toBe(false);
    expect(bucket.check('b').allowed).toBe(true);
  });

  it('returns increasing remaining when bucket has tokens', () => {
    const bucket = new TokenBucket({ capacity: 5, refillPerSecond: 1 });
    const r1 = bucket.check('k', 0);
    expect(r1.remaining).toBe(4);
  });

  it('caps tokens at capacity', () => {
    const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 100 });
    expect(bucket.check('k', 0).allowed).toBe(true);
    // Simulate large gap; tokens should not exceed capacity.
    const r = bucket.check('k', 60_000);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(1);
  });
});
