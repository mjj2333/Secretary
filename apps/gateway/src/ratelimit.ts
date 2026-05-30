export interface TokenBucketOptions {
  capacity: number;
  refillPerSecond: number;
}

interface BucketState {
  tokens: number;
  lastRefill: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs: number;
  remaining: number;
}

export class TokenBucket {
  private readonly buckets = new Map<string, BucketState>();
  private readonly capacity: number;
  private readonly refillPerMs: number;

  constructor(opts: TokenBucketOptions) {
    if (opts.capacity <= 0 || opts.refillPerSecond <= 0) {
      throw new Error('TokenBucket requires positive capacity and refill rate');
    }
    this.capacity = opts.capacity;
    this.refillPerMs = opts.refillPerSecond / 1000;
  }

  check(key: string, now: number = Date.now()): RateLimitResult {
    const bucket = this.refill(key, now);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, retryAfterMs: 0, remaining: Math.floor(bucket.tokens) };
    }
    const tokensNeeded = 1 - bucket.tokens;
    const retryAfterMs = Math.max(1, Math.ceil(tokensNeeded / this.refillPerMs));
    return { allowed: false, retryAfterMs, remaining: 0 };
  }

  reset(): void {
    this.buckets.clear();
  }

  private refill(key: string, now: number): BucketState {
    const existing = this.buckets.get(key);
    if (!existing) {
      const fresh: BucketState = { tokens: this.capacity, lastRefill: now };
      this.buckets.set(key, fresh);
      return fresh;
    }
    const elapsed = Math.max(0, now - existing.lastRefill);
    existing.tokens = Math.min(this.capacity, existing.tokens + elapsed * this.refillPerMs);
    existing.lastRefill = now;
    return existing;
  }
}
