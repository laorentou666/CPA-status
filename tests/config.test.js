import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { ConfigManager } from '../src/config.js';

test('ConfigManager watches .env changes and preserves startup-only settings', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-status-config-'));
  const filePath = path.join(directory, '.env');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(filePath, [
    'PORT=8080',
    'ACCOUNT_SYNC_INTERVAL_SECONDS=30',
    'SERVERCHAN_SENDKEY=SCTinitial',
  ].join('\n'));

  const logs = [];
  const manager = new ConfigManager({
    filePath,
    env: {},
    watchIntervalMs: 20,
    logger: {
      log(message) { logs.push(message); },
      error(message) { logs.push(message); },
    },
  });
  t.after(() => manager.stopWatching());
  const config = manager.current();
  assert.equal(config.port, 8080);
  assert.equal(config.accountSyncIntervalMs, 30_000);
  assert.equal(config.serverchan.sendKey, 'SCTinitial');

  manager.startWatching();
  const changed = once(manager, 'change');
  fs.writeFileSync(filePath, [
    'PORT=9090',
    'ACCOUNT_SYNC_INTERVAL_SECONDS=7',
    'SERVERCHAN_SENDKEY=SCTupdated',
  ].join('\n'));
  const [event] = await changed;

  assert.equal(manager.current(), config);
  assert.equal(config.port, 8080);
  assert.equal(config.accountSyncIntervalMs, 7_000);
  assert.equal(config.serverchan.sendKey, 'SCTupdated');
  assert.deepEqual(event.restartRequired, ['port']);
  assert.ok(event.changedKeys.includes('accountSyncIntervalMs'));
  assert.ok(logs.some((line) => line.includes('watching')));
});

test('ConfigManager keeps the last valid configuration after an invalid edit', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-status-config-'));
  const filePath = path.join(directory, '.env');
  try {
    fs.writeFileSync(filePath, 'CPA_MANAGEMENT_URL=https://cpa.example.com\n');
    const errors = [];
    const manager = new ConfigManager({
      filePath,
      env: {},
      logger: { log() {}, error(message) { errors.push(message); } },
    });
    const previous = manager.current().cpaManagementURL;
    fs.writeFileSync(filePath, 'CPA_MANAGEMENT_URL=not a url\n');
    assert.equal(manager.reload(), false);
    assert.equal(manager.current().cpaManagementURL, previous);
    assert.equal(errors.length, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
