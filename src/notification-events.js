export const notificationEventDefinitions = Object.freeze([
  { key: 'account_auth_invalid', label: '账号认证失效' },
  { key: 'account_disabled', label: '账号被禁用或封禁' },
  { key: 'account_quota_exhausted', label: '账号额度耗尽' },
  { key: 'account_rate_limited', label: '账号被限流' },
  { key: 'account_unavailable', label: '账号变为不可用' },
  { key: 'account_warning', label: '账号进入警告状态' },
  { key: 'account_unknown', label: '账号状态变为未知' },
  { key: 'account_healthy', label: '普通状态恢复正常' },
  { key: 'account_recovered', label: '明确异常账号恢复' },
  { key: 'account_removed', label: '账号从 CPA 列表移除' },
  { key: 'account_count_increased', label: 'CPA 账号数量增加' },
  { key: 'account_count_decreased', label: 'CPA 账号数量减少' },
  { key: 'initial_unhealthy_accounts', label: '启动时发现明确异常账号' },
  { key: 'cpa_unreachable', label: 'CPA 管理接口无法连接' },
  { key: 'cpa_recovered', label: 'CPA 管理接口恢复连接' },
  { key: 'account_deleted', label: '账号删除成功' },
  { key: 'account_delete_partial', label: '账号部分删除失败' },
  { key: 'account_delete_failed', label: '账号删除失败' },
]);

const knownEventKeys = new Set(notificationEventDefinitions.map((item) => item.key));

export const defaultNotificationEvents = Object.freeze([
  'account_auth_invalid',
  'account_disabled',
  'account_quota_exhausted',
  'account_rate_limited',
  'account_recovered',
  'account_removed',
  'initial_unhealthy_accounts',
  'cpa_unreachable',
  'cpa_recovered',
  'account_delete_partial',
  'account_delete_failed',
]);

export function normalizeNotificationEvents(values, fallback = defaultNotificationEvents) {
  const source = typeof values === 'string' ? values.split(',') : values;
  if (!Array.isArray(source)) return [...fallback];
  const normalized = source.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean);
  if (normalized.includes('all') || normalized.includes('*')) {
    return notificationEventDefinitions.map((item) => item.key);
  }
  if (normalized.includes('none')) return [];
  return [...new Set(normalized.filter((key) => knownEventKeys.has(key)))];
}

export function notificationEventKey(event) {
  if (event?.notificationEvent) return String(event.notificationEvent).trim().toLowerCase();
  if (event?.type === 'account_state_changed') {
    const state = String(event.payload?.currentState || '').trim().toLowerCase();
    return state ? `account_${state}` : 'account_state_changed';
  }
  if (event?.type === 'account_count_changed') {
    const previous = Number(event.payload?.previousCount);
    const current = Number(event.payload?.currentCount);
    if (Number.isFinite(previous) && Number.isFinite(current)) {
      return current > previous ? 'account_count_increased' : 'account_count_decreased';
    }
  }
  return String(event?.type || '').trim().toLowerCase();
}
