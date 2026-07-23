import test from 'node:test';
import assert from 'node:assert/strict';
import { TokenBucketRateLimiter } from '../src/rate-limiter.js';

test('token bucket limits bursts and refills over the configured window', () => {
  let now = 1000;
  const limiter = new TokenBucketRateLimiter({ now: () => now });
  const policy = { limit: 2, windowMs: 1000 };

  assert.equal(limiter.consume('client', policy).allowed, true);
  assert.equal(limiter.consume('client', policy).allowed, true);
  const denied = limiter.consume('client', policy);
  assert.equal(denied.allowed, false);
  assert.equal(denied.retryAfterMs, 500);

  now += 500;
  assert.equal(limiter.consume('client', policy).allowed, true);
});

test('token bucket keeps its identity map bounded', () => {
  const limiter = new TokenBucketRateLimiter({ maxEntries: 2 });
  const policy = { limit: 1, windowMs: 1000 };

  limiter.consume('oldest', policy);
  limiter.consume('middle', policy);
  limiter.consume('newest', policy);

  assert.equal(limiter.buckets.size, 2);
  assert.equal(limiter.buckets.has('oldest'), false);
  assert.equal(limiter.buckets.has('newest'), true);
});
