import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigManager, loadConfig } from '../src/config.js';
import { createApplication } from '../src/application.js';
import { fixtureFiles, mockApiCall, startMockCPA, waitFor } from './helpers.js';

test('guest APIs stay readable while administrator mutations require an HttpOnly session', async (t) => {
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

  const guestDashboard = await fetch(`${baseURL}/api/dashboard`);
  assert.equal(guestDashboard.status, 200);
  const guestPage = await fetch(`${baseURL}/`);
  const adminPage = await fetch(`${baseURL}/admin`);
  assert.equal(guestPage.status, 200);
  assert.equal(adminPage.status, 200);

  const denied = await fetch(`${baseURL}/api/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quota: false }),
  });
  assert.equal(denied.status, 401);
  const deniedDelete = await fetch(`${baseURL}/api/accounts`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authIndexes: ['codex-1'] }),
  });
  assert.equal(deniedDelete.status, 401);

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

  const notificationTest = await fetch(`${baseURL}/api/notifications/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ channels: [] }),
  });
  assert.equal(notificationTest.status, 200);

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

test('.env reload updates live scheduling, notification and administrator settings', async (t) => {
  const mock = await startMockCPA({ files: fixtureFiles(), apiCall: mockApiCall });
  t.after(mock.close);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-status-server-config-'));
  const filePath = path.join(directory, '.env');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(filePath, [
    'APP_ADMIN_PASSWORD=old-password',
    'ACCOUNT_SYNC_INTERVAL_SECONDS=60',
    'QUOTA_SYNC_INTERVAL_SECONDS=600',
  ].join('\n'));
  const configManager = new ConfigManager({
    filePath,
    env: {},
    overrides: {
      host: '127.0.0.1',
      port: 0,
      databasePath: ':memory:',
      cpaManagementURL: mock.managementURL,
    },
    logger: { log() {}, error() {} },
    watchIntervalMs: 20,
  });
  const app = createApplication(configManager.current(), {
    configManager,
    logger: { log() {}, error() {}, warn() {} },
  });
  t.after(() => app.stop());
  const address = await app.start();
  const baseURL = `http://127.0.0.1:${address.port}`;

  const oldLogin = await fetch(`${baseURL}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'old-password' }),
  });
  const oldCookie = oldLogin.headers.get('set-cookie');
  assert.equal(oldLogin.status, 200);

  fs.writeFileSync(filePath, [
    'APP_ADMIN_PASSWORD=new-password',
    'ACCOUNT_SYNC_INTERVAL_SECONDS=5',
    'QUOTA_SYNC_INTERVAL_SECONDS=60',
    'CPA_MANAGEMENT_KEY=updated-key',
    'REQUEST_TIMEOUT_SECONDS=12',
    'NOTIFY_CHANNELS=serverchan',
    'SERVERCHAN_SENDKEY=SCTtest',
  ].join('\n'));
  assert.equal(configManager.reload(), true);

  const dashboard = await fetch(`${baseURL}/api/dashboard`).then((response) => response.json());
  assert.deepEqual(dashboard.schedule, { accountSyncSeconds: 5, quotaSyncSeconds: 60 });
  assert.equal(app.cpaClient.managementKey, 'updated-key');
  assert.equal(app.cpaClient.timeoutMs, 12_000);
  assert.deepEqual(
    dashboard.notificationChannels.find((channel) => channel.name === 'serverchan'),
    { name: 'serverchan', enabled: true, configured: true, targets: 1 }
  );

  const oldSessionMutation = await fetch(`${baseURL}/api/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: oldCookie },
    body: JSON.stringify({ quota: false }),
  });
  assert.equal(oldSessionMutation.status, 401);

  const newLogin = await fetch(`${baseURL}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'new-password' }),
  });
  assert.equal(newLogin.status, 200);
});
