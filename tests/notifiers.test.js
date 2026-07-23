import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NotificationService,
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
  await notifier.send({ title: 'Test', message: 'Message' });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.body.chat_id), ['1', '2']);
});

test('Telegram notifier supports multiple bot credentials', async () => {
  const calls = [];
  const notifier = new TelegramNotifier(
    {
      targets: [
        { botToken: 'first', chatIds: ['1'] },
        { botToken: 'second', chatIds: ['2', '3'] },
      ],
    },
    async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
  );
  await notifier.send({ title: 'Test', message: 'Message' });
  assert.deepEqual(calls.map((call) => call.url), [
    'https://api.telegram.org/botfirst/sendMessage',
    'https://api.telegram.org/botsecond/sendMessage',
    'https://api.telegram.org/botsecond/sendMessage',
  ]);
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
  await notifier.send({ title: 'Test', message: 'Message' });
  assert.equal(call.url, 'https://www.pushplus.plus/send');
  assert.equal(call.body.topic, 'ops');
  assert.equal(call.body.template, 'html');
});

test('PushPlus notifier sends through every configured token', async () => {
  const tokens = [];
  const notifier = new PushPlusNotifier(
    {
      targets: [
        { token: 'first', topic: '', channel: 'wechat' },
        { token: 'second', topic: 'team', channel: 'wechat' },
      ],
    },
    async (url, options) => {
      tokens.push(JSON.parse(options.body).token);
      return new Response(JSON.stringify({ code: 200, msg: 'ok' }), { status: 200 });
    }
  );
  await notifier.send({ title: 'Test', message: 'Message' });
  assert.deepEqual(tokens, ['first', 'second']);
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
  await notifier.send({ title: 'Test\nTitle', message: 'Message' });
  assert.equal(call.url, 'https://sctapi.ftqq.com/SCT123456.send');
  assert.equal(call.body.title, '[CPA Status] Test Title');
  assert.doesNotMatch(call.body.desp, /级别/);
});

test('ServerChan derives the documented ServerChan 3 endpoint from an sctp key', () => {
  assert.equal(
    serverChanEndpoint('sctp123tabcdef'),
    'https://123.push.ft07.com/send/sctp123tabcdef.send'
  );
  assert.throws(() => serverChanEndpoint('invalid'), /must start with SCT/);
});

test('ServerChan notifier sends through every configured SendKey', async () => {
  const urls = [];
  const notifier = new ServerChanNotifier(
    { sendKeys: ['SCTfirst', 'sctp321tsecond'] },
    async (url) => {
      urls.push(url);
      return new Response(JSON.stringify({ code: 0 }), { status: 200 });
    }
  );
  await notifier.send({ title: 'Test', message: 'Message' });
  assert.deepEqual(urls, [
    'https://sctapi.ftqq.com/SCTfirst.send',
    'https://321.push.ft07.com/send/sctp321tsecond.send',
  ]);
});

test('NotificationService filters exact event keys instead of severity levels', async () => {
  const calls = [];
  const deliveries = [];
  const service = new NotificationService({
    notifyChannels: ['telegram'],
    notifyEvents: ['account_auth_invalid'],
    telegram: { botToken: 'token', chatIds: ['1'] },
    pushplus: {},
    serverchan: {},
  }, {
    recordDelivery(...args) { deliveries.push(args); },
  }, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });

  await service.sendEvent({
    id: 1,
    type: 'account_state_changed',
    title: '认证失效',
    message: 'HTTP 401',
    payload: { currentState: 'auth_invalid' },
  });
  await service.sendEvent({
    id: 2,
    type: 'account_state_changed',
    title: '状态未知',
    message: 'context canceled',
    payload: { currentState: 'unknown' },
  });

  assert.equal(calls.length, 1);
  assert.equal(deliveries.length, 1);
  assert.doesNotMatch(calls[0].body.text, /级别/);
  assert.equal(service.eventStatus().find((event) => event.key === 'account_auth_invalid').enabled, true);
  assert.equal(service.eventStatus().find((event) => event.key === 'account_unknown').enabled, false);
});
