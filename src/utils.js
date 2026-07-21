import { createHash, timingSafeEqual } from 'node:crypto';

export function nowISO() {
  return new Date().toISOString();
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function finiteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function nonEmptyString(value) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

export function firstDefined(object, ...keys) {
  for (const key of keys) {
    if (object && object[key] !== undefined && object[key] !== null) return object[key];
  }
  return undefined;
}

export function safeJSONParse(value, fallback = null) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function truncate(value, length = 300) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > length ? `${text.slice(0, length - 1)}...` : text;
}

export function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function secureEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function maskIdentifier(value) {
  const text = String(value || '').trim();
  if (!text) return 'unknown';
  if (text.includes('@')) {
    const [name, domain] = text.split('@');
    const visible = name.length <= 2 ? name[0] || '*' : `${name.slice(0, 2)}***`;
    return `${visible}@${domain}`;
  }
  if (text.length <= 6) return `${text.slice(0, 1)}***`;
  return `${text.slice(0, 3)}***${text.slice(-2)}`;
}

export function escapeHTML(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export async function mapConcurrent(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

