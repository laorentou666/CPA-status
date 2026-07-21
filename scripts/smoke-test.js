import assert from 'node:assert/strict';
import http from 'node:http';
import { loadConfig } from '../src/config.js';
import { createApplication } from '../src/application.js';
import { fixtureFiles, mockApiCall, startMockCPA, waitFor } from '../tests/helpers.js';

async function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body || null;
    const req = http.request(url, {
      method: options.method || 'GET',
      headers: {
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(options.headers || {}),
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: response.statusCode,
          text,
          json: () => JSON.parse(text || '{}'),
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

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
    const health = (await request(`${baseURL}/api/health`)).json();
    return health.cpaConnected;
  });
  await waitFor(async () => {
    const data = (await request(`${baseURL}/api/dashboard`)).json();
    return data.accounts?.find((account) => account.provider === 'codex')?.quotaWindows?.length === 2;
  });

  const healthResponse = await request(`${baseURL}/api/health`);
  const health = healthResponse.json();
  assert.equal(healthResponse.status, 200);
  assert.equal(health.status, 'ok');

  const dashboardResponse = await request(`${baseURL}/api/dashboard`);
  const dashboard = dashboardResponse.json();
  assert.equal(dashboardResponse.status, 200);
  assert.equal(dashboard.counts.total, 2);
  assert.equal(dashboard.accounts.find((account) => account.provider === 'codex').quotaWindows.length, 2);

  const deleteResponse = await request(`${baseURL}/api/accounts`, {
    method: 'DELETE',
    body: JSON.stringify({ authIndexes: ['gemini-1'] }),
  });
  const deleteResult = deleteResponse.json();
  assert.equal(deleteResponse.status, 200);
  assert.equal(deleteResult.deleted, 1);
  const afterDelete = (await request(`${baseURL}/api/dashboard`)).json();
  assert.equal(afterDelete.counts.total, 1);

  const pageResponse = await request(`${baseURL}/`);
  const page = pageResponse.text;
  assert.equal(pageResponse.status, 200);
  assert.match(page, /CPA Status/);
  assert.match(page, /管理员入口/);
  assert.match(page, /账号状态/);

  const adminPageResponse = await request(`${baseURL}/admin`);
  assert.equal(adminPageResponse.status, 200);
  assert.match(adminPageResponse.text, /管理员登录/);

  const refreshResponse = await request(`${baseURL}/api/refresh`, {
    method: 'POST',
    body: JSON.stringify({ quota: false }),
  });
  assert.equal(refreshResponse.status, 202);

  console.log(`SMOKE PASS ${baseURL} accounts=${dashboard.counts.total}->${afterDelete.counts.total} codexWindows=2 deleted=1`);
} finally {
  await app.stop();
  await mock.close();
}
