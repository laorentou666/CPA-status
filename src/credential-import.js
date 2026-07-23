import { randomBytes } from 'node:crypto';
import { truncate } from './utils.js';

export class CredentialImportError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'CredentialImportError';
    this.statusCode = statusCode;
  }
}

class AsyncMutex {
  constructor() {
    this.tail = Promise.resolve();
  }

  async run(callback) {
    const previous = this.tail;
    let release;
    this.tail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  }
}

function safeFileName(value) {
  const name = String(value || '').trim();
  if (!name || name.length > 240 || name.includes('/') || name.includes('\\')) return null;
  if (name === '.' || name === '..' || !name.toLowerCase().endsWith('.json')) return null;
  return name;
}

function validateAuthFile(file, config) {
  const name = safeFileName(file?.name);
  if (!name) throw new CredentialImportError('只允许上传安全命名的 .json 文件');
  if (!Buffer.isBuffer(file.data)) throw new CredentialImportError(`${name} 文件内容无效`);
  if (file.data.length === 0) throw new CredentialImportError(`${name} 是空文件`);
  if (file.data.length > config.uploadMaxFileBytes) {
    throw new CredentialImportError(`${name} 超过单文件大小限制`, 413);
  }

  let parsed;
  try {
    parsed = JSON.parse(file.data.toString('utf8'));
  } catch {
    throw new CredentialImportError(`${name} 不是合法 JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CredentialImportError(`${name} 的顶层必须是 JSON 对象`);
  }
  return { name, data: file.data };
}

function callbackDetails(rawValue, expectedState) {
  const value = String(rawValue || '').trim();
  if (!value) throw new CredentialImportError('请填写完整回调 URL');
  if (value.length > 4096) throw new CredentialImportError('回调 URL 过长', 413);

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new CredentialImportError('回调 URL 格式无效');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new CredentialImportError('回调 URL 必须使用 http 或 https');
  }
  if (url.searchParams.get('state') !== expectedState) {
    throw new CredentialImportError('回调 URL 与当前 OAuth 流程不匹配');
  }
  if (!url.searchParams.get('code') && !url.searchParams.get('error')) {
    throw new CredentialImportError('回调 URL 缺少 code 或 error 参数');
  }
  return value;
}

export class CredentialImportService {
  constructor({ config, cpaClient, scheduler, logger = console, now = () => Date.now() }) {
    this.config = config;
    this.cpaClient = cpaClient;
    this.scheduler = scheduler;
    this.logger = logger;
    this.now = now;
    this.flows = new Map();
    this.pendingOAuthStarts = 0;
    this.pendingOAuthStartsByOwner = new Map();
    this.uploadMutex = new AsyncMutex();
  }

  cleanupFlows() {
    const now = this.now();
    for (const [flowId, flow] of this.flows) {
      if (flow.expiresAt <= now) this.flows.delete(flowId);
    }
  }

  activeFlowCount(ownerKey = null) {
    this.cleanupFlows();
    let count = 0;
    for (const flow of this.flows.values()) {
      if (flow.status !== 'wait') continue;
      if (ownerKey && flow.ownerKey !== ownerKey) continue;
      count += 1;
    }
    return count;
  }

  async startCodexOAuth(ownerKey) {
    if (!ownerKey) throw new CredentialImportError('客户端会话无效', 403);
    const ownerPending = this.pendingOAuthStartsByOwner.get(ownerKey) || 0;
    if (this.activeFlowCount() + this.pendingOAuthStarts >= this.config.oauthMaxActiveFlows) {
      throw new CredentialImportError('当前 OAuth 请求过多，请稍后再试', 429);
    }
    if (this.activeFlowCount(ownerKey) + ownerPending >= this.config.oauthMaxActiveFlowsPerClient) {
      throw new CredentialImportError('当前客户端已有进行中的 OAuth 流程', 429);
    }

    this.pendingOAuthStarts += 1;
    this.pendingOAuthStartsByOwner.set(ownerKey, ownerPending + 1);
    try {
      const started = await this.cpaClient.startCodexOAuth();
      const flowId = randomBytes(24).toString('base64url');
      const now = this.now();
      const expiresAt = now + 5 * 60 * 1000;
      this.flows.set(flowId, {
        flowId,
        ownerKey,
        cpaState: started.state,
        expiresAt,
        callbackSubmitted: false,
        status: 'wait',
        error: '',
        lastStatusCheckAt: 0,
        refreshTriggered: false,
      });
      return {
        flowId,
        url: started.url,
        expiresAt: new Date(expiresAt).toISOString(),
      };
    } finally {
      this.pendingOAuthStarts = Math.max(0, this.pendingOAuthStarts - 1);
      const remaining = (this.pendingOAuthStartsByOwner.get(ownerKey) || 1) - 1;
      if (remaining > 0) this.pendingOAuthStartsByOwner.set(ownerKey, remaining);
      else this.pendingOAuthStartsByOwner.delete(ownerKey);
    }
  }

  requireFlow(flowId, ownerKey) {
    this.cleanupFlows();
    const flow = this.flows.get(String(flowId || '').trim());
    if (!flow) throw new CredentialImportError('OAuth 流程不存在或已过期', 410);
    if (!ownerKey || flow.ownerKey !== ownerKey) {
      throw new CredentialImportError('OAuth 流程不属于当前客户端', 403);
    }
    return flow;
  }

  async submitCodexCallback(ownerKey, flowId, redirectURL) {
    const flow = this.requireFlow(flowId, ownerKey);
    if (flow.status === 'ok') return { status: 'ok' };
    if (flow.status === 'error') throw new CredentialImportError(flow.error || 'OAuth 已失败', 409);
    if (flow.callbackSubmitted) return { status: 'submitted' };

    const value = callbackDetails(redirectURL, flow.cpaState);
    await this.cpaClient.submitOAuthCallback({
      provider: 'codex',
      redirectURL: value,
      state: flow.cpaState,
    });
    flow.callbackSubmitted = true;
    flow.lastStatusCheckAt = 0;
    return { status: 'submitted' };
  }

  async getCodexOAuthStatus(ownerKey, flowId) {
    const flow = this.requireFlow(flowId, ownerKey);
    if (flow.status !== 'wait') {
      return { status: flow.status, error: flow.error || undefined };
    }

    const now = this.now();
    if (now - flow.lastStatusCheckAt < this.config.oauthStatusMinIntervalMs) {
      return { status: 'wait', callbackSubmitted: flow.callbackSubmitted };
    }
    flow.lastStatusCheckAt = now;

    const result = await this.cpaClient.getOAuthStatus(flow.cpaState);
    if (result.status === 'error') {
      flow.status = 'error';
      flow.error = truncate(result.error || 'OAuth 认证失败', 240);
      flow.expiresAt = now + 60_000;
      return { status: 'error', error: flow.error };
    }
    if (result.status !== 'ok') {
      return { status: 'wait', callbackSubmitted: flow.callbackSubmitted };
    }

    flow.status = 'ok';
    flow.expiresAt = now + 60_000;
    if (!flow.refreshTriggered) {
      flow.refreshTriggered = true;
      try {
        await this.scheduler.refreshAfterMutation();
      } catch (error) {
        this.logger.error('[oauth] post-login sync failed:', error.message);
      }
    }
    return { status: 'ok' };
  }

  async uploadAuthFiles(files, { allowOverwrite = false } = {}) {
    if (!Array.isArray(files) || files.length === 0) {
      throw new CredentialImportError('请选择至少一个 JSON 文件');
    }
    if (files.length > this.config.uploadMaxFiles) {
      throw new CredentialImportError(`单次最多上传 ${this.config.uploadMaxFiles} 个文件`, 413);
    }

    const validated = files.map((file) => validateAuthFile(file, this.config));
    const uniqueNames = new Set();
    for (const file of validated) {
      const key = file.name.toLowerCase();
      if (uniqueNames.has(key)) throw new CredentialImportError(`存在重复文件名：${file.name}`);
      uniqueNames.add(key);
    }

    return this.uploadMutex.run(async () => {
      let existing = new Set();
      if (!allowOverwrite) {
        const authFiles = await this.cpaClient.listAuthFiles();
        existing = new Set(authFiles.map((file) => String(file.name || '').toLowerCase()).filter(Boolean));
      }

      const uploaded = [];
      const failed = [];
      for (const file of validated) {
        if (!allowOverwrite && existing.has(file.name.toLowerCase())) {
          failed.push({ name: file.name, error: '同名认证文件已存在，游客不能覆盖' });
          continue;
        }
        try {
          const result = await this.cpaClient.uploadAuthFile(file.name, file.data);
          if (
            result.failed?.length ||
            ['error', 'failed', 'partial'].includes(String(result.status).toLowerCase())
          ) {
            throw new Error(result.failed?.[0]?.error || 'CPA rejected the auth file');
          }
          uploaded.push(file.name);
          existing.add(file.name.toLowerCase());
        } catch (error) {
          failed.push({ name: file.name, error: truncate(error.message, 240) });
        }
      }

      if (uploaded.length) {
        try {
          await this.scheduler.refreshAfterMutation();
        } catch (error) {
          this.logger.error('[upload] post-upload sync failed:', error.message);
        }
      }
      return {
        status: failed.length ? (uploaded.length ? 'partial' : 'error') : 'ok',
        uploaded: uploaded.length,
        files: uploaded,
        failed,
      };
    });
  }

  stop() {
    this.flows.clear();
    this.pendingOAuthStarts = 0;
    this.pendingOAuthStartsByOwner.clear();
  }
}

export { callbackDetails, safeFileName, validateAuthFile };
