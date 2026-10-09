// Minimal Telegram Bot API client.
// Copied from tg-notify service lib/telegram.mjs (commit 8c18a3f) and adapted:
// shorter timeouts (KTD13), token redaction on every error (KTD10), guarded API base (KTD16),
// documents sent from an in-memory buffer read by the file checker (KTD11).
import { htmlToText } from './message.mjs';
import { makeRedactor } from './secrets.mjs';

export const DEFAULT_API_BASE = 'https://api.telegram.org';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export class TelegramError extends Error {
  constructor(method, data, redact) {
    super(redact(`${method}: ${data.description || 'неизвестная ошибка'}`));
    this.method = method;
    this.code = data.error_code;
    this.retryAfter = data.parameters?.retry_after;
    this.description = redact(data.description || '');
  }
}

export class NetworkError extends Error {}

// The API base may be overridden only for tests: loopback host AND explicit test flag.
export function resolveApiBase(env = process.env) {
  const override = env.TGN_API_BASE;
  if (!override || env.TGN_TEST_MODE !== '1') return DEFAULT_API_BASE;
  let host;
  try { host = new URL(override).hostname; } catch { host = null; }
  if (!host || !LOOPBACK.has(host)) {
    throw new Error('Подмена адреса Telegram API разрешена только на локальный адрес (127.0.0.1, localhost, ::1) — отправка остановлена, чтобы токен не ушёл на чужой сервер.');
  }
  return override.replace(/\/+$/, '');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createTelegram(token, { apiBase = DEFAULT_API_BASE, maxRetries = 2, timeoutMs = 20_000, maxRetryWaitMs = 30_000 } = {}) {
  const redact = makeRedactor(token);
  const base = `${apiBase}/bot${token}`;

  // opts.timeoutMs overrides the per-request timeout (used for uploads).
  async function call(method, payload, { timeoutMs: callTimeoutMs = timeoutMs } = {}) {
    for (let attempt = 0; ; attempt++) {
      const isForm = payload instanceof FormData;
      let res;
      try {
        res = await fetch(`${base}/${method}`, {
          method: 'POST',
          headers: isForm ? undefined : { 'content-type': 'application/json' },
          body: isForm ? payload : JSON.stringify(payload ?? {}),
          signal: AbortSignal.timeout(callTimeoutMs),
        });
      } catch (e) {
        // Retry quick connection failures once in a while; a timeout already cost timeoutMs, so fail fast.
        if (e?.name !== 'TimeoutError' && attempt < maxRetries) { await sleep(1000 * (attempt + 1)); continue; }
        const reason = e?.name === 'TimeoutError' ? `нет ответа за ${callTimeoutMs / 1000} с` : (e?.cause?.code || e?.message || 'ошибка сети');
        throw new NetworkError(redact(`Не удалось связаться с api.telegram.org (${reason}). Проверьте интернет; в некоторых сетях api.telegram.org недоступен.`));
      }
      const data = await res.json().catch(() => ({ ok: false, error_code: res.status, description: `HTTP ${res.status}` }));
      if (data.ok) return data.result;
      const err = new TelegramError(method, data, redact);
      const retriable = err.code === 429 || (err.code >= 500 && err.code < 600);
      if (!retriable || attempt >= maxRetries) throw err;
      await sleep(Math.min(((err.retryAfter ?? 2 ** attempt) + 0.5) * 1000, maxRetryWaitMs));
    }
  }

  const isParseError = (e) => e.code === 400 && /parse|entit/i.test(e.description);

  // messages: already-rendered HTML strings, each ≤ 4096 chars.
  async function sendHtml(chatId, messages, { silent } = {}) {
    const ids = [];
    for (const html of messages) {
      const body = { chat_id: chatId, text: html, parse_mode: 'HTML', disable_notification: !!silent, link_preview_options: { is_disabled: true } };
      try {
        ids.push((await call('sendMessage', body)).message_id);
      } catch (e) {
        if (!isParseError(e)) throw e;
        delete body.parse_mode;
        body.text = htmlToText(html);
        ids.push((await call('sendMessage', body)).message_id);
      }
    }
    return ids;
  }

  // Uploads up to 50 MB must not share the 20 s request timeout: allow at least 2 minutes
  // plus one second per 64 KB (a conservative ~0.5 Mbit/s uplink).
  const documentTimeoutMs = (bytes) => Math.max(timeoutMs, 120_000 + Math.ceil(bytes / (64 * 1024)) * 1000);

  async function sendDocument(chatId, { data, filename }, { caption, silent } = {}) {
    const form = new FormData();
    form.set('chat_id', String(chatId));
    form.set('disable_notification', String(!!silent));
    if (caption) { form.set('caption', caption); form.set('parse_mode', 'HTML'); }
    form.set('document', new Blob([data]), filename);
    return (await call('sendDocument', form, { timeoutMs: documentTimeoutMs(data.length) })).message_id;
  }

  return { call, sendHtml, sendDocument, documentTimeoutMs, redact };
}
