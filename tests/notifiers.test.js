import test from 'node:test';
import assert from 'node:assert/strict';
import { PushPlusNotifier, TelegramNotifier } from '../src/notifiers.js';

test('Telegram notifier sends to all selected chat ids', async () => {
  const calls = [];
  const notifier = new TelegramNotifier(
    { botToken: 'token', chatIds: ['1', '2'] },
    async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
  );
  await notifier.send({ title: 'Test', message: 'Message', severity: 'warning' });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.body.chat_id), ['1', '2']);
});

test('PushPlus notifier uses the documented send endpoint and multi-field payload', async () => {
  let call;
  const notifier = new PushPlusNotifier(
    { token: 'token', topic: 'ops', channel: 'wechat' },
    async (url, options) => {
      call = { url, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({ code: 200, msg: 'ok' }), { status: 200 });
    }
  );
  await notifier.send({ title: 'Test', message: 'Message', severity: 'critical' });
  assert.equal(call.url, 'https://www.pushplus.plus/send');
  assert.equal(call.body.topic, 'ops');
  assert.equal(call.body.template, 'html');
});

