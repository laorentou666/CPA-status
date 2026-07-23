import {
  clamp,
  finiteNumber,
  firstDefined,
  nonEmptyString,
  safeJSONParse,
  truncate,
} from './utils.js';

const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const KIMI_USAGE_URL = 'https://api.kimi.com/coding/v1/usages';
const XAI_WEEKLY_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';
const XAI_MONTHLY_URL = 'https://cli-chat-proxy.grok.com/v1/billing';
const XAI_ME_URL = 'https://api.x.ai/v1/me';
const ANTIGRAVITY_URLS = [
  'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
  'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary',
  'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
  'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
  'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels',
  'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
];

const capabilityMap = {
  codex: 'active-quota',
  claude: 'active-quota',
  anthropic: 'active-quota',
  kimi: 'active-quota',
  antigravity: 'active-quota',
  xai: 'active-quota',
  grok: 'active-quota',
};

export class ProbeError extends Error {
  constructor(message, { statusCode = null, classification = 'unknown', provider = '' } = {}) {
    super(message);
    this.name = 'ProbeError';
    this.statusCode = statusCode;
    this.classification = classification;
    this.provider = provider;
  }
}

const structuredErrorKeys = new Set([
  'code',
  'type',
  'error_code',
  'errorcode',
  'status',
  'reason',
  'kind',
  'category',
  'subscription',
  'error',
  'message',
  'detail',
]);

function providerName(value) {
  const normalized = String(value || 'unknown').trim().toLowerCase();
  if (normalized === 'anthropic') return 'claude';
  if (normalized === 'grok') return 'xai';
  return normalized || 'unknown';
}

function parseBody(body) {
  return safeJSONParse(body, null);
}

function structuredErrorText(body) {
  const payload = parseBody(body);
  if (!payload || typeof payload !== 'object') return '';
  const values = [];
  const visit = (value, depth = 0) => {
    if (depth > 5 || value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      const normalizedKey = key.replace(/[-\s]/g, '_').toLowerCase();
      if (structuredErrorKeys.has(normalizedKey) && (typeof item === 'string' || typeof item === 'number')) {
        values.push(String(item));
      }
      if (normalizedKey === 'error' || normalizedKey === 'errors' || typeof item === 'object') {
        visit(item, depth + 1);
      }
    }
  };
  visit(payload);
  return values.join(' ').toLowerCase();
}

