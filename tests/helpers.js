import http from 'node:http';

export async function startMockCPA({ files = [], apiCall } = {}) {
  let currentFiles = files.map((file) => ({ ...file }));
  const uploads = [];
  const oauthSessions = new Map();
  let oauthStarts = 0;
  let uploadSequence = 0;
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/v0/management/auth-files' && request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ files: currentFiles }));
      return;
    }
    if (url.pathname === '/v0/management/auth-files' && request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const form = await new Response(body, {
        headers: { 'Content-Type': request.headers['content-type'] },
      }).formData();
      const file = [...form.values()].find(
        (value) => value && typeof value.arrayBuffer === 'function' && typeof value.name === 'string'
      );
      if (!file) {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'no files uploaded' }));
        return;
      }
      const data = Buffer.from(await file.arrayBuffer());
      let parsed;
      try {
        parsed = JSON.parse(data.toString('utf8'));
      } catch {
        response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'invalid auth file' }));
        return;
      }
      const existing = currentFiles.find((item) => item.name === file.name);
      const entry = {
        id: file.name,
        auth_index: existing?.auth_index || `uploaded-${++uploadSequence}`,
        name: file.name,
        provider: parsed.type || 'unknown',
        type: parsed.type || 'unknown',
        label: parsed.email || parsed.type || file.name,
        email: parsed.email || '',
        status: 'ready',
        disabled: false,
        unavailable: false,
        runtime_only: false,
        source: 'file',
        success: 0,
        failed: 0,
      };
      currentFiles = currentFiles.filter((item) => item.name !== file.name);
      currentFiles.push(entry);
      uploads.push({ name: file.name, parsed, authorization: request.headers.authorization || '' });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (url.pathname === '/v0/management/auth-files' && request.method === 'DELETE') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      const names = Array.isArray(body.names) ? [...new Set(body.names)] : [];
      const existingNames = new Set(currentFiles.map((file) => file.name));
      const deletedFiles = names.filter((name) => existingNames.has(name));
      const failed = names
        .filter((name) => !existingNames.has(name))
        .map((name) => ({ name, error: 'auth file not found' }));
      currentFiles = currentFiles.filter((file) => !deletedFiles.includes(file.name));
      response.writeHead(failed.length ? 207 : 200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        status: failed.length ? 'partial' : 'ok',
        deleted: deletedFiles.length,
        files: deletedFiles,
        failed,
      }));
      return;
    }
    if (url.pathname === '/v0/management/codex-auth-url' && request.method === 'GET') {
      const state = `codex-state-${++oauthStarts}`;
      oauthSessions.set(state, { status: 'wait' });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        status: 'ok',
        state,
        url: `https://auth.example.test/authorize?state=${encodeURIComponent(state)}`,
      }));
      return;
    }
    if (url.pathname === '/v0/management/oauth-callback' && request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const redirect = new URL(body.redirect_url);
      const state = body.state || redirect.searchParams.get('state');
      const session = oauthSessions.get(state);
      if (!session) {
        response.writeHead(404, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ status: 'error', error: 'unknown or expired state' }));
        return;
      }
      session.status = 'ok';
      if (!currentFiles.some((file) => file.name === `${state}.json`)) {
        currentFiles.push({
          id: `${state}.json`,
          auth_index: `oauth-${oauthStarts}`,
          name: `${state}.json`,
          provider: 'codex',
          label: 'OAuth User',
          email: `oauth-${oauthStarts}@example.com`,
          status: 'ready',
          disabled: false,
          unavailable: false,
          runtime_only: false,
          source: 'file',
          success: 0,
          failed: 0,
        });
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (url.pathname === '/v0/management/get-auth-status' && request.method === 'GET') {
      const session = oauthSessions.get(url.searchParams.get('state'));
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(session || { status: 'ok' }));
      return;
    }
    if (url.pathname === '/v0/management/api-call' && request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const result = apiCall ? await apiCall(body) : { status_code: 404, header: {}, body: '' };
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(result));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    server,
    managementURL: `http://127.0.0.1:${port}/v0/management`,
    files: () => currentFiles.map((file) => ({ ...file })),
    uploads: () => uploads.map((upload) => ({ ...upload, parsed: { ...upload.parsed } })),
    oauthStarts: () => oauthStarts,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export async function waitFor(predicate, { timeout = 5000, interval = 50 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error('waitFor timed out');
}

export function fixtureFiles() {
  return [
    {
      id: 'codex-user@example.com',
      auth_index: 'codex-1',
      name: 'codex-user.json',
      provider: 'codex',
      label: 'Codex Main',
      status: 'ready',
      status_message: 'ok',
      disabled: false,
      unavailable: false,
      runtime_only: false,
      source: 'file',
      success: 12,
      failed: 1,
      recent_requests: [{ time: '12:00-12:10', success: 3, failed: 0 }],
      email: 'user@example.com',
      id_token: { chatgpt_account_id: 'acct-1', plan_type: 'plus' },
    },
    {
      id: 'gemini-user@example.com',
      auth_index: 'gemini-1',
      name: 'gemini-user.json',
      provider: 'gemini',
      status: 'ready',
      disabled: false,
      unavailable: false,
      runtime_only: false,
      source: 'file',
      success: 5,
      failed: 0,
      email: 'gemini@example.com',
    },
  ];
}

export function mockApiCall(body) {
  if (body.url.includes('/wham/usage')) {
    return {
      status_code: 200,
      header: { 'Content-Type': ['application/json'] },
      body: JSON.stringify({
        plan_type: 'plus',
        rate_limit: {
          primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_after_seconds: 1800 },
          secondary_window: { used_percent: 40, limit_window_seconds: 604800, reset_after_seconds: 86400 },
        },
        credits: { balance: 12.5, has_credits: true },
      }),
    };
  }
  return { status_code: 404, header: {}, body: '{}' };
}
