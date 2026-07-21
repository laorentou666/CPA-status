import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { secureEqual, truncate } from './utils.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

function json(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

async function readJSON(request, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
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

export function createHTTPServer({ config, store, scheduler, notifications, providers, hub, accountDeletion, logger = console }) {
  const sessions = new SessionManager(config.adminPassword, config.sessionTtlMs);
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
        return json(response, 200, {
          required: sessions.required(),
          authenticated: sessions.authenticated(request),
        });
      }

      if (url.pathname === '/api/session' && request.method === 'POST') {
        const body = await readJSON(request);
        const id = sessions.login(body.password || '');
        if (!id) return json(response, 401, { error: '密码错误' });
        const forwardedProto = String(request.headers['x-forwarded-proto'] || '');
        const secure = forwardedProto.split(',')[0].trim() === 'https' ? '; Secure' : '';
        response.setHeader(
          'Set-Cookie',
          `cpa_status_session=${encodeURIComponent(id)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(config.sessionTtlMs / 1000)}${secure}`
        );
        return json(response, 200, { ok: true });
      }

      if (url.pathname === '/api/session' && request.method === 'DELETE') {
        sessions.logout(request);
        response.setHeader('Set-Cookie', 'cpa_status_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
        return json(response, 200, { ok: true });
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
