const elements = Object.fromEntries(
  [
    'loginView', 'loginForm', 'password', 'loginError', 'app', 'pageMode',
    'connectionBadge', 'lastSync', 'refreshButton', 'adminLink', 'logoutButton',
    'totalCount', 'healthyCount', 'warningCount', 'exhaustedCount', 'unavailableCount',
    'scheduleText', 'selectionText', 'addAccountButton', 'managementActions', 'deleteSelectedButton',
    'deleteAbnormalButton', 'searchInput', 'providerFilter', 'stateFilter',
    'accountsTable', 'selectColumnHeader', 'operationHeader', 'selectAllAccounts',
    'accountsBody', 'emptyState', 'eventsList', 'notificationList', 'notificationEventList', 'capabilityList',
    'accountDrawer', 'drawerBackdrop', 'drawerClose', 'drawerProvider', 'drawerTitle',
    'drawerContent', 'credentialDrawer', 'credentialBackdrop', 'credentialClose',
    'oauthTabButton', 'uploadTabButton', 'oauthPanel', 'uploadPanel', 'startOAuthButton',
    'codexOAuthProviderButton', 'antigravityOAuthProviderButton',
    'oauthLinkRow', 'oauthLink', 'copyOAuthLinkButton', 'oauthCallbackForm',
    'oauthCallbackUrl', 'submitOAuthCallbackButton', 'oauthStatus', 'uploadForm',
    'authFileInput', 'chooseAuthFilesButton', 'uploadSelectionText', 'uploadFileList',
    'uploadAuthFilesButton', 'uploadStatus', 'toast',
  ].map((id) => [id, document.getElementById(id)])
);

const stateLabels = {
  healthy: '正常', warning: '警告', quota_exhausted: '额度耗尽', auth_invalid: '认证失效',
  disabled: '已禁用', unavailable: '不可用', missing: '已移除', rate_limited: '被限流', unknown: '未知',
};

const adminMode = window.location.pathname === '/admin' || window.location.pathname.startsWith('/admin/');
const abnormalDeletionStates = new Set(['auth_invalid', 'unavailable']);
const selectedAccounts = new Set();
let adminAuthenticated = false;
let dashboard = null;
let eventSource = null;
let toastTimer = null;
let refreshTimer = null;
let refreshing = false;
let oauthFlowId = '';
let oauthPollTimer = null;
let oauthPolling = false;
let oauthPollErrors = 0;
let selectedAuthFiles = [];
let oauthProvider = 'codex';

