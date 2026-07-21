import http from 'node:http';

export async function startMockCPA({ files = [], apiCall } = {}) {
  const server = http.createServer(async (request, response) => {
    if (request.url === '/v0/management/auth-files' && request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ files }));
      return;
    }
    if (request.url === '/v0/management/api-call' && request.method === 'POST') {
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

