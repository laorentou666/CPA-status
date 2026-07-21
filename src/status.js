const severity = {
  healthy: 0,
  unknown: 1,
  warning: 2,
  rate_limited: 2,
  disabled: 3,
  unavailable: 3,
  missing: 3,
  quota_exhausted: 4,
  auth_invalid: 5,
};

export function evaluateBaseState(account) {
  if (account.disabled) return 'disabled';
  if (account.unavailable) return 'unavailable';
  const status = String(account.cpaStatus || '').toLowerCase();
  const message = String(account.statusMessage || '').toLowerCase();
  const combined = `${status} ${message}`;
  if (/invalid|expired|revoked|unauthor|authentication failed|token.*fail/.test(combined)) {
    return 'auth_invalid';
  }
  if (/disabled/.test(status)) return 'disabled';
  if (/unavailable|error|failed/.test(status)) return 'unavailable';
  if (/ready|active|ok|available/.test(status)) return evaluateRequestHealth(account);
  return evaluateRequestHealth(account, 'unknown');
}

function evaluateRequestHealth(account, fallback = 'healthy') {
  const recent = Array.isArray(account.recentRequests) ? account.recentRequests : [];
  const counts = recent.reduce(
    (total, bucket) => ({
      success: total.success + Number(bucket.success || 0),
      failed: total.failed + Number(bucket.failed || 0),
    }),
    { success: 0, failed: 0 }
  );
  const requests = counts.success + counts.failed;
  if (requests >= 3 && counts.failed / requests >= 0.5) return 'warning';
  return fallback;
}

export function evaluateQuotaState(result, warningPercent = 80) {
  if (!result?.supported) return 'unknown';
  if (result.classification === 'auth_invalid') return 'auth_invalid';
  if (result.classification === 'quota_exhausted') return 'quota_exhausted';
  if (result.classification === 'rate_limited') return 'rate_limited';
  const percentages = (result.windows || [])
    .map((window) => window.usedPercent)
    .filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (percentages.some((value) => value >= 100)) return 'quota_exhausted';
  if (percentages.some((value) => value >= warningPercent)) return 'warning';
  return result.ok ? 'healthy' : 'unknown';
}

export function combineStates(baseState, quotaState) {
  if (baseState === 'missing') return 'missing';
  if ((severity[baseState] ?? 1) >= (severity[quotaState] ?? 1)) return baseState;
  return quotaState;
}

export function stateSeverity(state) {
  if (['auth_invalid', 'quota_exhausted'].includes(state)) return 'critical';
  if (['disabled', 'unavailable', 'missing', 'warning', 'rate_limited'].includes(state)) {
    return 'warning';
  }
  return 'info';
}