function escapeHTML(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function formatTime(value, fallback = '-') {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(date);
}

function maskEmail(value) {
  if (!value) return value;
  const str = String(value);
  const at = str.indexOf('@');
  if (at < 1) return str;
  const local = str.slice(0, at);
  const domain = str.slice(at);
  const visible = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  const masked = visible + '*'.repeat(Math.max(3, Math.min(local.length - visible.length, 5)));
  return masked + domain;
}

function maskIfNeeded(value) {
  return adminAuthenticated ? value : maskEmail(value);
}

function accountLabel(account) {
  const label = account.label || account.email || account.name || '';
  return maskIfNeeded(label);
}

function accountMetaText(account) {
  const email = account.email ? maskIfNeeded(account.email) : (account.name || '');
  return `${email} · ${account.auth_index || ''}`;
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 3500);
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (!(options.body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(path, {
    ...options,
    headers,
  });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401) {
    if (adminMode) showLogin();
    throw new Error(body.error || '需要管理员登录');
  }
  if (!response.ok) {
    const retryAfter = response.headers.get('retry-after');
    const suffix = retryAfter ? `（${retryAfter} 秒后重试）` : '';
    throw new Error(`${body.error || `HTTP ${response.status}`}${suffix}`);
  }
  return body;
}

function showLogin() {
  adminAuthenticated = false;
  elements.app.hidden = true;
  elements.loginView.hidden = false;
  eventSource?.close();
  elements.password.value = '';
  elements.password.focus();
}

function showApp(session) {
  adminAuthenticated = Boolean(adminMode && session.authenticated);
  elements.loginView.hidden = true;
  elements.app.hidden = false;
  elements.pageMode.textContent = adminAuthenticated ? '管理员页' : '游客页';
  elements.refreshButton.hidden = !adminAuthenticated;
  elements.adminLink.hidden = adminMode;
  elements.logoutButton.hidden = !adminAuthenticated || !session.required;
  elements.managementActions.hidden = !adminAuthenticated;
  elements.selectionText.hidden = !adminAuthenticated;
  elements.selectColumnHeader.hidden = !adminAuthenticated;
  elements.operationHeader.hidden = !adminAuthenticated;
  elements.accountsTable.classList.toggle('admin-mode', adminAuthenticated);
}

function quotaHTML(account, limit = 2) {
  const windows = (account.quotaWindows || []).slice(0, limit);
  if (!windows.length) {
    const capability = account.metadata?.quotaCapability;
    const text = capability === 'health-only' ? '仅监测健康状态' : (account.quota_error || '等待额度检查');
    return `<span class="quota-unknown" title="${escapeHTML(text)}">${escapeHTML(text)}</span>`;
  }
  return `<div class="quota-stack">${windows.map((window) => {
    const used = typeof window.usedPercent === 'number' ? window.usedPercent : null;
    const css = used >= 100 ? 'danger' : used >= 80 ? 'warn' : '';
    const fillValue = used === null ? 0 : Math.min(100, Math.max(0, used));
    return `<div class="quota-row" title="重置：${escapeHTML(formatTime(window.resetAt))}">
      <span class="quota-label">${escapeHTML(window.label)}</span>
      <span class="quota-track"><span class="quota-fill ${css}" data-fill="${fillValue}"></span></span>
      <span class="quota-value">${used === null ? '-' : `${used.toFixed(0)}%`}</span>
    </div>`;
  }).join('')}</div>`;
}

function applyFillWidths(root) {
  const scope = root || document;
  scope.querySelectorAll('.quota-fill[data-fill]').forEach((el) => {
    el.style.width = `${el.dataset.fill}%`;
  });
}

function deletionEligibility(account) {
  if (account.runtimeOnly || account.runtime_only) return { allowed: false, reason: '运行时凭据' };
  if (account.metadata?.source !== 'file') return { allowed: false, reason: '非磁盘文件' };
  if (!String(account.name || '').toLowerCase().endsWith('.json')) return { allowed: false, reason: '非 JSON 认证文件' };
  return { allowed: true, reason: '' };
}

function renderProviders() {
  const providers = Object.keys(dashboard.providers || {}).sort();
  const current = elements.providerFilter.value;
  elements.providerFilter.innerHTML = '<option value="">全部 Provider</option>' + providers
    .map((provider) => `<option value="${escapeHTML(provider)}">${escapeHTML(provider)}</option>`).join('');
  elements.providerFilter.value = providers.includes(current) ? current : '';
}

function filteredAccounts() {
  const query = elements.searchInput.value.trim().toLowerCase();
  const provider = elements.providerFilter.value;
  const accountState = elements.stateFilter.value;
  return (dashboard.accounts || []).filter((account) => {
    const haystack = [account.name, account.email, account.label, account.auth_index, account.account_name]
      .join(' ').toLowerCase();
    return (!query || haystack.includes(query))
      && (!provider || account.provider === provider)
      && (!accountState || account.effective_state === accountState);
  });
}

function updateManagementActions(accounts = filteredAccounts()) {
  if (!adminAuthenticated) return;
  const currentIndexes = new Set((dashboard.accounts || []).map((account) => account.auth_index));
  for (const authIndex of selectedAccounts) {
    if (!currentIndexes.has(authIndex)) selectedAccounts.delete(authIndex);
  }
  elements.selectionText.textContent = `已选择 ${selectedAccounts.size} 个账号`;
  elements.deleteSelectedButton.disabled = selectedAccounts.size === 0;
  elements.deleteSelectedButton.textContent = selectedAccounts.size
    ? `删除所选 (${selectedAccounts.size})`
    : '删除所选';
  const abnormal = (dashboard.accounts || []).filter(
    (account) => abnormalDeletionStates.has(account.effective_state) && deletionEligibility(account).allowed
  );
  elements.deleteAbnormalButton.disabled = abnormal.length === 0;
  elements.deleteAbnormalButton.textContent = `删除异常账号 (${abnormal.length})`;
  const selectable = accounts.filter((account) => deletionEligibility(account).allowed);
  const selectedVisible = selectable.filter((account) => selectedAccounts.has(account.auth_index));
  elements.selectAllAccounts.checked = selectable.length > 0 && selectedVisible.length === selectable.length;
  elements.selectAllAccounts.indeterminate = selectedVisible.length > 0 && selectedVisible.length < selectable.length;
}

function renderAccounts() {
  const accounts = filteredAccounts();
  elements.emptyState.hidden = accounts.length > 0;
  if (elements.emptyState.dataset.bootError) {
    elements.emptyState.textContent = '没有符合条件的账号';
    delete elements.emptyState.dataset.bootError;
  }
  elements.accountsBody.innerHTML = accounts.map((account) => {
    const eligibility = deletionEligibility(account);
    const selectionCell = adminAuthenticated
      ? `<td class="account-checkbox-cell"><input class="account-checkbox" type="checkbox" data-select-account="${escapeHTML(account.auth_index)}" aria-label="选择 ${escapeHTML(account.name)}" ${selectedAccounts.has(account.auth_index) ? 'checked' : ''} ${eligibility.allowed ? '' : `disabled title="${escapeHTML(eligibility.reason)}"`}></td>`
      : '';
    const operationCell = adminAuthenticated
      ? `<td class="operation-cell">${eligibility.allowed ? `<button class="btn btn-danger-outline account-delete" type="button" data-delete-account="${escapeHTML(account.auth_index)}">删除</button>` : `<span class="undeletable">${escapeHTML(eligibility.reason)}</span>`}</td>`
      : '';
    return `<tr data-account="${escapeHTML(account.auth_index)}">
      ${selectionCell}
      <td><div class="account-name">${escapeHTML(accountLabel(account))}</div>
        <div class="account-meta">${escapeHTML(accountMetaText(account))}</div></td>
      <td><span class="provider-tag">${escapeHTML(account.provider)}</span></td>
      <td><span class="state-pill ${escapeHTML(account.effective_state)}">${escapeHTML(stateLabels[account.effective_state] || account.effective_state)}</span></td>
      <td>${escapeHTML(account.plan_type || account.account_type || '-')}</td>
      <td>${quotaHTML(account)}</td>
      <td><span class="request-counts"><span class="success">${account.success_count || 0}</span><span class="failed">${account.failed_count || 0}</span></span></td>
      <td class="time-cell">${escapeHTML(formatTime(account.quota_checked_at || account.last_seen_at))}</td>
      ${operationCell}
    </tr>`;
  }).join('');
  applyFillWidths(elements.accountsBody);
  updateManagementActions(accounts);
}

function renderEvents() {
  const events = dashboard.events || [];
  elements.eventsList.innerHTML = events.length ? events.map((event) => `
    <div class="event-row">
      <div><strong>${escapeHTML(event.title)}</strong><p>${escapeHTML(event.message)}</p></div>
      <span class="event-time">${escapeHTML(formatTime(event.created_at))}</span>
    </div>`).join('') : '<div class="empty-state">暂无事件</div>';
}

function renderOperations() {
  elements.notificationList.innerHTML = (dashboard.notificationChannels || []).map((channel) => `
    <div class="channel-row">
      <div><strong>${escapeHTML(channel.name)}</strong><small>${channel.configured ? `${channel.enabled ? '已启用' : '已配置'} · ${channel.targets || 0} 个目标` : '未配置'}</small></div>
      ${adminAuthenticated ? `<button class="btn btn-ghost notification-test" type="button" data-channel="${escapeHTML(channel.name)}" ${channel.configured ? '' : 'disabled'}>测试</button>` : ''}
    </div>`).join('');
  elements.notificationEventList.innerHTML = (dashboard.notificationEvents || []).map((event) => `
    <div class="channel-row">
      <div><strong>${escapeHTML(event.label)}</strong><small>${escapeHTML(event.key)}</small></div>
      <span class="state-pill ${event.enabled ? 'healthy' : 'unknown'}">${event.enabled ? '已启用' : '已关闭'}</span>
    </div>`).join('');
  const capabilityLabels = { 'active-quota': '主动额度', 'health-only': '健康状态' };
  elements.capabilityList.innerHTML = Object.entries(dashboard.providerCapabilities || {}).map(([provider, capability]) => `
    <div class="channel-row"><strong>${escapeHTML(provider)}</strong><small>${escapeHTML(capabilityLabels[capability] || capability)}</small></div>`).join('');
}

function renderDashboard() {
  const counts = dashboard.counts || {};
  elements.totalCount.textContent = counts.total || 0;
  elements.healthyCount.textContent = counts.healthy || 0;
  elements.warningCount.textContent = counts.warning || 0;
  elements.exhaustedCount.textContent = counts.exhausted || 0;
  elements.unavailableCount.textContent = counts.unavailable || 0;
  const connection = dashboard.connection || {};
  elements.connectionBadge.className = `pill ${connection.connected ? 'pill-connected' : 'pill-disconnected'}`;
  elements.connectionBadge.textContent = connection.connected ? 'CPA 已连接' : 'CPA 未连接';
  const sync = dashboard.lastAccountSync;
  elements.lastSync.textContent = sync?.at ? `同步于 ${formatTime(sync.at)}` : '尚未同步';
  elements.scheduleText.textContent = `账号每 ${dashboard.schedule.accountSyncSeconds} 秒同步，额度每 ${dashboard.schedule.quotaSyncSeconds} 秒检查`;
  renderProviders();
  renderAccounts();
  renderEvents();
  renderOperations();
}

async function deleteAccounts(authIndexes, label) {
  if (!adminAuthenticated || !authIndexes.length) return;
  const confirmed = window.confirm(`确定删除${label}吗？认证文件会同时从 CLIProxyAPI 中删除，此操作不可撤销。`);
  if (!confirmed) return;
  elements.deleteSelectedButton.disabled = true;
  elements.deleteAbnormalButton.disabled = true;
  try {
    const result = await api('/api/accounts', {
      method: 'DELETE',
      body: JSON.stringify({ authIndexes }),
    });
    selectedAccounts.clear();
    await loadDashboard();
    showToast(`删除完成：成功 ${result.deleted}，失败 ${result.failed.length}，跳过 ${result.skipped.length}`);
  } catch (error) {
    showToast(`删除失败：${error.message}`);
  } finally {
    updateManagementActions();
  }
}

async function deleteAbnormalAccounts() {
  if (!adminAuthenticated) return;
  const abnormal = (dashboard.accounts || []).filter(
    (account) => abnormalDeletionStates.has(account.effective_state) && deletionEligibility(account).allowed
  );
  if (!abnormal.length) return;
  const confirmed = window.confirm(`确定删除 ${abnormal.length} 个认证失效或不可用账号吗？认证文件会同时从 CLIProxyAPI 中删除，此操作不可撤销。`);
  if (!confirmed) return;
  elements.deleteSelectedButton.disabled = true;
  elements.deleteAbnormalButton.disabled = true;
  try {
    const result = await api('/api/accounts/abnormal', { method: 'DELETE' });
    selectedAccounts.clear();
    await loadDashboard();
    showToast(`异常账号删除完成：成功 ${result.deleted}，失败 ${result.failed.length}`);
  } catch (error) {
    showToast(`删除失败：${error.message}`);
  } finally {
    updateManagementActions();
  }
}

async function loadDashboard() {
  dashboard = await api('/api/dashboard');
  renderDashboard();
}

function startRefresh(text) {
  refreshing = true;
  elements.refreshButton.disabled = true;
  elements.refreshButton.textContent = text || '同步中...';
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(endRefresh, 60000);
}

function endRefresh() {
  refreshing = false;
  clearTimeout(refreshTimer);
  elements.refreshButton.disabled = false;
  elements.refreshButton.textContent = '立即同步';
}

function connectSSE() {
  eventSource?.close();
  eventSource = new EventSource('/api/stream');
  eventSource.addEventListener('dashboard:update', () => loadDashboard().catch(() => {}));
  eventSource.addEventListener('config:update', async () => {
    if (adminMode) {
      const session = await api('/api/session').catch(() => null);
      if (!session?.authenticated) return showLogin();
    }
    loadDashboard().catch(() => {});
  });
  eventSource.addEventListener('quota:progress', (event) => {
    if (!adminAuthenticated || !refreshing) return;
    const progress = JSON.parse(event.data);
    elements.refreshButton.textContent = `同步中 ${progress.completed}/${progress.total}`;
    clearTimeout(refreshTimer);
    if (progress.completed >= progress.total) {
      refreshTimer = setTimeout(endRefresh, 1500);
    } else {
      refreshTimer = setTimeout(endRefresh, 10000);
    }
  });
  eventSource.onerror = () => {
    elements.connectionBadge.className = 'pill pill-muted';
    elements.connectionBadge.textContent = '重连中';
  };
}

function openDrawer(authIndex) {
  const account = dashboard.accounts.find((item) => item.auth_index === authIndex);
  if (!account) return;
  elements.drawerProvider.textContent = account.provider;
  elements.drawerTitle.textContent = accountLabel(account);
  const summary = account.quotaSummary || {};
  const authFile = maskIfNeeded(account.name || '-');
  elements.drawerContent.innerHTML = `
    <div class="detail-grid">
      <div class="detail-item"><span>状态</span><strong>${escapeHTML(stateLabels[account.effective_state] || account.effective_state)}</strong></div>
      <div class="detail-item"><span>CPA 状态</span><strong>${escapeHTML(account.cpa_status || '-')}</strong></div>
      <div class="detail-item"><span>Auth Index</span><strong>${escapeHTML(account.auth_index)}</strong></div>
      <div class="detail-item"><span>认证文件</span><strong>${escapeHTML(authFile)}</strong></div>
      <div class="detail-item"><span>来源</span><strong>${escapeHTML(account.metadata?.source || 'unknown')}</strong></div>
      <div class="detail-item"><span>计划</span><strong>${escapeHTML(account.plan_type || account.account_type || '-')}</strong></div>
      <div class="detail-item"><span>成功 / 失败</span><strong>${account.success_count || 0} / ${account.failed_count || 0}</strong></div>
      <div class="detail-item"><span>额度检查</span><strong>${escapeHTML(formatTime(account.quota_checked_at))}</strong></div>
    </div>
    ${account.status_message ? `<h3>状态信息</h3><p>${escapeHTML(account.status_message)}</p>` : ''}
    ${account.quota_error ? `<h3>检查错误</h3><p>${escapeHTML(account.quota_error)}</p>` : ''}
    <h3>额度窗口</h3>
    ${(account.quotaWindows || []).length ? account.quotaWindows.map((window) => `
      <div class="drawer-quota"><header><strong>${escapeHTML(window.label)}</strong><span>${typeof window.usedPercent === 'number' ? `${window.usedPercent.toFixed(1)}%` : '-'}</span></header>
      ${quotaHTML({ quotaWindows: [window] }, 1)}<small>重置：${escapeHTML(formatTime(window.resetAt))}</small></div>`).join('') : '<p class="quota-unknown">暂无主动额度数据</p>'}
    ${adminAuthenticated && Object.keys(summary).length ? `<h3>摘要</h3><pre>${escapeHTML(JSON.stringify(summary, null, 2))}</pre>` : ''}`;
  applyFillWidths(elements.drawerContent);
  elements.accountDrawer.hidden = false;
}

function closeDrawer() { elements.accountDrawer.hidden = true; }

function setImportStatus(element, message, status = '') {
  element.textContent = message;
  element.className = `import-status${status ? ` ${status}` : ''}`;
}

function setImportTab(tab) {
  const oauthActive = tab === 'oauth';
  elements.oauthPanel.hidden = !oauthActive;
  elements.uploadPanel.hidden = oauthActive;
  elements.oauthTabButton.classList.toggle('active', oauthActive);
  elements.uploadTabButton.classList.toggle('active', !oauthActive);
  elements.oauthTabButton.setAttribute('aria-selected', String(oauthActive));
  elements.uploadTabButton.setAttribute('aria-selected', String(!oauthActive));
}

function openCredentialDrawer() {
  elements.credentialDrawer.hidden = false;
}

function closeCredentialDrawer() {
  elements.credentialDrawer.hidden = true;
}

function stopOAuthPolling() {
  clearTimeout(oauthPollTimer);
  oauthPollTimer = null;
  oauthPolling = false;
}

function scheduleOAuthPoll(delay = 0) {
  clearTimeout(oauthPollTimer);
  oauthPollTimer = setTimeout(pollOAuthStatus, delay);
}

async function pollOAuthStatus() {
  if (!oauthFlowId || oauthPolling) return;
  oauthPolling = true;
  try {
    const result = await api(`/api/oauth/${oauthProvider}/status?flowId=${encodeURIComponent(oauthFlowId)}`);
    oauthPollErrors = 0;
    if (result.status === 'ok') {
      stopOAuthPolling();
      oauthFlowId = '';
      elements.startOAuthButton.disabled = false;
      elements.startOAuthButton.textContent = '生成新链接';
      elements.submitOAuthCallbackButton.disabled = true;
      setImportStatus(elements.oauthStatus, '认证成功，账号已同步', 'success');
      await loadDashboard();
      showToast(`${oauthProvider === 'antigravity' ? 'Antigravity' : 'Codex'} OAuth 认证成功`);
      return;
    }
    if (result.status === 'error') {
      stopOAuthPolling();
      oauthFlowId = '';
      elements.startOAuthButton.disabled = false;
      elements.startOAuthButton.textContent = '重新生成';
      elements.submitOAuthCallbackButton.disabled = true;
      setImportStatus(elements.oauthStatus, result.error || '认证失败', 'error');
      return;
    }
    setImportStatus(
      elements.oauthStatus,
      result.callbackSubmitted ? '正在交换认证信息' : '等待授权或回调 URL',
      'pending'
    );
    scheduleOAuthPoll(2000);
  } catch (error) {
    oauthPollErrors += 1;
    if (oauthFlowId && oauthPollErrors < 5) {
      setImportStatus(elements.oauthStatus, '状态查询暂时失败，正在重试', 'pending');
      scheduleOAuthPoll(2000);
    } else {
      stopOAuthPolling();
      oauthFlowId = '';
      elements.startOAuthButton.disabled = false;
      elements.startOAuthButton.textContent = '重新生成';
      elements.submitOAuthCallbackButton.disabled = true;
      setImportStatus(elements.oauthStatus, error.message, 'error');
    }
  } finally {
    oauthPolling = false;
  }
}

function setOAuthProvider(provider) {
  if (!['codex', 'antigravity'].includes(provider) || oauthFlowId) return;
  oauthProvider = provider;
  const antigravity = provider === 'antigravity';
  elements.codexOAuthProviderButton.classList.toggle('active', !antigravity);
  elements.antigravityOAuthProviderButton.classList.toggle('active', antigravity);
  elements.codexOAuthProviderButton.setAttribute('aria-selected', String(!antigravity));
  elements.antigravityOAuthProviderButton.setAttribute('aria-selected', String(antigravity));
  elements.startOAuthButton.textContent = '生成链接';
  setImportStatus(elements.oauthStatus, '尚未开始');
}

async function startOAuth() {
  elements.startOAuthButton.disabled = true;
  elements.startOAuthButton.textContent = '生成中...';
  elements.submitOAuthCallbackButton.disabled = true;
  elements.oauthLinkRow.hidden = true;
  elements.oauthCallbackUrl.value = '';
  setImportStatus(elements.oauthStatus, '正在连接 CPA', 'pending');
  oauthPollErrors = 0;
  try {
    const result = await api(`/api/oauth/${oauthProvider}/start`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    oauthFlowId = result.flowId;
    elements.oauthLink.href = result.url;
    elements.oauthLinkRow.hidden = false;
    elements.submitOAuthCallbackButton.disabled = false;
    elements.startOAuthButton.textContent = '进行中';
    setImportStatus(elements.oauthStatus, '等待授权或回调 URL', 'pending');
    scheduleOAuthPoll(2000);
  } catch (error) {
    oauthFlowId = '';
    elements.startOAuthButton.disabled = false;
    elements.startOAuthButton.textContent = '重新生成';
    setImportStatus(elements.oauthStatus, error.message, 'error');
  }
}

function renderSelectedAuthFiles() {
  elements.uploadFileList.replaceChildren();
  elements.uploadSelectionText.textContent = selectedAuthFiles.length
    ? `已选择 ${selectedAuthFiles.length} 个文件`
    : '未选择文件';
  elements.uploadAuthFilesButton.disabled = selectedAuthFiles.length === 0;
  for (const file of selectedAuthFiles) {
    const row = document.createElement('div');
    row.className = 'upload-file-row';
    const name = document.createElement('span');
    name.textContent = file.name;
    const size = document.createElement('small');
    size.textContent = `${Math.max(1, Math.ceil(file.size / 1024))} KB`;
    row.append(name, size);
    elements.uploadFileList.append(row);
  }
}

async function uploadAuthFiles() {
  if (!selectedAuthFiles.length) return;
  const form = new FormData();
  for (const file of selectedAuthFiles) form.append('file', file, file.name);
  elements.uploadAuthFilesButton.disabled = true;
  elements.chooseAuthFilesButton.disabled = true;
  setImportStatus(elements.uploadStatus, '正在上传到 CPA', 'pending');
  try {
    const result = await api('/api/auth-files/upload', { method: 'POST', body: form });
    const failed = Array.isArray(result.failed) ? result.failed : [];
    const message = failed.length
      ? `成功 ${result.uploaded || 0} 个，失败 ${failed.length} 个：${failed.map((item) => `${item.name} ${item.error}`).join('；')}`
      : `已上传 ${result.uploaded || 0} 个认证文件`;
    setImportStatus(elements.uploadStatus, message, failed.length ? 'error' : 'success');
    if (result.uploaded) {
      await loadDashboard();
      showToast(`认证文件上传完成：${result.uploaded} 个`);
    }
    selectedAuthFiles = [];
    elements.authFileInput.value = '';
    renderSelectedAuthFiles();
  } catch (error) {
    setImportStatus(elements.uploadStatus, error.message, 'error');
  } finally {
    elements.chooseAuthFilesButton.disabled = false;
    elements.uploadAuthFilesButton.disabled = selectedAuthFiles.length === 0;
  }
}

elements.loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  elements.loginError.textContent = '';
  try {
    await api('/api/session', { method: 'POST', body: JSON.stringify({ password: elements.password.value }) });
    const session = await api('/api/session');
    showApp(session);
    await loadDashboard();
    connectSSE();
  } catch (error) {
    elements.loginError.textContent = error.message;
    elements.password.value = '';
    elements.password.focus();
  }
});

