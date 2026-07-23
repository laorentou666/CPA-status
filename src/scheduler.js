import { sha256, mapConcurrent, nowISO, truncate } from './utils.js';
import { combineStates, evaluateBaseState, evaluateQuotaState } from './status.js';
import { ProbeError } from './providers.js';

function normalizeAuthFile(raw, registry, previous, seenAt) {
  const provider = registry.normalize(raw.provider || raw.type || 'unknown');
  const name = String(raw.name || raw.id || `${provider}-account`);
  const authIndex = String(
    raw.auth_index || raw.authIndex || raw.id || `legacy-${sha256(`${provider}:${name}`).slice(0, 16)}`
  );
  const idToken = raw.id_token && typeof raw.id_token === 'object' ? raw.id_token : {};
  const account = {
    authIndex,
    id: raw.id || name,
    name,
    provider,
    label: raw.label || raw.note || '',
    email: raw.email || '',
    accountType: raw.account_type || '',
    accountName: raw.account || '',
    projectId: raw.project_id || '',
    planType: idToken.plan_type || previous?.plan_type || '',
    cpaStatus: raw.status || 'unknown',
    statusMessage: raw.status_message || '',
    disabled: Boolean(raw.disabled),
    unavailable: Boolean(raw.unavailable),
    runtimeOnly: Boolean(raw.runtime_only),
    successCount: Number(raw.success || 0),
    failedCount: Number(raw.failed || 0),
    recentRequests: Array.isArray(raw.recent_requests) ? raw.recent_requests : [],
    quotaState: previous?.quota_state || 'unknown',
    seenAt,
    metadata: {
      source: raw.source || 'unknown',
      priority: raw.priority ?? null,
      nextRetryAfter: raw.next_retry_after || null,
      lastRefresh: raw.last_refresh || null,
      idToken,
      quotaCapability: registry.capability(provider),
    },
  };
  account.baseState = evaluateBaseState(account, previous?.base_state || previous?.baseState || null);
  account.effectiveState = combineStates(account.baseState, account.quotaState);
  return account;
}

export class MonitorScheduler {
  constructor({ config, store, cpaClient, providers, alerts, hub, logger = console }) {
    this.config = config;
    this.store = store;
    this.cpaClient = cpaClient;
    this.providers = providers;
    this.alerts = alerts;
    this.hub = hub;
    this.logger = logger;
    this.accountSyncRunning = false;
    this.quotaSyncRunning = false;
    this.expectedRemovedAuthIndexes = new Set();
    this.startupTimer = null;
    this.intervalTimers = [];
    this.stopped = true;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.scheduleTimers(true);
  }

  scheduleTimers(runStartup = false) {
    if (runStartup) {
      this.startupTimer = setTimeout(async () => {
        try {
          await this.runAccountSync();
          await this.runQuotaSync();
        } catch (error) {
          this.logger.error('[scheduler] startup check failed:', error.message);
        }
      }, 10);
    }
    this.intervalTimers.push(setInterval(() => this.runAccountSync().catch((error) => {
      this.logger.error('[scheduler] account sync failed:', error.message);
    }), this.config.accountSyncIntervalMs));
    this.intervalTimers.push(setInterval(() => this.runQuotaSync().catch((error) => {
      this.logger.error('[scheduler] quota sync failed:', error.message);
    }), this.config.quotaSyncIntervalMs));
  }

  reschedule() {
    if (this.stopped) return;
    for (const timer of this.intervalTimers) clearInterval(timer);
    this.intervalTimers = [];
    this.scheduleTimers(false);
  }

  stop() {
    this.stopped = true;
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = null;
    for (const timer of this.intervalTimers) clearInterval(timer);
    this.intervalTimers = [];
  }

  async trigger(includeQuota = true) {
    await this.runAccountSync();
    if (includeQuota) await this.runQuotaSync();
  }

