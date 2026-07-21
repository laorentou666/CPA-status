import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { parseEnv } from 'node:util';

const restartRequiredKeys = new Set(['host', 'port', 'databasePath']);

function integer(env, name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const value = Number.parseInt(env[name] ?? '', 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function number(env, name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const value = Number(env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function list(env, name) {
  return String(env[name] ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function indexedValues(env, baseName) {
  const values = [];
  if (String(env[baseName] || '').trim()) {
    values.push({ index: 0, name: baseName, value: String(env[baseName]).trim() });
  }
  const pattern = new RegExp(`^${baseName}_([1-9]\\d*)$`);
  for (const [name, rawValue] of Object.entries(env)) {
    const match = name.match(pattern);
    const value = String(rawValue || '').trim();
    if (!match || !value) continue;
    values.push({ index: Number(match[1]), name, value });
  }
  return values.sort((left, right) => left.index - right.index);
}

function indexedName(baseName, index) {
  return index === 0 ? baseName : `${baseName}_${index}`;
}

function telegramConfig(env) {
  const targets = indexedValues(env, 'TELEGRAM_BOT_TOKEN').map(({ index, value }) => ({
    botToken: value,
    chatIds: list(env, indexedName('TELEGRAM_CHAT_IDS', index)),
  }));
  return {
    botToken: targets[0]?.botToken || '',
    chatIds: targets[0]?.chatIds || [],
    targets,
  };
}

function pushPlusConfig(env) {
  const targets = indexedValues(env, 'PUSHPLUS_TOKEN').map(({ index, value }) => ({
    token: value,
    topic: env[indexedName('PUSHPLUS_TOPIC', index)] || '',
    channel: env[indexedName('PUSHPLUS_CHANNEL', index)] || env.PUSHPLUS_CHANNEL || 'wechat',
  }));
  return {
    token: targets[0]?.token || '',
    topic: targets[0]?.topic || '',
    channel: targets[0]?.channel || env.PUSHPLUS_CHANNEL || 'wechat',
    targets,
  };
}

function serverChanConfig(env) {
  const sendKeys = indexedValues(env, 'SERVERCHAN_SENDKEY').map(({ value }) => value);
  return {
    sendKey: sendKeys[0] || '',
    sendKeys,
  };
}

function normalizeManagementURL(value) {
  const raw = String(value || 'http://127.0.0.1:8317/v0/management').trim();
  const url = new URL(raw);
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (!url.pathname.endsWith('/v0/management')) {
    url.pathname = `${url.pathname}/v0/management`.replace(/\/{2,}/g, '/');
  }
  return url.toString().replace(/\/$/, '');
}

function configsEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function loadConfig(overrides = {}, env = process.env) {
  const cwd = process.cwd();
  const config = {
    host: env.HOST || '0.0.0.0',
    port: integer(env, 'PORT', 8080, 0, 65535),
    databasePath: env.DATABASE_PATH || path.join(cwd, 'data', 'cpa-status.db'),
    cpaManagementURL: normalizeManagementURL(env.CPA_MANAGEMENT_URL || env.CPA_BASE_URL),
    cpaManagementKey: env.CPA_MANAGEMENT_KEY || '',
    accountSyncIntervalMs: integer(env, 'ACCOUNT_SYNC_INTERVAL_SECONDS', 30, 5) * 1000,
    quotaSyncIntervalMs: integer(env, 'QUOTA_SYNC_INTERVAL_SECONDS', 600, 60) * 1000,
    quotaConcurrency: integer(env, 'QUOTA_CONCURRENCY', 3, 1, 20),
    quotaWarningPercent: number(env, 'QUOTA_WARNING_PERCENT', 80, 1, 100),
    requestTimeoutMs: integer(env, 'REQUEST_TIMEOUT_SECONDS', 45, 5, 180) * 1000,
    historyRetentionDays: integer(env, 'HISTORY_RETENTION_DAYS', 30, 1, 3650),
    adminPassword: env.APP_ADMIN_PASSWORD || '',
    sessionTtlMs: integer(env, 'SESSION_TTL_HOURS', 24, 1, 720) * 60 * 60 * 1000,
    notifyChannels: list(env, 'NOTIFY_CHANNELS').map((item) => item.toLowerCase()),
    notifyMinSeverity: (env.NOTIFY_MIN_SEVERITY || 'warning').toLowerCase(),
    telegram: telegramConfig(env),
    pushplus: pushPlusConfig(env),
    serverchan: serverChanConfig(env),
  };
  return { ...config, ...overrides };
}

export class ConfigManager extends EventEmitter {
  constructor({
    filePath = process.env.CONFIG_FILE || path.join(process.cwd(), '.env'),
    env = process.env,
    overrides = {},
    logger = console,
    watchIntervalMs = 1000,
  } = {}) {
    super();
    this.filePath = path.resolve(filePath);
    this.environment = { ...env };
    this.overrides = overrides;
    this.logger = logger;
    this.watchIntervalMs = watchIntervalMs;
    this.watching = false;
    this.watchListener = () => this.reload();
    this.config = this.read();
  }

  readFileEnvironment() {
    if (!fs.existsSync(this.filePath)) return {};
    if (!fs.statSync(this.filePath).isFile()) {
      throw new Error(`Config path is not a regular file: ${this.filePath}`);
    }
    return parseEnv(fs.readFileSync(this.filePath, 'utf8'));
  }

  read() {
    const fileEnvironment = this.readFileEnvironment();
    return loadConfig(this.overrides, { ...fileEnvironment, ...this.environment });
  }

  current() {
    return this.config;
  }

  reload() {
    let next;
    try {
      next = this.read();
    } catch (error) {
      this.logger.error(`[config] could not reload ${this.filePath}: ${error.message}`);
      this.emit('reload:error', error);
      return false;
    }

    const previous = structuredClone(this.config);
    const restartRequired = [];
    for (const key of restartRequiredKeys) {
      if (!configsEqual(previous[key], next[key])) {
        restartRequired.push(key);
        next[key] = previous[key];
      }
    }

    const changedKeys = Object.keys(next).filter(
      (key) => !configsEqual(previous[key], next[key])
    );
    if (!changedKeys.length && !restartRequired.length) return false;

    for (const key of Object.keys(this.config)) delete this.config[key];
    Object.assign(this.config, next);
    if (changedKeys.length) {
      this.logger.log(`[config] reloaded ${this.filePath}: ${changedKeys.join(', ')}`);
    }
    this.emit('change', {
      config: this.config,
      previous,
      changedKeys,
      restartRequired,
    });
    return true;
  }

  startWatching() {
    if (this.watching) return;
    this.watching = true;
    fs.watchFile(this.filePath, { interval: this.watchIntervalMs }, this.watchListener);
    this.logger.log(`[config] watching ${this.filePath}`);
  }

  stopWatching() {
    if (!this.watching) return;
    fs.unwatchFile(this.filePath, this.watchListener);
    this.watching = false;
  }
}

export { normalizeManagementURL, restartRequiredKeys };