elements.logoutButton.addEventListener('click', async () => {
  await api('/api/session', { method: 'DELETE' });
  showLogin();
});

elements.refreshButton.addEventListener('click', async () => {
  if (!adminAuthenticated || refreshing) return;
  startRefresh('已提交...');
  try {
    await api('/api/refresh', { method: 'POST', body: JSON.stringify({ quota: true }) });
    showToast('后台已开始同步账号和额度');
  } catch (error) {
    showToast(error.message);
    endRefresh();
  }
});

elements.searchInput.addEventListener('input', renderAccounts);
elements.providerFilter.addEventListener('change', renderAccounts);
elements.stateFilter.addEventListener('change', renderAccounts);
elements.accountsBody.addEventListener('change', (event) => {
  const checkbox = event.target.closest('[data-select-account]');
  if (!checkbox || !adminAuthenticated) return;
  if (checkbox.checked) selectedAccounts.add(checkbox.dataset.selectAccount);
  else selectedAccounts.delete(checkbox.dataset.selectAccount);
  updateManagementActions();
});
elements.accountsBody.addEventListener('click', (event) => {
  const deleteButton = event.target.closest('[data-delete-account]');
  if (deleteButton) {
    const account = dashboard.accounts.find((item) => item.auth_index === deleteButton.dataset.deleteAccount);
    deleteAccounts([deleteButton.dataset.deleteAccount], `账号 ${accountLabel(account)}`);
    return;
  }
  if (event.target.closest('button, input, a')) return;
  const row = event.target.closest('[data-account]');
  if (row) openDrawer(row.dataset.account);
});
elements.selectAllAccounts.addEventListener('change', () => {
  if (!adminAuthenticated) return;
  for (const account of filteredAccounts()) {
    if (!deletionEligibility(account).allowed) continue;
    if (elements.selectAllAccounts.checked) selectedAccounts.add(account.auth_index);
    else selectedAccounts.delete(account.auth_index);
  }
  renderAccounts();
});
elements.deleteSelectedButton.addEventListener('click', () => {
  deleteAccounts([...selectedAccounts], `所选 ${selectedAccounts.size} 个账号`);
});
elements.deleteAbnormalButton.addEventListener('click', deleteAbnormalAccounts);
elements.addAccountButton.addEventListener('click', openCredentialDrawer);
elements.drawerBackdrop.addEventListener('click', closeDrawer);
elements.drawerClose.addEventListener('click', closeDrawer);
elements.credentialBackdrop.addEventListener('click', closeCredentialDrawer);
elements.credentialClose.addEventListener('click', closeCredentialDrawer);
elements.oauthTabButton.addEventListener('click', () => setImportTab('oauth'));
elements.uploadTabButton.addEventListener('click', () => setImportTab('upload'));
elements.codexOAuthProviderButton.addEventListener('click', () => setOAuthProvider('codex'));
elements.antigravityOAuthProviderButton.addEventListener('click', () => setOAuthProvider('antigravity'));
elements.startOAuthButton.addEventListener('click', startOAuth);
elements.copyOAuthLinkButton.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(elements.oauthLink.href);
    showToast('授权链接已复制');
  } catch {
    showToast('复制失败，请打开链接后从地址栏复制');
  }
});
elements.oauthCallbackForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!oauthFlowId) return;
  elements.submitOAuthCallbackButton.disabled = true;
  setImportStatus(elements.oauthStatus, '正在提交回调 URL', 'pending');
  try {
    await api(`/api/oauth/${oauthProvider}/callback`, {
      method: 'POST',
      body: JSON.stringify({
        flowId: oauthFlowId,
        redirectUrl: elements.oauthCallbackUrl.value.trim(),
      }),
    });
    setImportStatus(elements.oauthStatus, '正在交换认证信息', 'pending');
    scheduleOAuthPoll(500);
  } catch (error) {
    elements.submitOAuthCallbackButton.disabled = false;
    setImportStatus(elements.oauthStatus, error.message, 'error');
  }
});
elements.chooseAuthFilesButton.addEventListener('click', () => elements.authFileInput.click());
elements.authFileInput.addEventListener('change', () => {
  selectedAuthFiles = [...elements.authFileInput.files];
  setImportStatus(elements.uploadStatus, '');
  renderSelectedAuthFiles();
});
elements.uploadForm.addEventListener('submit', (event) => {
  event.preventDefault();
  uploadAuthFiles();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !elements.accountDrawer.hidden) closeDrawer();
  else if (event.key === 'Escape' && !elements.credentialDrawer.hidden) closeCredentialDrawer();
});
elements.notificationList.addEventListener('click', async (event) => {
  const button = event.target.closest('.notification-test');
  if (!button || !adminAuthenticated) return;
  button.disabled = true;
  try {
    const result = await api('/api/notifications/test', {
      method: 'POST', body: JSON.stringify({ channels: [button.dataset.channel] }),
    });
    const delivery = result.results[0];
    showToast(delivery?.status === 'sent' ? `${button.dataset.channel} 测试成功` : `${button.dataset.channel}: ${delivery?.error || delivery?.status}`);
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
});

async function boot() {
  const session = await api('/api/session');
  if (adminMode && !session.authenticated) return showLogin();
  showApp(session);
  await loadDashboard();
  connectSSE();
}

boot().catch((error) => {
  if (!elements.loginView.hidden) return;
  elements.app.hidden = false;
  elements.accountsBody.innerHTML = '';
  elements.emptyState.hidden = false;
  elements.emptyState.dataset.bootError = '1';
  elements.emptyState.textContent = `加载失败：${error.message}`;
  showToast(error.message);
});
