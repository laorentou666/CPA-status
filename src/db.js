import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { nowISO, safeJSONParse } from './utils.js';

const migrations = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS accounts (
  auth_index TEXT PRIMARY KEY,
  id TEXT,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  label TEXT,
  email TEXT,
  account_type TEXT,
  account_name TEXT,
  project_id TEXT,
  plan_type TEXT,
  cpa_status TEXT,
  status_message TEXT,
  disabled INTEGER NOT NULL DEFAULT 0,
  unavailable INTEGER NOT NULL DEFAULT 0,
  runtime_only INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  recent_requests_json TEXT NOT NULL DEFAULT '[]',
  base_state TEXT NOT NULL DEFAULT 'unknown',
  quota_state TEXT NOT NULL DEFAULT 'unknown',
  effective_state TEXT NOT NULL DEFAULT 'unknown',
  quota_summary_json TEXT NOT NULL DEFAULT '{}',
  quota_checked_at TEXT,
  quota_error TEXT,
  consecutive_probe_failures INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  current INTEGER NOT NULL DEFAULT 1,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_accounts_provider ON accounts(provider);
CREATE INDEX IF NOT EXISTS idx_accounts_state ON accounts(effective_state);

CREATE TABLE IF NOT EXISTS quota_windows (
  auth_index TEXT NOT NULL,
  window_id TEXT NOT NULL,
  label TEXT NOT NULL,
  used_percent REAL,
  remaining_percent REAL,
  reset_at TEXT,
  source TEXT,
  checked_at TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (auth_index, window_id),
  FOREIGN KEY (auth_index) REFERENCES accounts(auth_index) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS quota_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  auth_index TEXT NOT NULL,
  window_id TEXT NOT NULL,
  used_percent REAL,
  remaining_percent REAL,
  reset_at TEXT,
  checked_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_quota_history_account ON quota_history(auth_index, checked_at);

CREATE TABLE IF NOT EXISTS account_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  auth_index TEXT NOT NULL,
  previous_state TEXT,
  state TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  account_count INTEGER,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  auth_index TEXT,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER,
  channel TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS system_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

function bool(value) {
  return value ? 1 : 0;
}

function decodeAccount(row) {
  if (!row) return null;
  return {
    ...row,
    disabled: Boolean(row.disabled),
    unavailable: Boolean(row.unavailable),
    runtimeOnly: Boolean(row.runtime_only),
    current: Boolean(row.current),
    recentRequests: safeJSONParse(row.recent_requests_json, []),
    quotaSummary: safeJSONParse(row.quota_summary_json, {}),
    metadata: safeJSONParse(row.metadata_json, {}),
  };
}

export class Store {
  constructor(databasePath) {
    if (databasePath !== ':memory:') {
      const directory = path.dirname(path.resolve(databasePath));
      try {
        fs.mkdirSync(directory, { recursive: true });
        fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK);
        if (fs.existsSync(databasePath)) {
          fs.accessSync(databasePath, fs.constants.R_OK | fs.constants.W_OK);
        }
      } catch (error) {
        const uid = typeof process.getuid === 'function' ? process.getuid() : 'unknown';
        throw new Error(
          `Database path is not writable: ${databasePath} (directory: ${directory}, uid: ${uid}). ` +
          'Fix the mounted volume ownership or use the named volume from docker-compose.yml.',
          { cause: error }
        );
      }
    }
    try {
      this.db = new DatabaseSync(databasePath);
    } catch (error) {
      throw new Error(`Unable to open SQLite database at ${databasePath}: ${error.message}`, {
        cause: error,
      });
    }
    this.db.exec(migrations);
  }

  close() {
    this.db.close();
  }

  transaction(callback) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getState(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM system_state WHERE key = ?').get(key);
    return row ? safeJSONParse(row.value, row.value) : fallback;
  }

  setState(key, value) {
    this.db.prepare(`
      INSERT INTO system_state(key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, JSON.stringify(value), nowISO());
  }

  startRun(kind) {
    const result = this.db
      .prepare('INSERT INTO sync_runs(kind, status, started_at) VALUES (?, ?, ?)')
      .run(kind, 'running', nowISO());
    return Number(result.lastInsertRowid);
  }

  finishRun(id, status, accountCount = null, error = null) {
    this.db
      .prepare('UPDATE sync_runs SET status = ?, account_count = ?, error = ?, finished_at = ? WHERE id = ?')
      .run(status, accountCount, error, nowISO(), id);
  }

  getAccount(authIndex) {
    return decodeAccount(this.db.prepare('SELECT * FROM accounts WHERE auth_index = ?').get(authIndex));
  }

  upsertAccount(account) {
    const previous = this.getAccount(account.authIndex);
    const firstSeen = previous?.first_seen_at || account.seenAt;
    this.db.prepare(`
      INSERT INTO accounts (
        auth_index, id, name, provider, label, email, account_type, account_name, project_id,
        plan_type, cpa_status, status_message, disabled, unavailable, runtime_only,
        success_count, failed_count, recent_requests_json, base_state, quota_state,
        effective_state, first_seen_at, last_seen_at, current, metadata_json, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?
      )
      ON CONFLICT(auth_index) DO UPDATE SET
        id = excluded.id, name = excluded.name, provider = excluded.provider,
        label = excluded.label, email = excluded.email, account_type = excluded.account_type,
        account_name = excluded.account_name, project_id = excluded.project_id,
        plan_type = COALESCE(excluded.plan_type, accounts.plan_type),
        cpa_status = excluded.cpa_status, status_message = excluded.status_message,
        disabled = excluded.disabled, unavailable = excluded.unavailable,
        runtime_only = excluded.runtime_only, success_count = excluded.success_count,
        failed_count = excluded.failed_count, recent_requests_json = excluded.recent_requests_json,
        base_state = excluded.base_state, quota_state = excluded.quota_state,
        effective_state = excluded.effective_state, last_seen_at = excluded.last_seen_at,
        current = 1, metadata_json = excluded.metadata_json, updated_at = excluded.updated_at
    `).run(
      account.authIndex,
      account.id,
      account.name,
      account.provider,
      account.label,
      account.email,
      account.accountType,
      account.accountName,
      account.projectId,
      account.planType,
      account.cpaStatus,
      account.statusMessage,
      bool(account.disabled),
      bool(account.unavailable),
      bool(account.runtimeOnly),
      account.successCount,
      account.failedCount,
      JSON.stringify(account.recentRequests || []),
      account.baseState,
      account.quotaState,
      account.effectiveState,
      firstSeen,
      account.seenAt,
      JSON.stringify(account.metadata || {}),
      account.seenAt
    );
    return previous;
  }

  markMissing(seenAuthIndexes, at) {
    const rows = this.db.prepare('SELECT * FROM accounts WHERE current = 1').all();
    const missing = [];
    const update = this.db.prepare(`
      UPDATE accounts SET current = 0, base_state = 'missing', effective_state = 'missing', updated_at = ?
      WHERE auth_index = ?
    `);
    for (const row of rows) {
      if (!seenAuthIndexes.has(row.auth_index)) {
        missing.push(decodeAccount(row));
        update.run(at, row.auth_index);
      }
    }
    return missing;
  }

  updateQuota(authIndex, result, quotaState, effectiveState, checkedAt) {
    const previous = this.getAccount(authIndex);
    this.transaction(() => {
      this.db.prepare('DELETE FROM quota_windows WHERE auth_index = ?').run(authIndex);
      const insertWindow = this.db.prepare(`
        INSERT INTO quota_windows(
          auth_index, window_id, label, used_percent, remaining_percent, reset_at,
          source, checked_at, details_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertHistory = this.db.prepare(`
        INSERT INTO quota_history(auth_index, window_id, used_percent, remaining_percent, reset_at, checked_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const window of result.windows || []) {
        insertWindow.run(
          authIndex,
          window.id,
          window.label,
          window.usedPercent,
          window.remainingPercent,
          window.resetAt,
          window.source || result.provider,
          checkedAt,
          JSON.stringify(window.details || {})
        );
        insertHistory.run(
          authIndex,
          window.id,
          window.usedPercent,
          window.remainingPercent,
          window.resetAt,
          checkedAt
        );
      }
      this.db.prepare(`
        UPDATE accounts SET quota_state = ?, effective_state = ?, quota_summary_json = ?,
          quota_checked_at = ?, quota_error = NULL, consecutive_probe_failures = 0,
          plan_type = COALESCE(?, plan_type), updated_at = ?
        WHERE auth_index = ?
      `).run(
        quotaState,
        effectiveState,
        JSON.stringify(result.summary || {}),
        checkedAt,
        result.planType || null,
        checkedAt,
        authIndex
      );
    });
    return previous;
  }

  updateQuotaObservation(authIndex, result, checkedAt) {
    this.db.prepare(`
      UPDATE accounts SET quota_summary_json = ?, quota_checked_at = ?, quota_error = NULL,
        consecutive_probe_failures = 0, plan_type = COALESCE(?, plan_type), updated_at = ?
      WHERE auth_index = ?
    `).run(
      JSON.stringify(result?.summary || {}),
      checkedAt,
      result?.planType || null,
      checkedAt,
      authIndex
    );
  }

  updateQuotaTransientError(authIndex, error, checkedAt) {
    const previous = this.getAccount(authIndex);
    this.db.prepare(`
      UPDATE accounts SET quota_checked_at = ?, quota_error = ?,
        consecutive_probe_failures = consecutive_probe_failures + 1, updated_at = ?
      WHERE auth_index = ?
    `).run(checkedAt, error, checkedAt, authIndex);
    return previous;
  }

  updateQuotaError(authIndex, error, quotaState, effectiveState, checkedAt) {
    const previous = this.getAccount(authIndex);
    this.db.prepare(`
      UPDATE accounts SET quota_state = ?, effective_state = ?, quota_checked_at = ?,
        quota_error = ?, consecutive_probe_failures = consecutive_probe_failures + 1,
        updated_at = ? WHERE auth_index = ?
    `).run(quotaState, effectiveState, checkedAt, error, checkedAt, authIndex);
    return previous;
  }

  recordStateChange(authIndex, previousState, state, reason) {
    this.db.prepare(`
      INSERT INTO account_history(auth_index, previous_state, state, reason, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(authIndex, previousState, state, reason, nowISO());
  }

  insertEvent(event) {
    const result = this.db.prepare(`
      INSERT INTO events(type, severity, auth_index, title, message, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.type,
      'event',
      event.authIndex || null,
      event.title,
      event.message,
      JSON.stringify(event.payload || {}),
      event.createdAt || nowISO()
    );
    return { ...event, id: Number(result.lastInsertRowid) };
  }

  recordDelivery(eventId, channel, status, error = null) {
    this.db.prepare(`
      INSERT INTO notification_deliveries(event_id, channel, status, error, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(eventId || null, channel, status, error, nowISO());
  }

  listEvents(limit = 100) {
    return this.db
      .prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?')
      .all(Math.min(500, Math.max(1, limit)))
      .map((row) => {
        const event = { ...row };
        delete event.severity;
        return { ...event, payload: safeJSONParse(row.payload_json, {}) };
      });
  }

  listAccounts() {
    const accounts = this.db
      .prepare('SELECT * FROM accounts WHERE current = 1 ORDER BY provider, name COLLATE NOCASE')
      .all()
      .map(decodeAccount);
    const windows = this.db
      .prepare('SELECT * FROM quota_windows ORDER BY auth_index, window_id')
      .all();
    const grouped = new Map();
    for (const window of windows) {
      const list = grouped.get(window.auth_index) || [];
      list.push({
        id: window.window_id,
        label: window.label,
        usedPercent: window.used_percent,
        remainingPercent: window.remaining_percent,
        resetAt: window.reset_at,
        source: window.source,
        checkedAt: window.checked_at,
        details: safeJSONParse(window.details_json, {}),
      });
      grouped.set(window.auth_index, list);
    }
    return accounts.map((account) => ({ ...account, quotaWindows: grouped.get(account.auth_index) || [] }));
  }

  getDashboard() {
    const accounts = this.listAccounts();
    const counts = { total: accounts.length, healthy: 0, warning: 0, exhausted: 0, unavailable: 0 };
    const providers = {};
    for (const account of accounts) {
      if (account.effective_state === 'healthy') counts.healthy += 1;
      else if (account.effective_state === 'warning') counts.warning += 1;
      else if (account.effective_state === 'quota_exhausted') counts.exhausted += 1;
      else counts.unavailable += 1;
      providers[account.provider] ||= { total: 0, healthy: 0, warning: 0, unavailable: 0 };
      providers[account.provider].total += 1;
      if (account.effective_state === 'healthy') providers[account.provider].healthy += 1;
      else if (account.effective_state === 'warning') providers[account.provider].warning += 1;
      else providers[account.provider].unavailable += 1;
    }
    return {
      generatedAt: nowISO(),
      counts,
      providers,
      connection: this.getState('cpa_connection', { connected: false, checkedAt: null }),
      lastAccountSync: this.getState('last_account_sync', null),
      lastQuotaSync: this.getState('last_quota_sync', null),
      accounts,
      events: this.listEvents(60),
    };
  }

  prune(retentionDays) {
    const cutoff = new Date(Date.now() - retentionDays * 86400_000).toISOString();
    this.db.prepare('DELETE FROM quota_history WHERE checked_at < ?').run(cutoff);
    this.db.prepare('DELETE FROM account_history WHERE created_at < ?').run(cutoff);
    this.db.prepare('DELETE FROM sync_runs WHERE started_at < ?').run(cutoff);
  }
}
