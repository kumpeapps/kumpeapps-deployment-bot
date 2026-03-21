type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  resetEpochSeconds: number;
};

type Bucket = {
  windowStartMs: number;
  count: number;
};

export class InMemoryRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private lastCleanupMs = 0;

  constructor(
    private readonly windowMs: number,
    private readonly cleanupIntervalMs: number = 60_000
  ) {}

  consume(key: string, maxRequests: number): RateLimitResult {
    const now = Date.now();

    if (now - this.lastCleanupMs >= this.cleanupIntervalMs) {
      this.cleanup(now);
      this.lastCleanupMs = now;
    }

    const existing = this.buckets.get(key);
    const inCurrentWindow = existing && now - existing.windowStartMs < this.windowMs;

    if (!inCurrentWindow) {
      this.buckets.set(key, { windowStartMs: now, count: 1 });
      return {
        allowed: true,
        remaining: Math.max(0, maxRequests - 1),
        resetEpochSeconds: Math.floor((now + this.windowMs) / 1000)
      };
    }

    existing.count += 1;
    const remaining = Math.max(0, maxRequests - existing.count);
    return {
      allowed: existing.count <= maxRequests,
      remaining,
      resetEpochSeconds: Math.floor((existing.windowStartMs + this.windowMs) / 1000)
    };
  }

  private cleanup(now: number): void {
    for (const [key, bucket] of this.buckets.entries()) {
      if (now - bucket.windowStartMs >= this.windowMs) {
        this.buckets.delete(key);
      }
    }
  }
}
