import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { secureEqual, truncate } from './utils.js';
import { CredentialImportError } from './credential-import.js';
import { TokenBucketRateLimiter } from './rate-limiter.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

function json(response, status, body, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  response.end(JSON.stringify(body));
}

async function readBody(request, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new RequestError(413, 'request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJSON(request, limit = 64 * 1024) {
  const body = await readBody(request, limit);
  if (!body.length) return {};
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new RequestError(400, 'invalid JSON body');
  }
}

async function readMultipartFiles(request, limit) {
  const contentType = String(request.headers['content-type'] || '');
  if (!contentType.toLowerCase().startsWith('multipart/form-data;')) {
    throw new RequestError(415, 'multipart/form-data required');
  }
  const body = await readBody(request, limit);
  let form;
  try {
    form = await new Response(body, { headers: { 'Content-Type': contentType } }).formData();
  } catch {
    throw new RequestError(400, 'invalid multipart form');
  }
  const files = [];
  for (const value of form.values()) {
    if (!value || typeof value.arrayBuffer !== 'function' || typeof value.name !== 'string') continue;
    files.push({
      name: value.name,
      type: value.type || 'application/octet-stream',
      data: Buffer.from(await value.arrayBuffer()),
    });
  }
  return files;
}

function cookies(request) {
  return Object.fromEntries(
    String(request.headers.cookie || '')
      .split(';')
      .map((item) => item.trim().split('='))
      .filter(([key]) => key)
      .map(([key, ...value]) => [key, decodeURIComponent(value.join('='))])
  );
}

function appendCookie(response, value) {
  const current = response.getHeader('Set-Cookie');
  if (!current) response.setHeader('Set-Cookie', value);
  else if (Array.isArray(current)) response.setHeader('Set-Cookie', [...current, value]);
  else response.setHeader('Set-Cookie', [String(current), value]);
}

function forwardedHTTPS(request) {
  const forwardedProto = String(request.headers['x-forwarded-proto'] || '');
  return forwardedProto.split(',')[0].trim() === 'https';
}

function cookieSecurity(request) {
  return forwardedHTTPS(request) ? '; Secure' : '';
}

