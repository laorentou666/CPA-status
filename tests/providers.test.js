import test from 'node:test';
import assert from 'node:assert/strict';
import { ProbeError, ProviderRegistry } from '../src/providers.js';

test('Codex provider parses primary, weekly and credit balance data', async () => {
  const registry = new ProviderRegistry();
  const requests = [];
  const client = {
    async apiCall(authIndex, request) {
      requests.push({ authIndex, request });
      return {
        statusCode: 200,
        headers: {},
        body: JSON.stringify({
          plan_type: 'plus',
          rate_limit: {
            primary_window: { used_percent: 20, reset_after_seconds: 60 },
            secondary_window: { used_percent: 60, reset_after_seconds: 3600 },
          },
          credits: { balance: '8.5', approx_local_messages: 40 },
        }),
      };
    },
  };
  const result = await registry.probe({
    authIndex: 'codex-1',
    provider: 'codex',
    metadata: { idToken: { chatgpt_account_id: 'acct-1' } },
  }, client);
  assert.equal(result.windows.length, 2);
  assert.equal(result.summary.balance, 8.5);
  assert.equal(requests[0].request.header['Chatgpt-Account-Id'], 'acct-1');
});

test('Claude provider parses documented usage windows', async () => {
  const registry = new ProviderRegistry();
  const client = {
    async apiCall(_authIndex, request) {
      if (request.url.endsWith('/usage')) {
        return { statusCode: 200, headers: {}, body: JSON.stringify({
          five_hour: { utilization: 30, resets_at: '2026-07-21T12:00:00Z' },
          seven_day: { utilization: 70, resets_at: '2026-07-27T12:00:00Z' },
        }) };
      }
      return { statusCode: 200, headers: {}, body: JSON.stringify({ account: { has_claude_pro: true } }) };
    },
  };
  const result = await registry.probe({ authIndex: 'claude-1', provider: 'claude', metadata: {} }, client);
  assert.equal(result.windows.length, 2);
  assert.equal(result.planType, 'pro');
});

test('Kimi provider parses documented usage limits', async () => {
  const registry = new ProviderRegistry();
  const client = {
    async apiCall() {
      return { statusCode: 200, headers: {}, body: JSON.stringify({
        limits: [{ name: 'weekly', title: 'Weekly', detail: { used: 20, limit: 100, resetIn: 3600 } }],
      }) };
    },
  };
  const result = await registry.probe({ authIndex: 'kimi-1', provider: 'kimi', metadata: {} }, client);
  assert.equal(result.windows[0].usedPercent, 20);
  assert.ok(result.windows[0].resetAt);
});

test('Antigravity provider parses quota summary buckets', async () => {
  const registry = new ProviderRegistry();
  const client = {
    async apiCall() {
      return { statusCode: 200, headers: {}, body: JSON.stringify({
        groups: [{ displayName: 'Gemini', buckets: [{ bucketId: 'weekly', remainingFraction: 0.7, resetTime: '2026-07-27T00:00:00Z' }] }],
      }) };
    },
  };
  const result = await registry.probe({ authIndex: 'ag-1', provider: 'antigravity', projectId: 'p1', metadata: {} }, client);
  assert.equal(Math.round(result.windows[0].usedPercent), 30);
  assert.equal(Math.round(result.windows[0].remainingPercent), 70);
});

test('xAI provider merges weekly and monthly billing evidence', async () => {
  const registry = new ProviderRegistry();
  const client = {
    async apiCall(_authIndex, request) {
      const weekly = request.url.includes('format=credits');
      return { statusCode: 200, headers: {}, body: JSON.stringify({
        config: {
          currentPeriod: { type: weekly ? 'weekly' : 'monthly', end: '2026-07-27T00:00:00Z' },
          creditUsagePercent: weekly ? 35 : 45,
          monthlyLimit: { val: 1000 },
          used: { val: 450 },
        },
      }) };
    },
  };
  const result = await registry.probe({ authIndex: 'xai-1', provider: 'xai', metadata: {} }, client);
  assert.equal(result.windows.length, 2);
  assert.deepEqual(result.windows.map((window) => window.usedPercent), [35, 45]);
});

test('unknown providers remain health-only instead of fabricating a balance', async () => {
  const registry = new ProviderRegistry();
  const result = await registry.probe({ authIndex: 'g-1', provider: 'gemini', metadata: {} }, {});
  assert.equal(result.supported, false);
  assert.equal(result.windows.length, 0);
  assert.match(result.summary.reason, /没有经文档确认/);
});

test('provider failures use explicit account evidence instead of treating every 403 as auth failure', async () => {
  const registry = new ProviderRegistry();
  const probe = async (response) => {
    const client = {
      async apiCall() {
        return { statusCode: response.statusCode, headers: {}, body: response.body || '' };
      },
    };
    await assert.rejects(
      () => registry.probe({ authIndex: 'codex-1', provider: 'codex', metadata: {} }, client),
      (error) => error instanceof ProbeError && error.classification === response.classification
    );
  };

  await probe({ statusCode: 401, classification: 'auth_invalid', body: '{"error":{"code":"account_deactivated"}}' });
  await probe({ statusCode: 403, classification: 'auth_invalid', body: '{"error":"unauthorized"}' });
  await probe({ statusCode: 403, classification: 'disabled', body: 'This service has been disabled in this account for violation of Terms of Service.' });
  await probe({ statusCode: 403, classification: 'unknown', body: '{"error":{"code":"payment_required"}}' });
  await probe({ statusCode: 403, classification: 'unknown', body: '{"error":{"type":"invalid_request_error","message":"request rejected"}}' });
  await probe({ statusCode: 429, classification: 'rate_limited', body: '{"error":{"type":"rate_limit"}}' });
  await probe({ statusCode: 502, classification: 'transient', body: '{"error":"context canceled"}' });
});
