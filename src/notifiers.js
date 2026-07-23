import { escapeHTML, truncate } from './utils.js';
import {
  notificationEventDefinitions,
  notificationEventKey,
  normalizeNotificationEvents,
} from './notification-events.js';

function eventText(event) {
  const lines = [
    `[CPA Status] ${event.title}`,
    event.message,
    `时间: ${event.createdAt || new Date().toISOString()}`,
  ];
  return lines.filter(Boolean).join('\n');
}

export class TelegramNotifier {
  constructor(config, fetchImpl = fetch) {
    this.name = 'telegram';
    this.config = config;
    this.fetch = fetchImpl;
  }

  targets() {
    const targets = Array.isArray(this.config.targets) && this.config.targets.length
      ? this.config.targets
      : [this.config];
    return targets.filter((target) => target.botToken && target.chatIds?.length);
  }

  configured() {
    return this.targets().length > 0;
  }

  targetCount() {
    return this.targets().reduce((total, target) => total + target.chatIds.length, 0);
  }

  async send(event) {
    if (!this.configured()) throw new Error('Telegram is not configured');
    const text = `<b>${escapeHTML(event.title)}</b>\n${escapeHTML(event.message)}`;
    const deliveries = this.targets().flatMap((target) => target.chatIds.map((chatId) => ({
      botToken: target.botToken,
      chatId,
    })));
    const results = await Promise.allSettled(
      deliveries.map(async ({ botToken, chatId }) => {
        const response = await this.fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
          signal: AbortSignal.timeout(15_000),
        });
        const body = await response.text();
        if (!response.ok) throw new Error(`Telegram HTTP ${response.status}: ${truncate(body)}`);
        const parsed = body ? JSON.parse(body) : {};
        if (parsed.ok === false) throw new Error(`Telegram: ${truncate(parsed.description)}`);
      })
    );
    const failed = results.filter((result) => result.status === 'rejected');
    if (failed.length) throw new Error(failed.map((result) => result.reason?.message).join('; '));
  }
}

export class PushPlusNotifier {
  constructor(config, fetchImpl = fetch) {
    this.name = 'pushplus';
    this.config = config;
    this.fetch = fetchImpl;
  }

  targets() {
    const targets = Array.isArray(this.config.targets) && this.config.targets.length
      ? this.config.targets
      : [this.config];
    return targets.filter((target) => target.token);
  }

  configured() {
    return this.targets().length > 0;
  }

  targetCount() {
    return this.targets().length;
  }

  async send(event) {
    if (!this.configured()) throw new Error('PushPlus is not configured');
    const content = [
      `<p>${escapeHTML(event.message)}</p>`,
      `<p><strong>时间：</strong>${escapeHTML(event.createdAt || new Date().toISOString())}</p>`,
    ].join('');
    const results = await Promise.allSettled(this.targets().map(async (target) => {
      const payload = {
        token: target.token,
        title: `[CPA Status] ${event.title}`,
        content,
        template: 'html',
        channel: target.channel || 'wechat',
      };
      if (target.topic) payload.topic = target.topic;
      const response = await this.fetch('https://www.pushplus.plus/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`PushPlus HTTP ${response.status}: ${truncate(body)}`);
      const parsed = body ? JSON.parse(body) : {};
      if (parsed.code !== undefined && Number(parsed.code) !== 200) {
        throw new Error(`PushPlus: ${truncate(parsed.msg || parsed.data || body)}`);
      }
    }));
    const failed = results.filter((result) => result.status === 'rejected');
    if (failed.length) {
      throw new Error(failed.map((result) => result.reason?.message).join('; '));
    }
  }
}

function serverChanEndpoint(sendKey) {
  const key = String(sendKey || '').trim();
  if (key.startsWith('SCT')) {
    return `https://sctapi.ftqq.com/${encodeURIComponent(key)}.send`;
  }
  const sc3 = key.match(/^sctp(\d+)t/);
  if (sc3) {
    return `https://${sc3[1]}.push.ft07.com/send/${encodeURIComponent(key)}.send`;
  }
  throw new Error('ServerChan SendKey must start with SCT or use the sctp{uid}t format');
}

export class ServerChanNotifier {
  constructor(config, fetchImpl = fetch) {
    this.name = 'serverchan';
    this.config = config;
    this.fetch = fetchImpl;
  }

