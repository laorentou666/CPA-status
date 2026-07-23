import { maskIdentifier, nowISO } from './utils.js';

const stateLabels = {
  healthy: '正常',
  warning: '警告',
  quota_exhausted: '额度耗尽',
  auth_invalid: '认证失效',
  disabled: '已禁用',
  unavailable: '不可用',
  missing: '已移除',
  rate_limited: '被限流',
  unknown: '未知',
};

const explicitRecoveryStates = new Set(['auth_invalid', 'disabled', 'quota_exhausted', 'rate_limited']);

export class AlertEngine {
  constructor(store, notifications) {
    this.store = store;
    this.notifications = notifications;
  }

  initialized() {
    return Boolean(this.store.getState('monitor_initialized', false));
  }

  markInitialized() {
    this.store.setState('monitor_initialized', true);
  }

  async emit(event) {
    const saved = this.store.insertEvent({ ...event, createdAt: event.createdAt || nowISO() });
    await this.notifications.sendEvent(saved);
    return saved;
  }

  accountDisplay(account) {
    return maskIdentifier(account.email || account.label || account.name || account.auth_index);
  }

  async accountTransition(previous, current, reason = '') {
    const previousState = previous?.effective_state || previous?.effectiveState;
    const currentState = current?.effective_state || current?.effectiveState;
    if (!previousState || previousState === currentState) return null;
    this.store.recordStateChange(
      current.auth_index || current.authIndex,
      previousState,
      currentState,
      reason
    );
    if (!this.initialized()) return null;
    const becameHealthy = currentState === 'healthy';
    const recovered = becameHealthy && explicitRecoveryStates.has(previousState);
    return this.emit({
      type: recovered ? 'account_recovered' : 'account_state_changed',
      authIndex: current.auth_index || current.authIndex,
      title: becameHealthy ? '账号已恢复' : '账号状态变化',
      message: `${this.accountDisplay(current)} (${current.provider})：${stateLabels[previousState] || previousState} -> ${stateLabels[currentState] || currentState}${reason ? `；${reason}` : ''}`,
      payload: { previousState, currentState, provider: current.provider },
    });
  }

  async accountMissing(account) {
    if (!this.initialized()) return null;
    return this.emit({
      type: 'account_removed',
      authIndex: account.auth_index,
      title: 'CPA 账号数量减少',
      message: `${this.accountDisplay(account)} (${account.provider}) 已不在 CPA /auth-files 列表中。`,
      payload: { provider: account.provider },
    });
  }

  async accountCountChanged(previousCount, currentCount) {
    if (!this.initialized() || previousCount === null || previousCount === currentCount) return null;
    return this.emit({
      type: 'account_count_changed',
      title: currentCount < previousCount ? 'CPA 账号数量减少' : 'CPA 账号数量增加',
      message: `账号数量 ${previousCount} -> ${currentCount}。`,
      payload: { previousCount, currentCount },
    });
  }

  async initialSnapshot(accounts) {
    const unhealthy = accounts.filter((account) => explicitRecoveryStates.has(account.effective_state));
    if (!unhealthy.length) return null;
    const sample = unhealthy
      .slice(0, 5)
      .map((account) => `${this.accountDisplay(account)}:${stateLabels[account.effective_state]}`)
      .join('，');
    return this.emit({
      type: 'initial_unhealthy_accounts',
      title: '启动检查发现异常账号',
      message: `共 ${unhealthy.length} 个异常账号：${sample}${unhealthy.length > 5 ? ' 等' : ''}`,
      payload: { count: unhealthy.length },
    });
  }

  async connectionChanged(previous, current) {
    if (!previous || previous.connected === current.connected || !this.initialized()) return null;
    return this.emit({
      type: current.connected ? 'cpa_recovered' : 'cpa_unreachable',
      title: current.connected ? 'CPA 连接已恢复' : 'CPA 无法连接',
      message: current.connected ? '后台监控已重新连接 CLIProxyAPI。' : `后台无法同步 CLIProxyAPI：${current.error || 'unknown error'}`,
      payload: current,
    });
  }
}
