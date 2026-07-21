import path from 'node:path';

function integer(name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function number(name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function list(name) {
  return String(process.env[name] ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
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

export function loadConfig(overrides = {}) {
  const cwd = process.cwd();
  const config = {
    host: process.env.HOST || '0.0.0.0',
    port: integer('PORT', 8080, 0, 65535),
    databasePath: process.env.DATABASE_PATH || path.join(cwd, 'data', 'cpa-status.db'),
    cpaManagementURL: normalizeManagementURL(
      process.env.CPA_MANAGEMENT_URL || process.env.CPA_BASE_URL
    ),
    cpaManagementKey: process.env.CPA_MANAGEMENT_KEY || '',
    accountSyncIntervalMs: integer('ACCOUNT_SYNC_INTERVAL_SECONDS', 30, 5) * 1000,
    quotaSyncIntervalMs: integer('QUOTA_SYNC_INTERVAL_SECONDS', 600, 60) * 1000,
    quotaConcurrency: integer('QUOTA_CONCURRENCY', 3, 1, 20),
    quotaWarningPercent: number('QUOTA_WARNING_PERCENT', 80, 1, 100),
    requestTimeoutMs: integer('REQUEST_TIMEOUT_SECONDS', 45, 5, 180) * 1000,
    historyRetentionDays: integer('HISTORY_RETENTION_DAYS', 30, 1, 3650),
    adminPassword: process.env.APP_ADMIN_PASSWORD || '',
    sessionTtlMs: integer('SESSION_TTL_HOURS', 24, 1, 720) * 60 * 60 * 1000,
    notifyChannels: list('NOTIFY_CHANNELS'),
    notifyMinSeverity: (process.env.NOTIFY_MIN_SEVERITY || 'warning').toLowerCase(),
    telegram: {
      botToken: process.env.TELEGRAM_BOT_TOKEN || '',
      chatIds: list('TELEGRAM_CHAT_IDS'),
    },
    pushplus: {
      token: process.env.PUSHPLUS_TOKEN || '',
      topic: process.env.PUSHPLUS_TOPIC || '',
      channel: process.env.PUSHPLUS_CHANNEL || 'wechat',
    },
  };
  return { ...config, ...overrides };
}