  sendKeys() {
    if (Array.isArray(this.config.sendKeys) && this.config.sendKeys.length) {
      return this.config.sendKeys.filter(Boolean);
    }
    return this.config.sendKey ? [this.config.sendKey] : [];
  }

  configured() {
    return this.sendKeys().length > 0;
  }

  targetCount() {
    return this.sendKeys().length;
  }

  async send(event) {
    if (!this.configured()) throw new Error('ServerChan is not configured');
    const title = `[CPA Status] ${event.title}`.replace(/[\r\n]+/g, ' ').trim();
    const desp = [
      event.message,
      `**时间：** ${event.createdAt || new Date().toISOString()}`,
    ].filter(Boolean).join('\n\n');
    const results = await Promise.allSettled(this.sendKeys().map(async (sendKey) => {
      const response = await this.fetch(serverChanEndpoint(sendKey), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, desp }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`ServerChan HTTP ${response.status}: ${truncate(body)}`);
      let parsed;
      try {
        parsed = body ? JSON.parse(body) : {};
      } catch {
        throw new Error(`ServerChan returned invalid JSON: ${truncate(body)}`);
      }
      if (Number(parsed.code) !== 0) {
        throw new Error(`ServerChan: ${truncate(parsed.message || parsed.data || body)}`);
      }
    }));
    const failed = results.filter((result) => result.status === 'rejected');
    if (failed.length) {
      throw new Error(failed.map((result) => result.reason?.message).join('; '));
    }
  }
}

export class NotificationService {
  constructor(config, store, fetchImpl = fetch) {
    this.store = store;
    this.fetch = fetchImpl;
    this.configure(config);
  }

  configure(config) {
    this.enabled = new Set(config.notifyChannels || []);
    this.events = new Set(normalizeNotificationEvents(config.notifyEvents, []));
    this.notifiers = new Map([
      ['telegram', new TelegramNotifier(config.telegram, this.fetch)],
      ['pushplus', new PushPlusNotifier(config.pushplus, this.fetch)],
      ['serverchan', new ServerChanNotifier(config.serverchan, this.fetch)],
    ]);
  }

  status() {
    return [...this.notifiers.values()].map((notifier) => ({
      name: notifier.name,
      enabled: this.enabled.has(notifier.name),
      configured: notifier.configured(),
      targets: notifier.targetCount(),
    }));
  }

  eventStatus() {
    return notificationEventDefinitions.map((event) => ({
      ...event,
      enabled: this.events.has(event.key),
    }));
  }

  shouldSend(event) {
    return this.events.has(notificationEventKey(event));
  }

  async sendEvent(event) {
    if (!this.shouldSend(event)) return [];
    const selected = [...this.notifiers.values()].filter(
      (notifier) => this.enabled.has(notifier.name) && notifier.configured()
    );
    return Promise.all(
      selected.map(async (notifier) => {
        try {
          await notifier.send(event);
          this.store.recordDelivery(event.id, notifier.name, 'sent');
          return { channel: notifier.name, status: 'sent' };
        } catch (error) {
          this.store.recordDelivery(event.id, notifier.name, 'failed', truncate(error.message, 500));
          return { channel: notifier.name, status: 'failed', error: error.message };
        }
      })
    );
  }

  async test(channels = []) {
    const requested = channels.length ? new Set(channels) : this.enabled;
    const event = {
      title: '通知测试成功',
      message: 'CPA Status 已成功调用该通知渠道。',
      createdAt: new Date().toISOString(),
    };
    const results = [];
    for (const notifier of this.notifiers.values()) {
      if (!requested.has(notifier.name)) continue;
      if (!notifier.configured()) {
        results.push({ channel: notifier.name, status: 'skipped', error: 'not configured' });
        continue;
      }
      try {
        await notifier.send(event);
        this.store.recordDelivery(null, notifier.name, 'test-sent');
        results.push({ channel: notifier.name, status: 'sent' });
      } catch (error) {
        this.store.recordDelivery(null, notifier.name, 'test-failed', truncate(error.message, 500));
        results.push({ channel: notifier.name, status: 'failed', error: error.message });
      }
    }
    return results;
  }
}

export { eventText, serverChanEndpoint };
