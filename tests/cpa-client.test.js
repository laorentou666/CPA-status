import test from 'node:test';
import assert from 'node:assert/strict';
import { CPAClient, CPAError } from '../src/cpa-client.js';
import { fixtureFiles, mockApiCall, startMockCPA } from './helpers.js';

test('CPA client reads v7.2.29 auth file shape and proxies an allowlisted call', async (t) => {
  const mock = await startMockCPA({ files: fixtureFiles(), apiCall: mockApiCall });
  t.after(mock.close);
  const client = new CPAClient({ managementURL: mock.managementURL, managementKey: 'secret' });
  const files = await client.listAuthFiles();
  assert.equal(files.length, 2);
  assert.equal(files[0].auth_index, 'codex-1');
  const response = await client.apiCall('codex-1', {
    url: 'https://chatgpt.com/backend-api/wham/usage',
    header: { Authorization: 'Bearer $TOKEN$' },
  });
  assert.equal(response.statusCode, 200);

  const deleted = await client.deleteAuthFiles(['gemini-user.json']);
  assert.equal(deleted.deleted, 1);
  assert.deepEqual(deleted.files, ['gemini-user.json']);
  assert.equal((await client.listAuthFiles()).length, 1);

  const uploaded = await client.uploadAuthFile(
    'manual-codex.json',
    Buffer.from(JSON.stringify({ type: 'codex', email: 'manual@example.com' }))
  );
  assert.equal(uploaded.uploaded, 1);
  assert.equal(mock.uploads()[0].authorization, 'Bearer secret');

  const oauth = await client.startCodexOAuth();
  assert.match(oauth.url, /^https:\/\/auth\.example\.test/);
  assert.match(oauth.state, /^codex-state-/);
  assert.equal((await client.getOAuthStatus(oauth.state)).status, 'wait');
  await client.submitOAuthCallback({
    provider: 'codex',
    state: oauth.state,
    redirectURL: `http://localhost:1455/auth/callback?code=test-code&state=${oauth.state}`,
  });
  assert.equal((await client.getOAuthStatus(oauth.state)).status, 'ok');

  const antigravity = await client.startAntigravityOAuth();
  assert.match(antigravity.url, /^https:\/\/auth\.example\.test\/antigravity/);
  await client.submitOAuthCallback({
    provider: 'antigravity',
    state: antigravity.state,
    redirectURL: `http://localhost:51121/oauth-callback?code=test-code&state=${antigravity.state}`,
  });
  assert.equal((await client.getOAuthStatus(antigravity.state)).status, 'ok');
});

test('CPA client rejects arbitrary api-call targets', async () => {
  const client = new CPAClient({ managementURL: 'http://127.0.0.1:1/v0/management' });
  await assert.rejects(
    () => client.apiCall('a', { url: 'https://example.com/private' }),
    (error) => error instanceof CPAError && /allowlisted/.test(error.message)
  );
});
