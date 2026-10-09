// Local token setup page: a one-off web form on 127.0.0.1 where the user pastes the bot token in the
// browser, so the token never travels through the chat with Claude. The address carries a random
// secret path; the Host and Origin checks keep other web pages from reading or posting to the form.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { escapeHtml } from './message.mjs';

export const SETUP_TTL_MS = 15 * 60 * 1000;
const MAX_BODY = 8 * 1024;

const HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
};

const page = (body) => `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Токен бота · tg-ai-notify-lite</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f7f9; --card: #fff; --text: #1d2129; --muted: #5f6673; --accent: #2b7de9; --err: #c62828; --ok: #2e7d32; --border: #d9dde3; }
  @media (prefers-color-scheme: dark) { :root { --bg: #15171a; --card: #1f2226; --text: #e8eaed; --muted: #a0a6b0; --border: #33373d; --accent: #5aa0ff; --err: #ef6b6b; --ok: #6cc070; } }
  body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 520px; margin: 48px auto; padding: 0 16px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 12px; }
  ol { padding-left: 20px; color: var(--muted); }
  input { width: 100%; box-sizing: border-box; padding: 10px 12px; font: 15px ui-monospace, Consolas, monospace; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--text); }
  button { margin-top: 12px; padding: 10px 18px; font-size: 15px; border: 0; border-radius: 8px; background: var(--accent); color: #fff; cursor: pointer; }
  a { color: var(--accent); } li { margin: 4px 0; }
  .err { color: var(--err); } .ok { color: var(--ok); } .muted { color: var(--muted); font-size: 14px; }
</style></head><body><main><div class="card">${body}</div></main></body></html>`;

const form = (error = '') => page(`
<h1>Подключите своего Telegram-бота</h1>
<p class="muted">Бот — это ваш личный «почтальон»: через него Claude будет присылать вам сообщения. Создать его бесплатно и займёт 2 минуты.</p>
<ol>
  <li>Откройте <a href="https://t.me/BotFather" target="_blank" rel="noopener"><b>@BotFather</b></a> — официальный бот Telegram для создания ботов (синяя галочка) — и нажмите <b>Start</b>.</li>
  <li>Отправьте ему команду <code>/newbot</code>.</li>
  <li>Он спросит <b>имя</b> — любое, например <i>Мои уведомления</i>.</li>
  <li>Затем <b>адрес</b> — латиницей, в конце обязательно <code>bot</code>, например <code>ivan_notify_bot</code>. Если адрес занят, придумайте другой.</li>
  <li>BotFather пришлёт сообщение с <b>токеном</b> — строкой вида <code>123456789:AAH…</code> после слов «Use this token to access the HTTP API». Нажмите на неё, чтобы скопировать.</li>
  <li>Вставьте токен в поле ниже и нажмите «Сохранить».</li>
</ol>
<p class="muted">Уже есть бот? В @BotFather: <code>/mybots</code> → ваш бот → <b>API Token</b>. Лучше завести отдельного бота только для Claude.</p>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
<form method="post" autocomplete="off">
  <input name="token" type="password" placeholder="123456789:AAH…" required autofocus spellcheck="false">
  <button type="submit">Сохранить</button>
</form>
<p class="muted">Токен — как пароль от бота: никому его не пересылайте. Он сохранится на этом компьютере в папке данных плагина и в чат с Claude не попадёт.</p>`);

const done = (botUsername) => page(`
<h1 class="ok">Готово</h1>
<p>Плагин подключён к боту <b>@${escapeHtml(botUsername)}</b>. Эту вкладку можно закрыть.</p>
<p>Вернитесь в Claude и попросите прислать что-нибудь в Telegram — Claude предложит привязать ваш чат.</p>`);

// apply(rawToken) checks the token with Telegram and saves it; it resolves to { botUsername } or { error }.
export function createSetupPage({ apply, ttlMs = SETUP_TTL_MS, onClose = () => {} }) {
  let current = null;

  async function open() {
    if (current) return current.info;
    const secret = randomBytes(16).toString('hex');
    const server = createServer((req, res) => handle(req, res).catch(() => { if (!res.headersSent) { res.writeHead(500, HEADERS); } res.end(); }));
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    const path = `/${secret}`;
    const url = `http://127.0.0.1:${port}${path}`;
    const expiresAt = Date.now() + ttlMs;
    const timer = setTimeout(close, ttlMs);
    timer.unref?.();

    async function handle(req, res) {
      const send = (status, html) => { res.writeHead(status, HEADERS); res.end(html); };
      if (!allowedHosts.has(req.headers.host ?? '') || req.url !== path) return send(404, page('<p>Страница не найдена.</p>'));
      if (req.method === 'GET') return send(200, form());
      if (req.method !== 'POST') return send(405, page('<p>Метод не поддерживается.</p>'));
      const origin = req.headers.origin;
      if (origin && origin !== 'null' && !allowedHosts.has(origin.replace(/^http:\/\//, ''))) return send(403, page('<p>Запрос отклонён.</p>'));
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > MAX_BODY) return send(413, page('<p>Слишком длинный запрос.</p>'));
      }
      const token = new URLSearchParams(raw).get('token') ?? '';
      const result = await apply(token);
      if (result.error) return send(200, form(result.error));
      send(200, done(result.botUsername));
      setTimeout(close, 1000).unref?.();
    }

    function close() {
      if (!current || current.server !== server) return;
      clearTimeout(timer);
      current = null;
      server.close();
      server.closeAllConnections?.();
      onClose();
    }

    current = { server, close, info: { url, expires_at: new Date(expiresAt).toISOString() } };
    return current.info;
  }

  return { open, close: () => current?.close(), get isOpen() { return !!current; } };
}