  async refreshAfterMutation() {
    const deadline = Date.now() + 10_000;
    while (this.accountSyncRunning && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (this.accountSyncRunning) {
      setTimeout(() => this.runAccountSync().catch((error) => {
        this.logger.error('[scheduler] post-mutation sync failed:', error.message);
      }), 1000);
      return false;
    }
    return this.runAccountSync();
  }

  expectRemoved(authIndexes) {
    for (const authIndex of authIndexes || []) {
      if (authIndex) this.expectedRemovedAuthIndexes.add(String(authIndex));
    }
  }

  async setConnection(connected, error = null) {
    const previous = this.store.getState('cpa_connection', null);
    const current = { connected, error, checkedAt: nowISO() };
    this.store.setState('cpa_connection', current);
    await this.alerts.connectionChanged(previous, current);
  }

  async runAccountSync() {
    if (this.accountSyncRunning) return false;
    this.accountSyncRunning = true;
    const runId = this.store.startRun('accounts');
    const seenAt = nowISO();
    const wasInitialized = this.alerts.initialized();
    try {
      const files = await this.cpaClient.listAuthFiles();
      await this.setConnection(true);
      const seen = new Set();
      for (const raw of files) {
        const preliminaryIndex = String(
          raw.auth_index || raw.authIndex || raw.id || `legacy-${sha256(`${raw.provider || raw.type}:${raw.name}`).slice(0, 16)}`
        );
        const previous = this.store.getAccount(preliminaryIndex);
        const account = normalizeAuthFile(raw, this.providers, previous, seenAt);
        seen.add(account.authIndex);
        const before = this.store.upsertAccount(account);
        const current = this.store.getAccount(account.authIndex);
        await this.alerts.accountTransition(before, current, account.statusMessage);
      }
      const missing = this.store.markMissing(seen, seenAt);
      let unexpectedMissing = 0;
      for (const account of missing) {
        if (this.expectedRemovedAuthIndexes.delete(account.auth_index)) continue;
        unexpectedMissing += 1;
        await this.alerts.accountMissing(account);
      }

      const previousCount = this.store.getState('last_account_count', null);
      if (previousCount !== null && unexpectedMissing > 0) {
        await this.alerts.accountCountChanged(previousCount, files.length);
      }
      this.store.setState('last_account_count', files.length);
      this.store.setState('last_account_sync', { status: 'ok', at: seenAt, accountCount: files.length });
      this.store.finishRun(runId, 'ok', files.length);
      this.alerts.markInitialized();
      if (!wasInitialized) await this.alerts.initialSnapshot(this.store.listAccounts());
      this.hub.broadcast('dashboard:update', { source: 'accounts', at: seenAt });
      return true;
    } catch (error) {
      const message = truncate(error.message, 500);
      await this.setConnection(false, message);
      this.store.setState('last_account_sync', { status: 'error', at: seenAt, error: message });
      this.store.finishRun(runId, 'error', null, message);
      this.hub.broadcast('dashboard:update', { source: 'accounts', at: seenAt, error: message });
      throw error;
    } finally {
      this.accountSyncRunning = false;
    }
  }

  async runQuotaSync() {
    if (this.quotaSyncRunning) return false;
    this.quotaSyncRunning = true;
    const runId = this.store.startRun('quota');
    const checkedAt = nowISO();
    try {
      const accounts = this.store.listAccounts();
      const concurrency = this.config.quotaConcurrency;
      const warningPercent = this.config.quotaWarningPercent;
      let completed = 0;
      const results = await mapConcurrent(accounts, concurrency, async (account) => {
        const result = await this.providers.probe(
          {
            authIndex: account.auth_index,
            provider: account.provider,
            accountName: account.account_name,
            projectId: account.project_id,
            metadata: account.metadata,
          },
          this.cpaClient
        );
        if (!result?.supported) {
          this.store.updateQuotaObservation(account.auth_index, result, checkedAt);
          completed += 1;
          this.hub.broadcast('quota:progress', { completed, total: accounts.length });
          return result;
        }
        const quotaState = evaluateQuotaState(result, warningPercent);
        const effectiveState = combineStates(account.base_state, quotaState);
        const previous = this.store.updateQuota(
          account.auth_index,
          result,
          quotaState,
          effectiveState,
          checkedAt
        );
        const current = this.store.getAccount(account.auth_index);
        await this.alerts.accountTransition(previous, current, result.summary?.reason || '额度检查完成');
        completed += 1;
        this.hub.broadcast('quota:progress', { completed, total: accounts.length });
        return result;
      });

      for (let index = 0; index < results.length; index += 1) {
        const result = results[index];
        if (result.status !== 'rejected') continue;
        const account = accounts[index];
        const error = result.reason;
        const errorMessage = truncate(error?.message || String(error), 500);
        const quotaState = error instanceof ProbeError ? error.classification : 'transient';
        const alertable = ['auth_invalid', 'disabled', 'quota_exhausted', 'rate_limited'].includes(quotaState);
        if (!alertable) {
          this.store.updateQuotaTransientError(
            account.auth_index,
            errorMessage,
            checkedAt
          );
          continue;
        }
        const effectiveState = combineStates(account.base_state, quotaState);
        const previous = this.store.updateQuotaError(
          account.auth_index,
          errorMessage,
          quotaState,
          effectiveState,
          checkedAt
        );
        const current = this.store.getAccount(account.auth_index);
        await this.alerts.accountTransition(previous, current, truncate(errorMessage, 240));
      }

      const failed = results.filter((result) => result.status === 'rejected').length;
      this.store.setState('last_quota_sync', {
        status: failed ? 'partial' : 'ok',
        at: checkedAt,
        checked: accounts.length,
        failed,
      });
      this.store.finishRun(runId, failed ? 'partial' : 'ok', accounts.length, failed ? `${failed} probes failed` : null);
      this.store.prune(this.config.historyRetentionDays);
      this.hub.broadcast('dashboard:update', { source: 'quota', at: checkedAt, failed });
      return true;
    } catch (error) {
      const message = truncate(error.message, 500);
      this.store.setState('last_quota_sync', { status: 'error', at: checkedAt, error: message });
      this.store.finishRun(runId, 'error', null, message);
      throw error;
    } finally {
      this.quotaSyncRunning = false;
    }
  }
}

export { normalizeAuthFile };