function requestIP(request, trustProxy) {
  if (trustProxy) {
    const forwarded = String(request.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return String(request.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}

function sameOriginRequest(request) {
  const origin = String(request.headers.origin || '').trim();
  if (!origin) return true;
  const scheme = forwardedHTTPS(request) ? 'https' : 'http';
  const expected = `${scheme}://${request.headers.host || 'localhost'}`;
  try {
    return new URL(origin).origin === new URL(expected).origin;
  } catch {
    return false;
  }
}

class RequestError extends Error {
  constructor(statusCode, message, headers = {}) {
    super(message);
    this.name = 'RequestError';
    this.statusCode = statusCode;
    this.headers = headers;
  }
}

class ClientIdentityManager {
  constructor({ ttlMs = 24 * 60 * 60 * 1000, maxEntries = 10_000, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = Math.max(1, Number(maxEntries) || 1);
    this.now = now;
    this.clients = new Map();
  }

  identify(request, response, { create = false } = {}) {
    const id = cookies(request).cpa_status_client;
    const expires = id ? this.clients.get(id) : null;
    if (expires && expires >= this.now()) {
      this.clients.delete(id);
      this.clients.set(id, this.now() + this.ttlMs);
      return id;
    }
    if (id) this.clients.delete(id);
    if (!create) return null;

    const next = randomBytes(24).toString('base64url');
    while (this.clients.size >= this.maxEntries) {
      this.clients.delete(this.clients.keys().next().value);
    }
    this.clients.set(next, this.now() + this.ttlMs);
    appendCookie(
      response,
      `cpa_status_client=${encodeURIComponent(next)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(this.ttlMs / 1000)}${cookieSecurity(request)}`
    );
    return next;
  }
}

class SessionManager {
  constructor(password, ttlMs) {
    this.sessions = new Map();
    this.password = password;
    this.ttlMs = ttlMs;
  }

  configure(password, ttlMs) {
    const sessionPolicyChanged = password !== this.password || ttlMs !== this.ttlMs;
    this.password = password;
    this.ttlMs = ttlMs;
    if (sessionPolicyChanged) this.sessions.clear();
  }

  required() {
    return Boolean(this.password);
  }

  authenticated(request) {
    if (!this.required()) return true;
    const id = cookies(request).cpa_status_session;
    const expires = id ? this.sessions.get(id) : null;
    if (!expires || expires < Date.now()) {
      if (id) this.sessions.delete(id);
      return false;
    }
    return true;
  }

  login(password) {
    if (!this.required() || secureEqual(password, this.password)) {
      const id = randomBytes(32).toString('base64url');
      this.sessions.set(id, Date.now() + this.ttlMs);
      return id;
    }
    return null;
  }

  logout(request) {
    const id = cookies(request).cpa_status_session;
    if (id) this.sessions.delete(id);
  }
}

function requiresAdmin(request, pathname) {
  if (!pathname.startsWith('/api/') || pathname === '/api/session') return false;
  const publicMutations = new Set([
    'POST /api/oauth/codex/start',
    'POST /api/oauth/codex/callback',
    'POST /api/auth-files/upload',
  ]);
  if (publicMutations.has(`${request.method} ${pathname}`)) return false;
  return request.method !== 'GET' && request.method !== 'HEAD';
}

function staticFile(response, filename, contentType) {
  const file = path.join(publicDir, filename);
  try {
    const body = fs.readFileSync(file);
    response.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': filename === 'index.html' ? 'no-cache' : 'public, max-age=300',
      'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
    });
    response.end(body);
  } catch {
    response.writeHead(404).end('Not found');
  }
}

export function createHTTPServer({
  config,
  store,
  scheduler,
  notifications,
  providers,
  hub,
  accountDeletion,
  credentialImport,
  logger = console,
}) {
  const sessions = new SessionManager(config.adminPassword, config.sessionTtlMs);
  const clients = new ClientIdentityManager();
  const limiter = new TokenBucketRateLimiter();

  function enforceRateLimit(scope, request, clientId, policy) {
    const ip = requestIP(request, config.trustProxy);
    const keys = [`${scope}:ip:${ip}`];
    if (clientId) keys.push(`${scope}:client:${clientId}`);
    let retryAfterMs = 0;
    for (const key of keys) {
      const result = limiter.consume(key, policy);
      if (!result.allowed) retryAfterMs = Math.max(retryAfterMs, result.retryAfterMs);
    }
    if (retryAfterMs > 0) {
      const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
      throw new RequestError(429, '请求过于频繁，请稍后再试', { 'Retry-After': String(seconds) });
    }
  }

  function requirePublicWriteClient(request, response) {
    if (!sameOriginRequest(request)) throw new RequestError(403, 'cross-origin request rejected');
    const clientId = clients.identify(request, response);
    if (!clientId) throw new RequestError(403, 'client session required');
    return {
      clientId,
      ownerKey: `${clientId}:${requestIP(request, config.trustProxy)}`,
    };
  }

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    try {
      if (request.method === 'GET' && url.pathname === '/api/health') {
        const connection = store.getState('cpa_connection', { connected: false, checkedAt: null });
        return json(response, 200, {
          status: connection.connected ? 'ok' : 'degraded',
          service: 'cpa-status',
          cpaConnected: Boolean(connection.connected),
          checkedAt: connection.checkedAt,
        });
      }

      if (url.pathname === '/api/session' && request.method === 'GET') {
        clients.identify(request, response, { create: true });
        return json(response, 200, {
          required: sessions.required(),
          authenticated: sessions.authenticated(request),
        });
      }

      if (url.pathname === '/api/session' && request.method === 'POST') {
        enforceRateLimit('login', request, null, {
          limit: config.loginRateLimit,
          windowMs: config.loginRateLimitWindowMs,
        });
        const body = await readJSON(request);
        const id = sessions.login(body.password || '');
        if (!id) return json(response, 401, { error: '密码错误' });
        appendCookie(
          response,
          `cpa_status_session=${encodeURIComponent(id)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(config.sessionTtlMs / 1000)}${cookieSecurity(request)}`
        );
        return json(response, 200, { ok: true });
      }

      if (url.pathname === '/api/session' && request.method === 'DELETE') {
        sessions.logout(request);
        response.setHeader('Set-Cookie', 'cpa_status_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
        return json(response, 200, { ok: true });
      }

      if (url.pathname === '/api/oauth/codex/start' && request.method === 'POST') {
        const identity = requirePublicWriteClient(request, response);
        enforceRateLimit('oauth-start', request, identity.clientId, {
          limit: config.oauthStartRateLimit,
          windowMs: config.oauthRateLimitWindowMs,
        });
        const result = await credentialImport.startCodexOAuth(identity.ownerKey);
        return json(response, 201, result);
      }

      if (url.pathname === '/api/oauth/codex/callback' && request.method === 'POST') {
        const identity = requirePublicWriteClient(request, response);
        enforceRateLimit('oauth-callback', request, identity.clientId, {
          limit: config.oauthCallbackRateLimit,
          windowMs: config.oauthRateLimitWindowMs,
        });
        const body = await readJSON(request, 8 * 1024);
        const result = await credentialImport.submitCodexCallback(
          identity.ownerKey,
          body.flowId,
          body.redirectUrl
        );
        return json(response, 202, result);
      }

      if (url.pathname === '/api/oauth/codex/status' && request.method === 'GET') {
        const identity = requirePublicWriteClient(request, response);
        enforceRateLimit('oauth-status', request, identity.clientId, {
          limit: config.oauthStatusRateLimit,
          windowMs: config.oauthRateLimitWindowMs,
        });
        const result = await credentialImport.getCodexOAuthStatus(
          identity.ownerKey,
          url.searchParams.get('flowId')
        );
        return json(response, 200, result);
      }

      if (url.pathname === '/api/auth-files/upload' && request.method === 'POST') {
        const identity = requirePublicWriteClient(request, response);
        enforceRateLimit('auth-upload', request, identity.clientId, {
          limit: config.uploadRateLimit,
          windowMs: config.uploadRateLimitWindowMs,
        });
        const files = await readMultipartFiles(request, config.uploadMaxRequestBytes);
        const result = await credentialImport.uploadAuthFiles(files, {
          allowOverwrite: sessions.authenticated(request),
        });
        return json(response, result.status === 'partial' ? 207 : 200, result);
      }

      if (requiresAdmin(request, url.pathname) && !sessions.authenticated(request)) {
        return json(response, 401, { error: 'authentication required' });
      }

      if (request.method === 'GET' && url.pathname === '/api/dashboard') {
        return json(response, 200, {
          ...store.getDashboard(),
          notificationChannels: notifications.status(),
          providerCapabilities: providers.capabilities(),
          schedule: {
            accountSyncSeconds: config.accountSyncIntervalMs / 1000,
            quotaSyncSeconds: config.quotaSyncIntervalMs / 1000,
          },
        });
      }

      if (request.method === 'GET' && url.pathname === '/api/events') {
        return json(response, 200, { events: store.listEvents(Number(url.searchParams.get('limit') || 100)) });
      }

      if (request.method === 'GET' && url.pathname === '/api/stream') {
        response.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        hub.add(response);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/refresh') {
        const body = await readJSON(request);
        scheduler.trigger(body.quota !== false).catch((error) => logger.error('[manual refresh]', error.message));
        return json(response, 202, { accepted: true });
      }

      if (request.method === 'POST' && url.pathname === '/api/notifications/test') {
        const body = await readJSON(request);
        const results = await notifications.test(Array.isArray(body.channels) ? body.channels : []);
        return json(response, 200, { results });
      }

      if (request.method === 'DELETE' && url.pathname === '/api/accounts') {
        const body = await readJSON(request);
        if (!Array.isArray(body.authIndexes) || body.authIndexes.length === 0) {
          return json(response, 400, { error: 'authIndexes must be a non-empty array' });
        }
        const result = await accountDeletion.deleteByAuthIndexes(body.authIndexes, 'selected');
        return json(response, result.status === 'partial' ? 207 : 200, result);
      }

      if (request.method === 'DELETE' && url.pathname === '/api/accounts/abnormal') {
        const result = await accountDeletion.deleteAbnormal();
        return json(response, result.status === 'partial' ? 207 : 200, result);
      }

      if (request.method === 'GET' && (
        url.pathname === '/' || url.pathname === '/index.html' ||
        url.pathname === '/admin' || url.pathname === '/admin/'
      )) {
        return staticFile(response, 'index.html', 'text/html; charset=utf-8');
      }
      if (request.method === 'GET' && url.pathname === '/app.js') {
        return staticFile(response, 'app.js', 'text/javascript; charset=utf-8');
      }
      if (request.method === 'GET' && url.pathname === '/styles.css') {
        return staticFile(response, 'styles.css', 'text/css; charset=utf-8');
      }

      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
    } catch (error) {
      if (error instanceof RequestError || error instanceof CredentialImportError) {
        return json(response, error.statusCode || 400, { error: error.message }, error.headers || {});
      }
      logger.error('[http]', error);
      json(response, 500, { error: truncate(error.message, 300) });
    }
  });
  return {
    server,
    reconfigure(nextConfig, changedKeys = []) {
      if (changedKeys.includes('adminPassword') || changedKeys.includes('sessionTtlMs')) {
        sessions.configure(nextConfig.adminPassword, nextConfig.sessionTtlMs);
      }
    },
  };
}
