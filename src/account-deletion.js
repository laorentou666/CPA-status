import { truncate } from './utils.js';

export const abnormalDeletionStates = new Set(['auth_invalid', 'unavailable']);

function deletionEligibility(account) {
  if (!account) return { allowed: false, reason: '账号不存在' };
  if (!account.current) return { allowed: false, reason: '账号已不在 CPA 当前列表中' };
  if (account.runtimeOnly || account.runtime_only) {
    return { allowed: false, reason: 'runtime_only 凭据没有可删除的磁盘认证文件' };
  }
  if (account.metadata?.source !== 'file') {
    return { allowed: false, reason: '该凭据不是磁盘认证文件' };
  }
  if (!String(account.name || '').toLowerCase().endsWith('.json')) {
    return { allowed: false, reason: '认证文件名不是 .json' };
  }
  return { allowed: true, reason: '' };
}

export class AccountDeletionService {
  constructor({ store, cpaClient, scheduler, alerts }) {
    this.store = store;
    this.cpaClient = cpaClient;
    this.scheduler = scheduler;
    this.alerts = alerts;
  }

  resolveAccounts(authIndexes) {
    const unique = [...new Set((authIndexes || []).map((value) => String(value).trim()).filter(Boolean))];
    return unique.map((authIndex) => ({ authIndex, account: this.store.getAccount(authIndex) }));
  }

  async deleteByAuthIndexes(authIndexes, source = 'selected') {
    const resolved = this.resolveAccounts(authIndexes);
    const skipped = [];
    const deletable = [];
    for (const item of resolved) {
      const eligibility = deletionEligibility(item.account);
      if (!eligibility.allowed) {
        skipped.push({ authIndex: item.authIndex, name: item.account?.name || '', reason: eligibility.reason });
      } else {
        deletable.push(item.account);
      }
    }
    if (!deletable.length) {
      return { status: 'noop', requested: resolved.length, deleted: 0, files: [], failed: [], skipped };
    }

    let result;
    try {
      result = await this.cpaClient.deleteAuthFiles(deletable.map((account) => account.name));
    } catch (error) {
      await this.alerts.emit({
        type: 'account_delete_failed',
        title: 'CPA 账号删除失败',
        message: `请求删除 ${deletable.length} 个账号失败：${truncate(error.message, 240)}`,
        payload: { source, requested: deletable.length },
      });
      throw error;
    }

    const deletedNames = new Set(result.files || []);
    this.scheduler.expectRemoved(
      deletable
        .filter((account) => deletedNames.has(account.name))
        .map((account) => account.auth_index)
    );
    await this.scheduler.refreshAfterMutation();
    const failed = result.failed || [];
    await this.alerts.emit({
      type: failed.length ? 'account_delete_partial' : 'account_deleted',
      title: failed.length ? 'CPA 账号部分删除失败' : 'CPA 账号已删除',
      message: `请求 ${deletable.length} 个，成功 ${result.deleted} 个，失败 ${failed.length} 个，跳过 ${skipped.length} 个。`,
      payload: {
        source,
        deleted: result.deleted,
        files: result.files,
        failed,
        skipped,
      },
    });
    return {
      status: failed.length ? 'partial' : 'ok',
      requested: resolved.length,
      deleted: result.deleted,
      files: result.files,
      failed,
      skipped,
    };
  }

  async deleteAbnormal() {
    const authIndexes = this.store
      .listAccounts()
      .filter((account) => abnormalDeletionStates.has(account.effective_state))
      .filter((account) => deletionEligibility(account).allowed)
      .map((account) => account.auth_index);
    return this.deleteByAuthIndexes(authIndexes, 'abnormal');
  }
}

export { deletionEligibility };