function resetAt(window) {
  const direct = firstDefined(window, 'reset_at', 'resetAt', 'resets_at', 'resetsAt', 'reset_time', 'resetTime');
  if (direct !== undefined) {
    if (typeof direct === 'number' || /^\d+(\.\d+)?$/.test(String(direct))) {
      const numeric = Number(direct);
      const millis = numeric > 10_000_000_000 ? numeric : numeric * 1000;
      return new Date(millis).toISOString();
    }
    const date = new Date(direct);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  const after = finiteNumber(firstDefined(window, 'reset_after_seconds', 'resetAfterSeconds', 'reset_in', 'resetIn', 'ttl'));
  if (after !== null) return new Date(Date.now() + after * 1000).toISOString();
  return null;
}

function usedPercent(value) {
  const number = finiteNumber(value);
  if (number === null) return null;
  return clamp(number, 0, 100);
}

function remainingFraction(value) {
  if (typeof value === 'string' && value.trim().endsWith('%')) {
    const percent = finiteNumber(value.trim().slice(0, -1));
    return percent === null ? null : clamp(percent / 100, 0, 1);
  }
  const number = finiteNumber(value);
  if (number === null) return null;
  return clamp(number > 1 ? number / 100 : number, 0, 1);
}

function classifyFailure(provider, statusCode, body) {
  const text = String(body || '').toLowerCase();
  const structured = structuredErrorText(body);
  const combined = `${structured} ${text}`;
  if (/account[_ -]?deactivated|token[_ -]?(invalid|expired|revoked)|invalid[_ -]?grant|unauthorized|authentication[_ -]?failed/.test(structured)) {
    return 'auth_invalid';
  }
  if (/(?:this\s+service\s+has\s+been\s+disabled\s+in\s+this\s+account|(?:account|team|organization)\s+(?:is|was|has\s+been)\s+(?:disabled|deactivated|blocked|suspended|terminated)|(?:disabled|deactivated|blocked|suspended|terminated)\s+(?:account|team|organization)|team[_ -]?blocked|(?:account|team|organization).{0,80}violation\s+of\s+terms(?:\s+of\s+service)?)/.test(text)) {
    return 'disabled';
  }
  if (/usage_limit_reached|quota(?:[_ -]?exhausted|.*exhaust)|free-usage-exhausted|spending-limit/.test(combined)) {
    return 'quota_exhausted';
  }
  if (statusCode === 401) return 'auth_invalid';
  if (statusCode === 429) return 'rate_limited';
  if ([408, 499, 500, 502, 503, 504].includes(statusCode)) return 'transient';
  if (/context\s+(?:canceled|cancelled)|deadline exceeded|timed? ?out|connection reset|broken pipe|upstream .*error/.test(text)) {
    return 'transient';
  }
  return 'unknown';
}

function requireSuccess(provider, response) {
  if (response.statusCode >= 200 && response.statusCode < 300) return;
  throw new ProbeError(
    `${provider} probe returned HTTP ${response.statusCode}: ${truncate(response.body)}`,
    {
      provider,
      statusCode: response.statusCode,
      classification: classifyFailure(provider, response.statusCode, response.body),
    }
  );
}

function codexWindow(id, label, window, source = 'codex') {
  if (!window || typeof window !== 'object') return null;
  const used = usedPercent(firstDefined(window, 'used_percent', 'usedPercent'));
  if (used === null && !resetAt(window)) return null;
  return {
    id,
    label,
    usedPercent: used,
    remainingPercent: used === null ? null : clamp(100 - used, 0, 100),
    resetAt: resetAt(window),
    source,
    details: {
      limitWindowSeconds: finiteNumber(firstDefined(window, 'limit_window_seconds', 'limitWindowSeconds')),
    },
  };
}

function codexHeaders(account) {
  const headers = {
    Authorization: 'Bearer $TOKEN$',
    'Content-Type': 'application/json',
    'User-Agent': 'codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal',
  };
  const accountId = nonEmptyString(account.metadata?.idToken?.chatgpt_account_id);
  if (accountId) headers['Chatgpt-Account-Id'] = accountId;
  return headers;
}

async function probeCodex(account, client) {
  const response = await client.apiCall(account.authIndex, {
    url: CODEX_USAGE_URL,
    header: codexHeaders(account),
  });
  requireSuccess('codex', response);
  const payload = parseBody(response.body);
  if (!payload) throw new ProbeError('Codex usage response was not valid JSON', { provider: 'codex' });
  const rateLimit = firstDefined(payload, 'rate_limit', 'rateLimit') || {};
  const windows = [
    codexWindow('primary', '主额度窗口', firstDefined(rateLimit, 'primary_window', 'primaryWindow')),
    codexWindow('secondary', '次级额度窗口', firstDefined(rateLimit, 'secondary_window', 'secondaryWindow')),
  ].filter(Boolean);
  const additional = firstDefined(payload, 'additional_rate_limits', 'additionalRateLimits');
  for (const [index, item] of (Array.isArray(additional) ? additional : []).entries()) {
    const limit = firstDefined(item, 'rate_limit', 'rateLimit') || {};
    const name = nonEmptyString(firstDefined(item, 'limit_name', 'limitName', 'metered_feature', 'meteredFeature')) || `additional-${index + 1}`;
    for (const [suffix, label, window] of [
      ['primary', `${name} 主窗口`, firstDefined(limit, 'primary_window', 'primaryWindow')],
      ['secondary', `${name} 次级窗口`, firstDefined(limit, 'secondary_window', 'secondaryWindow')],
    ]) {
      const parsed = codexWindow(`${name}-${suffix}`, label, window, 'codex-additional');
      if (parsed) windows.push(parsed);
    }
  }
  const credits = payload.credits || {};
  return {
    supported: true,
    ok: true,
    provider: 'codex',
    planType: nonEmptyString(firstDefined(payload, 'plan_type', 'planType')),
    windows,
    summary: {
      balance: finiteNumber(credits.balance),
      hasCredits: firstDefined(credits, 'has_credits', 'hasCredits') ?? null,
      unlimited: credits.unlimited ?? null,
      approximateLocalMessages: finiteNumber(firstDefined(credits, 'approx_local_messages', 'approxLocalMessages')),
      approximateCloudMessages: finiteNumber(firstDefined(credits, 'approx_cloud_messages', 'approxCloudMessages')),
      subscriptionActiveUntil: firstDefined(payload, 'subscription_active_until', 'subscriptionActiveUntil') ?? null,
      rateLimitReachedType: firstDefined(payload, 'rate_limit_reached_type', 'rateLimitReachedType') ?? null,
    },
  };
}

const claudeWindowDefinitions = [
  ['five_hour', '5 小时额度'],
  ['seven_day', '7 天额度'],
  ['seven_day_oauth_apps', '7 天 OAuth Apps 额度'],
  ['seven_day_opus', '7 天 Opus 额度'],
  ['seven_day_sonnet', '7 天 Sonnet 额度'],
  ['seven_day_cowork', '7 天 Cowork 额度'],
  ['iguana_necktie', '扩展额度'],
];

async function probeClaude(account, client) {
  const headers = {
    Authorization: 'Bearer $TOKEN$',
    'Content-Type': 'application/json',
    'anthropic-beta': 'oauth-2025-04-20',
  };
  const [usageResult, profileResult] = await Promise.allSettled([
    client.apiCall(account.authIndex, { url: CLAUDE_USAGE_URL, header: headers }),
    client.apiCall(account.authIndex, { url: CLAUDE_PROFILE_URL, header: headers }),
  ]);
  if (usageResult.status === 'rejected') throw usageResult.reason;
  requireSuccess('claude', usageResult.value);
  const payload = parseBody(usageResult.value.body);
  if (!payload) throw new ProbeError('Claude usage response was not valid JSON', { provider: 'claude' });
  const windows = [];
  for (const [key, label] of claudeWindowDefinitions) {
    const item = payload[key];
    if (!item || typeof item !== 'object') continue;
    const used = usedPercent(item.utilization);
    if (used === null && !resetAt(item)) continue;
    windows.push({
      id: key.replaceAll('_', '-'),
      label,
      usedPercent: used,
      remainingPercent: used === null ? null : clamp(100 - used, 0, 100),
      resetAt: resetAt(item),
      source: 'claude',
      details: {},
    });
  }
  for (const [index, item] of (Array.isArray(payload.limits) ? payload.limits : []).entries()) {
    if (item?.is_active === false || item?.isActive === false) continue;
    const used = usedPercent(firstDefined(item, 'percent', 'utilization'));
    if (used === null && !resetAt(item)) continue;
    const scope = nonEmptyString(firstDefined(item, 'scope', 'group', 'kind')) || `scoped-${index + 1}`;
    windows.push({
      id: `limit-${index}-${scope}`,
      label: `Scoped: ${scope}`,
      usedPercent: used,
      remainingPercent: used === null ? null : clamp(100 - used, 0, 100),
      resetAt: resetAt(item),
      source: 'claude-scoped',
      details: { kind: item.kind ?? null, group: item.group ?? null },
    });
  }
  let planType = null;
  if (profileResult.status === 'fulfilled' && profileResult.value.statusCode >= 200 && profileResult.value.statusCode < 300) {
    const profile = parseBody(profileResult.value.body) || {};
    const accountProfile = profile.account || {};
    if (accountProfile.has_claude_max) planType = 'max';
    else if (accountProfile.has_claude_pro) planType = 'pro';
    else planType = nonEmptyString(accountProfile.organization_type || accountProfile.subscription_status);
  }
  return {
    supported: true,
    ok: true,
    provider: 'claude',
    planType,
    windows,
    summary: { extraUsage: payload.extra_usage || null },
  };
}

function buildKimiWindows(payload) {
  const rows = [];
  const items = Array.isArray(payload.limits) ? payload.limits : payload.usage ? [payload.usage] : [];
  for (const [index, item] of items.entries()) {
    const detail = item.detail && typeof item.detail === 'object' ? item.detail : item;
    const used = finiteNumber(detail.used);
    const limit = finiteNumber(detail.limit);
    const percent = used !== null && limit && limit > 0 ? clamp((used / limit) * 100, 0, 100) : null;
    rows.push({
      id: nonEmptyString(item.name || detail.name) || `kimi-${index + 1}`,
      label: nonEmptyString(item.title || detail.title || item.name || detail.name) || `额度 ${index + 1}`,
      usedPercent: percent,
      remainingPercent: percent === null ? null : clamp(100 - percent, 0, 100),
      resetAt: resetAt(detail),
      source: 'kimi',
      details: { used, limit, remaining: finiteNumber(detail.remaining) },
    });
  }
  return rows;
}

async function probeKimi(account, client) {
  const response = await client.apiCall(account.authIndex, {
    url: KIMI_USAGE_URL,
    header: { Authorization: 'Bearer $TOKEN$' },
  });
  requireSuccess('kimi', response);
  const payload = parseBody(response.body);
  if (!payload) throw new ProbeError('Kimi usage response was not valid JSON', { provider: 'kimi' });
  return { supported: true, ok: true, provider: 'kimi', windows: buildKimiWindows(payload), summary: {} };
}

function buildAntigravityWindows(payload) {
  const windows = [];
  for (const [groupIndex, group] of (Array.isArray(payload.groups) ? payload.groups : []).entries()) {
    for (const [bucketIndex, bucket] of (Array.isArray(group.buckets) ? group.buckets : []).entries()) {
      const fraction = remainingFraction(firstDefined(bucket, 'remainingFraction', 'remaining_fraction'));
      const id = nonEmptyString(firstDefined(bucket, 'bucketId', 'bucket_id')) || `group-${groupIndex}-${bucketIndex}`;
      windows.push({
        id,
        label: nonEmptyString(firstDefined(bucket, 'displayName', 'display_name')) || nonEmptyString(firstDefined(group, 'displayName', 'display_name')) || id,
        usedPercent: fraction === null ? null : clamp((1 - fraction) * 100, 0, 100),
        remainingPercent: fraction === null ? null : clamp(fraction * 100, 0, 100),
        resetAt: resetAt(bucket),
        source: 'antigravity-summary',
        details: { description: bucket.description || group.description || null },
      });
    }
  }
  const models = payload.models && typeof payload.models === 'object' ? payload.models : {};
  for (const [modelId, model] of Object.entries(models)) {
    const quota = firstDefined(model, 'quotaInfo', 'quota_info') || {};
    const fraction = remainingFraction(firstDefined(quota, 'remainingFraction', 'remaining_fraction', 'remaining'));
    if (fraction === null && !resetAt(quota)) continue;
    windows.push({
      id: `model-${modelId}`,
      label: nonEmptyString(firstDefined(model, 'displayName', 'display_name', 'model')) || modelId,
      usedPercent: fraction === null ? null : clamp((1 - fraction) * 100, 0, 100),
      remainingPercent: fraction === null ? null : clamp(fraction * 100, 0, 100),
      resetAt: resetAt(quota),
      source: 'antigravity-models',
      details: { modelId },
    });
  }
  return windows;
}

async function probeAntigravity(account, client) {
  const project = account.projectId || 'bamboo-precept-lgxtn';
  let lastError = null;
  for (const url of ANTIGRAVITY_URLS) {
    const response = await client.apiCall(account.authIndex, {
      method: 'POST',
      url,
      header: {
        Authorization: 'Bearer $TOKEN$',
        'Content-Type': 'application/json',
        'User-Agent': 'antigravity/cli/1.0.13 (aidev_client; os_type=darwin; arch=arm64)',
      },
      data: JSON.stringify({ project }),
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      lastError = new ProbeError(`Antigravity probe returned HTTP ${response.statusCode}`, {
        provider: 'antigravity',
        statusCode: response.statusCode,
        classification: classifyFailure('antigravity', response.statusCode, response.body),
      });
      continue;
    }
    const outer = parseBody(response.body);
    const payload = typeof outer?.body === 'string' ? parseBody(outer.body) : outer;
    const windows = payload ? buildAntigravityWindows(payload) : [];
    if (windows.length) {
      return { supported: true, ok: true, provider: 'antigravity', windows, summary: { project } };
    }
  }
  throw lastError || new ProbeError('Antigravity returned no quota data', { provider: 'antigravity' });
}

function xaiNumber(value) {
  if (value && typeof value === 'object') return finiteNumber(value.val);
  return finiteNumber(value);
}

function parseXaiSummary(payload, source) {
  const config = payload?.config;
  if (!config || typeof config !== 'object') return null;
  const period = firstDefined(config, 'currentPeriod', 'current_period') || {};
  const used = finiteNumber(firstDefined(config, 'creditUsagePercent', 'credit_usage_percent'));
  const monthlyLimit = xaiNumber(firstDefined(config, 'monthlyLimit', 'monthly_limit'));
  const usedCents = xaiNumber(config.used);
  const calculated = used ?? (monthlyLimit && usedCents !== null ? (usedCents / monthlyLimit) * 100 : null);
  return {
    id: `xai-${source}`,
    label: source === 'weekly' ? '周额度' : '月度账单',
    usedPercent: calculated === null ? null : clamp(calculated, 0, 100),
    remainingPercent: calculated === null ? null : clamp(100 - calculated, 0, 100),
    resetAt: resetAt({ reset_at: firstDefined(period, 'end') || firstDefined(config, 'billingPeriodEnd', 'billing_period_end') }),
    source: 'xai-billing',
    details: {
      periodType: period.type || source,
      monthlyLimitCents: monthlyLimit,
      usedCents,
      onDemandCapCents: xaiNumber(firstDefined(config, 'onDemandCap', 'on_demand_cap')),
      onDemandUsedCents: xaiNumber(firstDefined(config, 'onDemandUsed', 'on_demand_used')),
      productUsage: firstDefined(config, 'productUsage', 'product_usage') || [],
    },
  };
}

async function probeXai(account, client) {
  const headers = {
    Authorization: 'Bearer $TOKEN$',
    'x-xai-token-auth': 'xai-grok-cli',
    'x-grok-client-version': '0.2.101',
    Accept: '*/*',
    'User-Agent': 'grok-pager/0.2.101 grok-shell/0.2.101 (macos; aarch64)',
  };
  if (account.accountName) headers['x-userid'] = account.accountName;
  const results = await Promise.all([
    client.apiCall(account.authIndex, { url: XAI_WEEKLY_URL, header: headers }),
    client.apiCall(account.authIndex, { url: XAI_MONTHLY_URL, header: headers }),
  ]);
  const windows = [];
  const failures = [];
  for (const [index, response] of results.entries()) {
    if (response.statusCode >= 200 && response.statusCode < 300) {
      const window = parseXaiSummary(parseBody(response.body), index === 0 ? 'weekly' : 'monthly');
      if (window) windows.push(window);
    } else {
      failures.push(response);
    }
  }
  if (windows.length) {
    return { supported: true, ok: true, provider: 'xai', windows, summary: { partial: failures.length > 0 } };
  }
  if (failures.length === 2 && failures.every((failure) => failure.statusCode === 403)) {
    const identity = await client.apiCall(account.authIndex, {
      url: XAI_ME_URL,
      header: { Authorization: 'Bearer $TOKEN$', Accept: 'application/json' },
    });
    requireSuccess('xai', identity);
    const payload = parseBody(identity.body) || {};
    if (firstDefined(payload, 'team_blocked', 'teamBlocked') === true) {
      throw new ProbeError('xAI official API team is blocked', {
        provider: 'xai',
        statusCode: 403,
        classification: 'disabled',
      });
    }
    return {
      supported: true,
      ok: true,
      provider: 'xai',
      windows: [],
      summary: {
        identityOnly: true,
        userId: firstDefined(payload, 'user_id', 'userId') ?? null,
        teamId: firstDefined(payload, 'team_id', 'teamId') ?? null,
      },
    };
  }
  const failure = failures[0];
  throw new ProbeError(`xAI billing probe returned HTTP ${failure?.statusCode || 'unknown'}`, {
    provider: 'xai',
    statusCode: failure?.statusCode || null,
    classification: classifyFailure('xai', failure?.statusCode, failure?.body),
  });
}

const probes = {
  codex: probeCodex,
  claude: probeClaude,
  kimi: probeKimi,
  antigravity: probeAntigravity,
  xai: probeXai,
};

export class ProviderRegistry {
  normalize(value) {
    return providerName(value);
  }

  capability(value) {
    return capabilityMap[String(value || '').toLowerCase()] || 'health-only';
  }

  supports(value) {
    return Boolean(probes[this.normalize(value)]);
  }

  capabilities() {
    return {
      codex: 'active-quota',
      claude: 'active-quota',
      kimi: 'active-quota',
      antigravity: 'active-quota',
      xai: 'active-quota',
      gemini: 'health-only',
      aistudio: 'health-only',
      vertex: 'health-only',
      'openai-compatibility': 'health-only',
      other: 'health-only',
    };
  }

  async probe(account, client) {
    const provider = this.normalize(account.provider);
    const probe = probes[provider];
    if (!probe) {
      return {
        supported: false,
        ok: true,
        provider,
        windows: [],
        summary: {
          reason: '该 Provider 没有经文档确认的统一只读额度接口，仍持续监测 CPA 状态和请求健康。',
        },
      };
    }
    return probe(account, client);
  }
}

export const providerConstants = {
  CODEX_USAGE_URL,
  CLAUDE_USAGE_URL,
  CLAUDE_PROFILE_URL,
  KIMI_USAGE_URL,
  XAI_WEEKLY_URL,
  XAI_MONTHLY_URL,
  XAI_ME_URL,
  ANTIGRAVITY_URLS,
};
