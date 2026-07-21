const elements = Object.fromEntries(
  [
    'loginView', 'loginForm', 'password', 'loginError', 'app', 'connectionBadge', 'lastSync',
    'refreshButton', 'logoutButton', 'totalCount', 'healthyCount', 'warningCount',
    'exhaustedCount', 'unavailableCount', 'scheduleText', 'searchInput', 'providerFilter',
    'stateFilter', 'accountsBody', 'emptyState', 'eventsList', 'notificationList',
    'capabilityList', 'accountDrawer', 'drawerBackdrop', 'drawerClose', 'drawerProvider',
    'drawerTitle', 'drawerContent', 'toast', 'overviewView', 'accountManagerView',
    'selectionText', 'deleteSelectedButton', 'deleteAbnormalButton', 'managerSearchInput',
    'managerProviderFilter', 'managerStateFilter', 'selectAllAccounts', 'managementBody',
    'managementEmptyState',
  ].map((id) => [id, document.getElementById(id)])
);

const stateLabels = {
  healthy: '正常', warning: '警告', quota_exhausted: '额度耗尽', auth_invalid: '认证失效',
  disabled: '已禁用', unavailable: '不可用', missing: '已移除', rate_limited: '被限流', unknown: '未知',
};

let dashboard = null;
let eventSource = null;
let toastTimer = null;
const selectedAccounts = new Set();
const abnormalDeletionStates = new Set(['auth_invalid', 'unavailable']);

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

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 3500);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401) {
    showLogin();
    throw new Error(body.error || '需要登录');
  }
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function showLogin() {
  elements.app.hidden = true;
  elements.loginView.hidden = false;
  eventSource?.close();
}

