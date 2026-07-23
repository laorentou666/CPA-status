export class TokenBucketRateLimiter {
  constructor({ now = () => Date.now(), maxEntries = 10_000 } = {}) {
    this.now = now;
    this.maxEntries = Math.max(1, Number(maxEntries) || 1);
    this.buckets = new Map();
  }

  consume(key, { limit, windowMs, cost = 1 }) {
    const capacity = Math.max(1, Number(limit) || 1);
    const duration = Math.max(1, Number(windowMs) || 1);
    const requested = Math.max(0, Number(cost) || 0);
    const now = this.now();
    const previous = this.buckets.get(key);
    const elapsed = previous ? Math.max(0, now - previous.updatedAt) : 0;
    const replenished = previous
      ? Math.min(capacity, previous.tokens + (elapsed * capacity) / duration)
      : capacity;
    const allowed = replenished >= requested;
    const tokens = allowed ? replenished - requested : replenished;

    if (previous) this.buckets.delete(key);
    while (!previous && this.buckets.size >= this.maxEntries) {
      this.buckets.delete(this.buckets.keys().next().value);
    }
    this.buckets.set(key, { tokens, updatedAt: now });

    const missing = allowed ? 0 : requested - tokens;
    return {
      allowed,
      remaining: Math.max(0, Math.floor(tokens)),
      retryAfterMs: allowed ? 0 : Math.ceil((missing * duration) / capacity),
    };
  }

  prune(now = this.now(), maxIdleMs = 60 * 60 * 1000) {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.updatedAt > maxIdleMs) this.buckets.delete(key);
    }
  }

  clear() {
    this.buckets.clear();
  }
}
