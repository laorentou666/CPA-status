import { escapeHTML, truncate } from './utils.js';

const severityRank = { info: 1, warning: 2, critical: 3 };

function eventText(event) {
  const lines = [
    `[CPA Status] ${event.title}`,
    event.message,
    `级别: ${event.severity}`,
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

  configured() {
    return Boolean(this.config.botToken && this.config.chatIds?.length);
  }

  async send(event) {
    if (!this.configured()) throw new Error('Telegram is not configured');
    const url = `https://api.telegram.org/bot${this.config.botToken}/sendMessage`;
    const text = `<b>${escapeHTML(event.title)}</b>\n${escapeHTML(event.message)}\n\n级别: ${escapeHTML(event.severity)}`;
    const results = await Promise.allSettled(
      this.config.chatIds.map(async (chatId) => {
        const response = await this.fetch(url, {
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

  configured() {
    return Boolean(this.config.token);
  }

  async send(event) {
    if (!this.configured()) throw new Error('PushPlus is not configured');
    const content = [
      `<p>${escapeHTML(event.message)}</p>`,
      `<p><strong>级别：</strong>${escapeHTML(event.severity)}</p>`,
      `<p><strong>时间：</strong>${escapeHTML(event.createdAt || new Date().toISOString())}</p>`,
    ].join('');
    const payload = {
      token: this.config.token,
      title: `[CPA Status] ${event.title}`,
      content,
      template: 'html',
      channel: this.config.channel || 'wechat',
    };
    if (this.config.topic) payload.topic = this.config.topic;
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
  }
}

export class NotificationService {
  constructor(config, store, fetchImpl = fetch) {
    this.store = store;
    this.enabled = new Set(config.notifyChannels || []);
    this.minimumSeverity = config.notifyMinSeverity || 'warning';
    this.notifiers = new Map([
      ['telegram', new TelegramNotifier(config.telegram, fetchImpl)],
      ['pushplus', new PushPlusNotifier(config.pushplus, fetchImpl)],
    ]);
  }

  status() {
    return [...this.notifiers.values()].map((notifier) => ({
      name: notifier.name,
      enabled: this.enabled.has(notifier.name),
      configured: notifier.configured(),
    }));
  }

  shouldSend(event) {
    if (event.type === 'account_recovered' || event.type === 'cpa_recovered') return true;
    return (severityRank[event.severity] || 0) >= (severityRank[this.minimumSeverity] || 2);
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
      severity: 'info',
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

export { eventText };
