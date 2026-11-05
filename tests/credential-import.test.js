import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { CPAClient } from '../src/cpa-client.js';
import { CredentialImportError, CredentialImportService } from '../src/credential-import.js';
import { fixtureFiles, startMockCPA } from './helpers.js';

test('credential import keeps OAuth state private and blocks guest file replacement', async (t) => {
  const mock = await startMockCPA({ files: fixtureFiles() });
  t.after(mock.close);
  const scheduler = { refreshes: 0, async refreshAfterMutation() { this.refreshes += 1; } };
  const service = new CredentialImportService({
    config: loadConfig({
      cpaManagementURL: mock.managementURL,
      oauthStatusMinIntervalMs: 0,
    }),
    cpaClient: new CPAClient({ managementURL: mock.managementURL }),
    scheduler,
    logger: { error() {} },
  });

  const started = await service.startCodexOAuth('guest:127.0.0.1');
  assert.ok(started.flowId);
  assert.equal('state' in started, false);
  await assert.rejects(
    () => service.submitCodexCallback(
      'guest:127.0.0.1',
      started.flowId,
      'http://localhost:1455/auth/callback?code=test&state=wrong-state'
    ),
    (error) => error instanceof CredentialImportError && /不匹配/.test(error.message)
  );

  const state = new URL(started.url).searchParams.get('state');
  await service.submitCodexCallback(
    'guest:127.0.0.1',
    started.flowId,
    `http://localhost:1455/auth/callback?code=test&state=${state}`
  );
  assert.equal((await service.getCodexOAuthStatus('guest:127.0.0.1', started.flowId)).status, 'ok');
  assert.equal(scheduler.refreshes, 1);

  const result = await service.uploadAuthFiles([
    {
      name: 'codex-user.json',
      data: Buffer.from(JSON.stringify({ type: 'codex', email: 'replacement@example.com' })),
    },
  ]);
  assert.equal(result.uploaded, 0);
  assert.match(result.failed[0].error, /不能覆盖/);
  assert.equal(mock.uploads().length, 0);
});

test('credential import validates JSON before sending it to CPA', async () => {
  const service = new CredentialImportService({
    config: loadConfig(),
    cpaClient: {},
    scheduler: {},
  });
  await assert.rejects(
    () => service.uploadAuthFiles([{ name: 'broken.json', data: Buffer.from('{') }]),
    (error) => error instanceof CredentialImportError && /合法 JSON/.test(error.message)
  );
});

test('credential import reserves OAuth capacity while CPA start is pending', async () => {
  let releaseStart;
  const startPending = new Promise((resolve) => { releaseStart = resolve; });
  const service = new CredentialImportService({
    config: loadConfig({ oauthMaxActiveFlows: 1, oauthMaxActiveFlowsPerClient: 1 }),
    cpaClient: {
      async startCodexOAuth() {
        await startPending;
        return { url: 'https://example.com/oauth', state: 'state' };
      },
    },
    scheduler: {},
  });

  const first = service.startCodexOAuth('first-client');
  await assert.rejects(
    () => service.startCodexOAuth('second-client'),
    (error) => error instanceof CredentialImportError && error.statusCode === 429
  );
  releaseStart();
  await first;
});

test('credential import supports Antigravity OAuth with the same protected flow lifecycle', async (t) => {
  const mock = await startMockCPA({ files: fixtureFiles() });
  t.after(mock.close);
  const scheduler = { refreshes: 0, async refreshAfterMutation() { this.refreshes += 1; } };
  const service = new CredentialImportService({
    config: loadConfig({
      cpaManagementURL: mock.managementURL,
      oauthStatusMinIntervalMs: 0,
    }),
    cpaClient: new CPAClient({ managementURL: mock.managementURL }),
    scheduler,
    logger: { error() {} },
  });

  const started = await service.startAntigravityOAuth('guest:127.0.0.1');
  const state = new URL(started.url).searchParams.get('state');
  await service.submitAntigravityCallback(
    'guest:127.0.0.1',
    started.flowId,
    `http://localhost:51121/oauth-callback?code=test&state=${state}`
  );
  assert.equal((await service.getAntigravityOAuthStatus('guest:127.0.0.1', started.flowId)).status, 'ok');
  assert.equal(scheduler.refreshes, 1);
});
