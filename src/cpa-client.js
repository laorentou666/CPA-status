import { truncate } from './utils.js';

const allowedProbeHosts = new Set([
  'chatgpt.com',
  'api.anthropic.com',
  'api.kimi.com',
  'daily-cloudcode-pa.googleapis.com',
  'daily-cloudcode-pa.sandbox.googleapis.com',
  'cloudcode-pa.googleapis.com',
  'cli-chat-proxy.grok.com',
  'api.x.ai',
]);

export class CPAError extends Error {
  constructor(message, { status = null, body = null, cause = null } = {}) {
    super(message, { cause });
    this.name = 'CPAError';
    this.status = status;
    this.body = body;
  }
}

export class CPAClient {
  constructor({ managementURL, managementKey, timeoutMs = 45_000, fetchImpl = fetch }) {
    this.managementURL = managementURL.replace(/\/$/, '');
    this.managementKey = managementKey;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  headers(extra = {}) {
    const headers = { Accept: 'application/json', ...extra };
    if (this.managementKey) headers.Authorization = `Bearer ${this.managementKey}`;
    return headers;
  }

  async request(path, options = {}) {
    const url = `${this.managementURL}/${String(path).replace(/^\//, '')}`;
    let response;
    try {
      response = await this.fetch(url, {
        ...options,
        headers: this.headers(options.headers),
        signal: options.signal || AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new CPAError(`CPA request failed: ${error.message}`, { cause: error });
    }

    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (!response.ok) {
      const detail = typeof body === 'object' ? body?.error || body?.message : body;
      throw new CPAError(`CPA returned HTTP ${response.status}: ${truncate(detail || response.statusText)}`, {
        status: response.status,
        body,
      });
    }
    return body;
  }

  async listAuthFiles() {
    const payload = await this.request('/auth-files');
    if (!payload || !Array.isArray(payload.files)) {
      throw new CPAError('CPA /auth-files returned an invalid payload');
    }
    return payload.files;
  }

  async deleteAuthFiles(names) {
    const uniqueNames = [...new Set((names || []).map((name) => String(name).trim()).filter(Boolean))];
    if (!uniqueNames.length) throw new CPAError('No auth file names were provided');
    for (const name of uniqueNames) {
      if (name.includes('/') || name.includes('\\') || !name.toLowerCase().endsWith('.json')) {
        throw new CPAError(`Unsafe auth file name: ${name}`);
      }
    }
    const payload = await this.request('/auth-files', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names: uniqueNames }),
    });
    const files = Array.isArray(payload?.files)
      ? payload.files
      : uniqueNames.length === 1 && payload?.status === 'ok'
        ? [uniqueNames[0]]
        : [];
    const failed = Array.isArray(payload?.failed) ? payload.failed : [];
    return {
      status: payload?.status || (failed.length ? 'partial' : 'ok'),
      deleted: Number.isFinite(Number(payload?.deleted)) ? Number(payload.deleted) : files.length,
      files,
      failed,
    };
  }

  async apiCall(authIndex, request) {
    const target = new URL(request.url);
    if (target.protocol !== 'https:' || !allowedProbeHosts.has(target.hostname)) {
      throw new CPAError(`Provider probe target is not allowlisted: ${target.hostname}`);
    }
    const payload = await this.request('/api-call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        auth_index: authIndex,
        method: request.method || 'GET',
        url: request.url,
        header: request.header || {},
        data: request.data || '',
      }),
    });
    if (!payload || typeof payload.status_code !== 'number') {
      throw new CPAError('CPA /api-call returned an invalid payload');
    }
    return {
      statusCode: payload.status_code,
      headers: payload.header || {},
      body: payload.body || '',
    };
  }
}
