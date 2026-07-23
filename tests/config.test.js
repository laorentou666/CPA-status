import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { ConfigManager, loadConfig } from '../src/config.js';

test('loadConfig groups numbered notification credentials by channel', () => {
  const config = loadConfig({}, {
    TELEGRAM_BOT_TOKEN: 'bot-one',
    TELEGRAM_CHAT_IDS: '1001,1002',
    TELEGRAM_BOT_TOKEN_2: 'bot-two',
    TELEGRAM_CHAT_IDS_2: '2001',
    PUSHPLUS_TOKEN: 'push-one',
    PUSHPLUS_TOPIC: 'ops',
    PUSHPLUS_TOKEN_2: 'push-two',
    PUSHPLUS_CHANNEL_2: 'webhook',
    SERVERCHAN_SENDKEY: 'SCTone',
    SERVERCHAN_SENDKEY_2: 'sctp123ttwo',
  });

  assert.deepEqual(config.telegram.targets, [
    { botToken: 'bot-one', chatIds: ['1001', '1002'] },
    { botToken: 'bot-two', chatIds: ['2001'] },
  ]);
  assert.deepEqual(config.pushplus.targets, [
    { token: 'push-one', topic: 'ops', channel: 'wechat' },
    { token: 'push-two', topic: '', channel: 'webhook' },
  ]);
  assert.deepEqual(config.serverchan.sendKeys, ['SCTone', 'sctp123ttwo']);
});

test('loadConfig reads public write protection limits', () => {
  const config = loadConfig({}, {
    APP_TRUST_PROXY: 'true',
    OAUTH_START_RATE_LIMIT: '4',
    OAUTH_RATE_LIMIT_WINDOW_SECONDS: '120',
    OAUTH_MAX_ACTIVE_FLOWS: '6',
    UPLOAD_RATE_LIMIT: '7',
    UPLOAD_MAX_FILE_BYTES: '2048',
    UPLOAD_MAX_FILES: '3',
  });

  assert.equal(config.trustProxy, true);
  assert.equal(config.oauthStartRateLimit, 4);
  assert.equal(config.oauthRateLimitWindowMs, 120_000);
  assert.equal(config.oauthMaxActiveFlows, 6);
  assert.equal(config.uploadRateLimit, 7);
  assert.equal(config.uploadMaxFileBytes, 2048);
  assert.equal(config.uploadMaxFiles, 3);
});

test('loadConfig accepts exact notification event selections and all/none aliases', () => {
  assert.deepEqual(
    loadConfig({}, { NOTIFY_EVENTS: 'account_auth_invalid,cpa_unreachable,unknown-key' }).notifyEvents,
    ['account_auth_invalid', 'cpa_unreachable']
  );
  assert.equal(loadConfig({}, { NOTIFY_EVENTS: 'all' }).notifyEvents.length, 18);
  assert.deepEqual(loadConfig({}, { NOTIFY_EVENTS: 'none' }).notifyEvents, []);
  assert.deepEqual(loadConfig({}, { NOTIFY_EVENTS: '' }).notifyEvents, []);
});

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
