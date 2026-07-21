import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { createApplication } from '../src/application.js';
import { fixtureFiles, mockApiCall, startMockCPA, waitFor } from './helpers.js';

test('public deployment mode protects dashboard APIs with an HttpOnly session', async (t) => {
  const mock = await startMockCPA({ files: fixtureFiles(), apiCall: mockApiCall });
  t.after(mock.close);
  const app = createApplication(loadConfig({
    host: '127.0.0.1',
    port: 0,
    databasePath: ':memory:',
    cpaManagementURL: mock.managementURL,
    adminPassword: 'correct horse battery staple',
    notifyChannels: [],
    accountSyncIntervalMs: 60_000,
    quotaSyncIntervalMs: 60_000,
  }), { logger: { log() {}, error() {} } });
  t.after(() => app.stop());
  const address = await app.start();
  const baseURL = `http://127.0.0.1:${address.port}`;

  const denied = await fetch(`${baseURL}/api/dashboard`);
  assert.equal(denied.status, 401);

  const login = await fetch(`${baseURL}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'correct horse battery staple' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);

  const allowed = await fetch(`${baseURL}/api/dashboard`, { headers: { Cookie: cookie } });
  assert.equal(allowed.status, 200);

  await waitFor(async () => {
    const response = await fetch(`${baseURL}/api/dashboard`, { headers: { Cookie: cookie } });
    const body = await response.json();
    return body.counts.total === 2;
  });
  const deleted = await fetch(`${baseURL}/api/accounts`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ authIndexes: ['gemini-1'] }),
  });
  assert.equal(deleted.status, 200);
  assert.equal((await deleted.json()).deleted, 1);
  const afterDelete = await fetch(`${baseURL}/api/dashboard`, { headers: { Cookie: cookie } });
  assert.equal((await afterDelete.json()).counts.total, 1);
  assert.equal(
    app.store.listEvents(20).filter((event) => ['account_removed', 'account_count_changed'].includes(event.type)).length,
    0
  );
});

test('batch abnormal deletion only targets documented file-backed invalid accounts', async (t) => {
  const files = fixtureFiles();
  files[0].status = 'error';
  files[0].status_message = 'token expired';
  files[1].runtime_only = true;
  files[1].source = 'memory';
  const mock = await startMockCPA({ files, apiCall: mockApiCall });
  t.after(mock.close);
  const app = createApplication(loadConfig({
    host: '127.0.0.1',
    port: 0,
    databasePath: ':memory:',
    cpaManagementURL: mock.managementURL,
    adminPassword: '',
    notifyChannels: [],
    accountSyncIntervalMs: 60_000,
    quotaSyncIntervalMs: 60_000,
  }), { logger: { log() {}, error() {} } });
  t.after(() => app.stop());
  const address = await app.start();
  const baseURL = `http://127.0.0.1:${address.port}`;
  await waitFor(async () => {
    const body = await fetch(`${baseURL}/api/dashboard`).then((response) => response.json());
    return body.counts.total === 2;
  });

  const response = await fetch(`${baseURL}/api/accounts/abnormal`, { method: 'DELETE' });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.deleted, 1);
  assert.equal(mock.files().length, 1);
  assert.equal(mock.files()[0].auth_index, 'gemini-1');

  const runtimeOnlyResponse = await fetch(`${baseURL}/api/accounts`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authIndexes: ['gemini-1'] }),
  });
  const runtimeOnlyResult = await runtimeOnlyResponse.json();
  assert.equal(runtimeOnlyResponse.status, 200);
  assert.equal(runtimeOnlyResult.deleted, 0);
  assert.equal(runtimeOnlyResult.skipped.length, 1);
  assert.match(runtimeOnlyResult.skipped[0].reason, /runtime_only/);
});
