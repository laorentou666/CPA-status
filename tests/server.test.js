import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { createApplication } from '../src/application.js';
import { fixtureFiles, mockApiCall, startMockCPA } from './helpers.js';

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
});
