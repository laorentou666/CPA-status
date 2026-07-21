import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { createApplication } from '../src/application.js';
import { fixtureFiles, mockApiCall, startMockCPA, waitFor } from '../tests/helpers.js';

const mock = await startMockCPA({ files: fixtureFiles(), apiCall: mockApiCall });
const config = loadConfig({
  host: '127.0.0.1',
  port: 0,
  databasePath: ':memory:',
  cpaManagementURL: mock.managementURL,
  cpaManagementKey: 'test-key',
  accountSyncIntervalMs: 60_000,
  quotaSyncIntervalMs: 60_000,
  quotaConcurrency: 2,
  requestTimeoutMs: 5_000,
  adminPassword: '',
  notifyChannels: [],
});
const logger = { log() {}, error() {} };
const app = createApplication(config, { logger });

try {
  const address = await app.start();
  const baseURL = `http://127.0.0.1:${address.port}`;
  await waitFor(async () => {
    const health = await fetch(`${baseURL}/api/health`).then((response) => response.json());
    return health.cpaConnected;
  });
  await waitFor(async () => {
    const data = await fetch(`${baseURL}/api/dashboard`).then((response) => response.json());
    return data.accounts?.find((account) => account.provider === 'codex')?.quotaWindows?.length === 2;
  });

  const healthResponse = await fetch(`${baseURL}/api/health`);
  const health = await healthResponse.json();
  assert.equal(healthResponse.status, 200);
  assert.equal(health.status, 'ok');

  const dashboardResponse = await fetch(`${baseURL}/api/dashboard`);
  const dashboard = await dashboardResponse.json();
  assert.equal(dashboardResponse.status, 200);
  assert.equal(dashboard.counts.total, 2);
  assert.equal(dashboard.accounts.find((account) => account.provider === 'codex').quotaWindows.length, 2);

  const pageResponse = await fetch(`${baseURL}/`);
  const page = await pageResponse.text();
  assert.equal(pageResponse.status, 200);
  assert.match(page, /CPA Status/);

  const refreshResponse = await fetch(`${baseURL}/api/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quota: false }),
  });
  assert.equal(refreshResponse.status, 202);

  console.log(`SMOKE PASS ${baseURL} accounts=${dashboard.counts.total} codexWindows=2`);
} finally {
  await app.stop();
  await mock.close();
}
