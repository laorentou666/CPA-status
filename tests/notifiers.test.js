import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PushPlusNotifier,
  ServerChanNotifier,
  TelegramNotifier,
  serverChanEndpoint,
} from '../src/notifiers.js';

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

test('ServerChan notifier follows the documented SCT endpoint and payload', async () => {
  let call;
  const notifier = new ServerChanNotifier(
    { sendKey: 'SCT123456' },
    async (url, options) => {
      call = { url, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({ code: 0, data: { pushid: '1' } }), { status: 200 });
    }
  );
  await notifier.send({ title: 'Test\nTitle', message: 'Message', severity: 'warning' });
  assert.equal(call.url, 'https://sctapi.ftqq.com/SCT123456.send');
  assert.equal(call.body.title, '[CPA Status] Test Title');
  assert.match(call.body.desp, /\*\*级别：\*\* warning/);
});

test('ServerChan derives the documented ServerChan 3 endpoint from an sctp key', () => {
  assert.equal(
    serverChanEndpoint('sctp123tabcdef'),
    'https://123.push.ft07.com/send/sctp123tabcdef.send'
  );
  assert.throws(() => serverChanEndpoint('invalid'), /must start with SCT/);
});
