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
});

test('CPA client rejects arbitrary api-call targets', async () => {
  const client = new CPAClient({ managementURL: 'http://127.0.0.1:1/v0/management' });
  await assert.rejects(
    () => client.apiCall('a', { url: 'https://example.com/private' }),
    (error) => error instanceof CPAError && /allowlisted/.test(error.message)
  );
});

