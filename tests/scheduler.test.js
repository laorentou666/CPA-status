import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.js';
import { CPAClient } from '../src/cpa-client.js';
import { ProbeError, ProviderRegistry } from '../src/providers.js';
import { AlertEngine } from '../src/alerts.js';
import { MonitorScheduler } from '../src/scheduler.js';
import { fixtureFiles, mockApiCall, startMockCPA } from './helpers.js';

test('scheduler persists CPA accounts without any browser or SSE client', async (t) => {
  const mock = await startMockCPA({ files: fixtureFiles(), apiCall: mockApiCall });
  t.after(mock.close);
  const store = new Store(':memory:');
  t.after(() => store.close());
  const notifications = { async sendEvent() {} };
  const alerts = new AlertEngine(store, notifications);
  const hub = { broadcast() {} };
  const scheduler = new MonitorScheduler({
    config: {
      accountSyncIntervalMs: 30_000,
      quotaSyncIntervalMs: 600_000,
      quotaConcurrency: 2,
      quotaWarningPercent: 80,
      historyRetentionDays: 30,
    },
    store,
    cpaClient: new CPAClient({ managementURL: mock.managementURL }),
    providers: new ProviderRegistry(),
    alerts,
    hub,
    logger: { error() {} },
  });
  await scheduler.runAccountSync();
  await scheduler.runQuotaSync();
  const dashboard = store.getDashboard();
  assert.equal(dashboard.counts.total, 2);
  assert.equal(dashboard.connection.connected, true);
  const codex = dashboard.accounts.find((account) => account.provider === 'codex');
  assert.equal(codex.quotaWindows.length, 2);
  const gemini = dashboard.accounts.find((account) => account.provider === 'gemini');
  assert.equal(gemini.metadata.quotaCapability, 'health-only');
});

test('scheduler ignores transient quota probe failures but alerts on explicit auth failures', async (t) => {
  const mock = await startMockCPA({ files: fixtureFiles(), apiCall: mockApiCall });
  t.after(mock.close);
  const store = new Store(':memory:');
  t.after(() => store.close());
  const sent = [];
  const notifications = { async sendEvent(event) { sent.push(event); } };
  const alerts = new AlertEngine(store, notifications);
  const hub = { broadcast() {} };
  const providers = new ProviderRegistry();
  const scheduler = new MonitorScheduler({
    config: {
      accountSyncIntervalMs: 30_000,
      quotaSyncIntervalMs: 600_000,
      quotaConcurrency: 2,
      quotaWarningPercent: 80,
      historyRetentionDays: 30,
    },
    store,
    cpaClient: new CPAClient({ managementURL: mock.managementURL }),
    providers,
    alerts,
    hub,
    logger: { error() {} },
  });

  await scheduler.runAccountSync();
  await scheduler.runQuotaSync();
  sent.length = 0;
  providers.probe = async (account) => {
    if (account.provider !== 'codex') return { supported: false, ok: true, provider: account.provider, windows: [] };
    throw new ProbeError('CPA request failed: context canceled', {
      provider: 'codex',
      classification: 'transient',
    });
  };
  await scheduler.runQuotaSync();
  let account = store.getAccount('codex-1');
  assert.equal(account.effective_state, 'healthy');
  assert.equal(sent.length, 0);

  providers.probe = async (account) => {
    if (account.provider !== 'codex') return { supported: false, ok: true, provider: account.provider, windows: [] };
    throw new ProbeError('codex probe returned HTTP 401', {
      provider: 'codex',
      statusCode: 401,
      classification: 'auth_invalid',
    });
  };
  await scheduler.runQuotaSync();
  account = store.getAccount('codex-1');
  assert.equal(account.effective_state, 'auth_invalid');
  assert.equal(sent.filter((event) => event.type === 'account_state_changed').length, 1);
});