function showApp(session) {
  elements.loginView.hidden = true;
  elements.app.hidden = false;
  elements.logoutButton.hidden = !session.required;
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
    return `<div class="quota-row" title="重置：${escapeHTML(formatTime(window.resetAt))}">
      <span class="quota-label">${escapeHTML(window.label)}</span>
      <span class="quota-track"><span class="quota-fill ${css}" style="width:${used === null ? 0 : Math.min(100, Math.max(0, used))}%"></span></span>
      <span class="quota-value">${used === null ? '-' : `${used.toFixed(0)}%`}</span>
    </div>`;
  }).join('')}</div>`;
}

function renderProviders() {
  const providers = Object.keys(dashboard.providers || {}).sort();
  for (const select of [elements.providerFilter, elements.managerProviderFilter]) {
    const current = select.value;
    select.innerHTML = '<option value="">全部 Provider</option>' + providers
      .map((provider) => `<option value="${escapeHTML(provider)}">${escapeHTML(provider)}</option>`).join('');
    select.value = providers.includes(current) ? current : '';
  }
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

function renderAccounts() {
  const accounts = filteredAccounts();
  elements.emptyState.hidden = accounts.length > 0;
  elements.accountsBody.innerHTML = accounts.map((account) => `
    <tr data-account="${escapeHTML(account.auth_index)}">
      <td><div class="account-name">${escapeHTML(account.label || account.email || account.name)}</div>
        <div class="account-meta">${escapeHTML(account.email || account.name)} · ${escapeHTML(account.auth_index)}</div></td>
      <td><span class="provider-tag">${escapeHTML(account.provider)}</span></td>
      <td><span class="state-pill ${escapeHTML(account.effective_state)}">${escapeHTML(stateLabels[account.effective_state] || account.effective_state)}</span></td>
      <td>${escapeHTML(account.plan_type || account.account_type || '-')}</td>
      <td>${quotaHTML(account)}</td>
      <td><span class="request-counts"><span class="success">${account.success_count || 0}</span><span class="failed">${account.failed_count || 0}</span></span></td>
      <td class="time-cell">${escapeHTML(formatTime(account.quota_checked_at || account.last_seen_at))}</td>
    </tr>`).join('');
}

function deletionEligibility(account) {
  if (account.runtimeOnly || account.runtime_only) return { allowed: false, reason: '运行时凭据' };
  if (account.metadata?.source !== 'file') return { allowed: false, reason: '非磁盘文件' };
  if (!String(account.name || '').toLowerCase().endsWith('.json')) return { allowed: false, reason: '非 JSON 认证文件' };
  return { allowed: true, reason: '' };
}

function filteredManagementAccounts() {
  const query = elements.managerSearchInput.value.trim().toLowerCase();
  const provider = elements.managerProviderFilter.value;
  const accountState = elements.managerStateFilter.value;
  return (dashboard.accounts || []).filter((account) => {
    const haystack = [account.name, account.email, account.label, account.auth_index, account.account_name]
      .join(' ').toLowerCase();
    return (!query || haystack.includes(query))
      && (!provider || account.provider === provider)
      && (!accountState || account.effective_state === accountState);
  });
}

function updateManagementActions(accounts = filteredManagementAccounts()) {
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

function renderManagementAccounts() {
  const accounts = filteredManagementAccounts();
  elements.managementEmptyState.hidden = accounts.length > 0;
  elements.managementBody.innerHTML = accounts.map((account) => {
    const eligibility = deletionEligibility(account);
    return `<tr>
      <td class="account-checkbox-cell"><input class="account-checkbox" type="checkbox" data-select-account="${escapeHTML(account.auth_index)}" aria-label="选择 ${escapeHTML(account.name)}" ${selectedAccounts.has(account.auth_index) ? 'checked' : ''} ${eligibility.allowed ? '' : 'disabled'}></td>
      <td><div class="account-name">${escapeHTML(account.label || account.email || account.name)}</div><div class="account-meta">${escapeHTML(account.auth_index)}</div></td>
      <td><span class="provider-tag">${escapeHTML(account.provider)}</span></td>
      <td><span class="state-pill ${escapeHTML(account.effective_state)}">${escapeHTML(stateLabels[account.effective_state] || account.effective_state)}</span></td>
      <td><span class="source-label">${escapeHTML(account.metadata?.source || 'unknown')}</span></td>
      <td><span class="account-meta">${escapeHTML(account.name)}</span>${eligibility.allowed ? '' : `<div class="undeletable">${escapeHTML(eligibility.reason)}</div>`}</td>
      <td>${eligibility.allowed ? `<button class="button danger-outline account-delete" type="button" data-delete-account="${escapeHTML(account.auth_index)}">删除</button>` : '-'}</td>
    </tr>`;
  }).join('');
  updateManagementActions(accounts);
}

function renderEvents() {
  const events = dashboard.events || [];
  elements.eventsList.innerHTML = events.length ? events.map((event) => `
    <div class="event-row">
      <span class="state-pill ${event.severity === 'critical' ? 'auth_invalid' : event.severity === 'warning' ? 'warning' : 'healthy'}">${escapeHTML(event.severity)}</span>
      <div><strong>${escapeHTML(event.title)}</strong><p>${escapeHTML(event.message)}</p></div>
      <span class="event-time">${escapeHTML(formatTime(event.created_at))}</span>
    </div>`).join('') : '<div class="empty-state">暂无事件</div>';
}

function renderOperations() {
  elements.notificationList.innerHTML = (dashboard.notificationChannels || []).map((channel) => `
    <div class="notification-row">
      <div><span>${escapeHTML(channel.name)}</span><small>${channel.configured ? (channel.enabled ? ' 已启用' : ' 已配置') : ' 未配置'}</small></div>
      <button class="button notification-test" type="button" data-channel="${escapeHTML(channel.name)}" ${channel.configured ? '' : 'disabled'}>测试</button>
    </div>`).join('');
  const capabilityLabels = { 'active-quota': '主动额度', 'health-only': '健康状态' };
  elements.capabilityList.innerHTML = Object.entries(dashboard.providerCapabilities || {}).map(([provider, capability]) => `
    <div class="capability-row"><span>${escapeHTML(provider)}</span><small>${escapeHTML(capabilityLabels[capability] || capability)}</small></div>`).join('');
}

function renderDashboard() {
  const counts = dashboard.counts || {};
  elements.totalCount.textContent = counts.total || 0;
  elements.healthyCount.textContent = counts.healthy || 0;
  elements.warningCount.textContent = counts.warning || 0;
  elements.exhaustedCount.textContent = counts.exhausted || 0;
  elements.unavailableCount.textContent = counts.unavailable || 0;
  const connection = dashboard.connection || {};
  elements.connectionBadge.className = `status-badge ${connection.connected ? 'connected' : 'disconnected'}`;
  elements.connectionBadge.textContent = connection.connected ? 'CPA 已连接' : 'CPA 未连接';
  const sync = dashboard.lastAccountSync;
  elements.lastSync.textContent = sync?.at ? `账号同步 ${formatTime(sync.at)}` : '尚未同步';
  elements.scheduleText.textContent = `账号每 ${dashboard.schedule.accountSyncSeconds} 秒同步，额度每 ${dashboard.schedule.quotaSyncSeconds} 秒检查`;
  renderProviders();
  renderAccounts();
  renderEvents();
  renderOperations();
  renderManagementAccounts();
}

function switchView(view) {
  const overview = view === 'overview';
  elements.overviewView.hidden = !overview;
  elements.accountManagerView.hidden = overview;
  document.querySelectorAll('.view-tab').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === view);
  });
  if (!overview) renderManagementAccounts();
}

async function deleteAccounts(authIndexes, label) {
  if (!authIndexes.length) return;
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

function connectSSE() {
  eventSource?.close();
  eventSource = new EventSource('/api/stream');
  eventSource.addEventListener('dashboard:update', () => loadDashboard().catch(() => {}));
  eventSource.addEventListener('quota:progress', (event) => {
    const progress = JSON.parse(event.data);
    elements.refreshButton.textContent = `检查中 ${progress.completed}/${progress.total}`;
  });
  eventSource.onerror = () => {
    elements.connectionBadge.className = 'status-badge unknown';
    elements.connectionBadge.textContent = '页面连接重试中';
  };
}

function openDrawer(authIndex) {
  const account = dashboard.accounts.find((item) => item.auth_index === authIndex);
  if (!account) return;
  elements.drawerProvider.textContent = account.provider;
  elements.drawerTitle.textContent = account.label || account.email || account.name;
  const summary = account.quotaSummary || {};
  elements.drawerContent.innerHTML = `
    <div class="detail-grid">
      <div class="detail-item"><span>状态</span><strong>${escapeHTML(stateLabels[account.effective_state] || account.effective_state)}</strong></div>
      <div class="detail-item"><span>CPA 状态</span><strong>${escapeHTML(account.cpa_status || '-')}</strong></div>
      <div class="detail-item"><span>Auth Index</span><strong>${escapeHTML(account.auth_index)}</strong></div>
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
    ${Object.keys(summary).length ? `<h3>摘要</h3><pre>${escapeHTML(JSON.stringify(summary, null, 2))}</pre>` : ''}`;
  elements.accountDrawer.hidden = false;
}

function closeDrawer() { elements.accountDrawer.hidden = true; }

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
  }
});

elements.logoutButton.addEventListener('click', async () => {
  await api('/api/session', { method: 'DELETE' });
  showLogin();
});

elements.refreshButton.addEventListener('click', async () => {
  elements.refreshButton.disabled = true;
  elements.refreshButton.textContent = '已提交';
  try {
    await api('/api/refresh', { method: 'POST', body: JSON.stringify({ quota: true }) });
    showToast('后台已开始同步账号和额度');
  } catch (error) {
    showToast(error.message);
  } finally {
    setTimeout(() => {
      elements.refreshButton.disabled = false;
      elements.refreshButton.innerHTML = '<span aria-hidden="true">↻</span> 立即同步';
    }, 1500);
  }
});

elements.searchInput.addEventListener('input', renderAccounts);
elements.providerFilter.addEventListener('change', renderAccounts);
elements.stateFilter.addEventListener('change', renderAccounts);
document.querySelectorAll('.view-tab').forEach((button) => {
  button.addEventListener('click', () => switchView(button.dataset.view));
});
elements.managerSearchInput.addEventListener('input', renderManagementAccounts);
elements.managerProviderFilter.addEventListener('change', renderManagementAccounts);
elements.managerStateFilter.addEventListener('change', renderManagementAccounts);
elements.managementBody.addEventListener('change', (event) => {
  const checkbox = event.target.closest('[data-select-account]');
  if (!checkbox) return;
  if (checkbox.checked) selectedAccounts.add(checkbox.dataset.selectAccount);
  else selectedAccounts.delete(checkbox.dataset.selectAccount);
  updateManagementActions();
});
elements.managementBody.addEventListener('click', (event) => {
  const button = event.target.closest('[data-delete-account]');
  if (!button) return;
  const account = dashboard.accounts.find((item) => item.auth_index === button.dataset.deleteAccount);
  deleteAccounts([button.dataset.deleteAccount], `账号 ${account?.label || account?.email || account?.name || ''}`);
});
elements.selectAllAccounts.addEventListener('change', () => {
  for (const account of filteredManagementAccounts()) {
    if (!deletionEligibility(account).allowed) continue;
    if (elements.selectAllAccounts.checked) selectedAccounts.add(account.auth_index);
    else selectedAccounts.delete(account.auth_index);
  }
  renderManagementAccounts();
});
elements.deleteSelectedButton.addEventListener('click', () => {
  deleteAccounts([...selectedAccounts], `所选 ${selectedAccounts.size} 个账号`);
});
elements.deleteAbnormalButton.addEventListener('click', deleteAbnormalAccounts);
elements.accountsBody.addEventListener('click', (event) => {
  const row = event.target.closest('[data-account]');
  if (row) openDrawer(row.dataset.account);
});
elements.drawerBackdrop.addEventListener('click', closeDrawer);
elements.drawerClose.addEventListener('click', closeDrawer);
elements.notificationList.addEventListener('click', async (event) => {
  const button = event.target.closest('.notification-test');
  if (!button) return;
  button.disabled = true;
  try {
    const result = await api('/api/notifications/test', {
      method: 'POST', body: JSON.stringify({ channels: [button.dataset.channel] }),
    });
    const delivery = result.results[0];
    showToast(delivery?.status === 'sent' ? `${button.dataset.channel} 测试成功` : `${button.dataset.channel}: ${delivery?.error || delivery?.status}`);
  } catch (error) {
    showToast(error.message);
  } finally { button.disabled = false; }
});

async function boot() {
  const session = await api('/api/session');
  if (!session.authenticated) return showLogin();
  showApp(session);
  await loadDashboard();
  connectSSE();
}

boot().catch((error) => showToast(error.message));
