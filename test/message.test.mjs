// U2: message format, footer, secrets, sound, Telegram client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderBody, renderFooter, packWithFooter, validateMessage, cleanLabel } from '../server/lib/message.mjs';
import { findSecrets, messageSecrets, makeRedactor } from '../server/lib/secrets.mjs';
import { parseQuietHours, silentFor } from '../server/lib/sound.mjs';
import { createTelegram, resolveApiBase, DEFAULT_API_BASE, NetworkError } from '../server/lib/telegram.mjs';
import { createTools } from '../server/lib/tools.mjs';
import { startFakeTelegram, TEST_TOKEN } from './fake-telegram.mjs';

const SID = '3f2a9c1e-1111-4222-8333-444455556666';
const base = { type: 'info', title: 'Тест', session_id: SID, session_name: 'рефакторинг парсера', basis: 'user_request' };
const at = (hh, mm = 0) => { const d = new Date(2026, 8, 28, hh, mm); return d; };

test('golden: body renders exactly like the tg-notify service', () => {
  const fx = JSON.parse(readFileSync(new URL('./fixtures/service-render.json', import.meta.url), 'utf8'));
  for (const c of fx.cases) {
    const { blocks } = renderBody(c.input, { timezone: fx.timezone, now: new Date(fx.now) });
    assert.deepEqual(blocks, c.blocks, c.input.title);
  }
});

test('AE9: footer carries bot, chat, project folder, short session id and name only', () => {
  const footer = renderFooter({ botUsername: 'my_bot', chatId: 123456789, projectName: 'shop-parser', sessionId: SID, sessionName: 'рефакторинг парсера' });
  const [msg] = packWithFooter(renderBody({ ...base, project: 'WB' }).blocks, footer);
  for (const part of ['@my_bot', '123456789', 'shop-parser', '3f2a9c1e', 'рефакторинг парсера']) assert.ok(msg.includes(part), part);
  assert.ok(!msg.includes(SID), 'full session id must not appear');
  assert.ok(!msg.includes('C:\\') && !msg.includes('/Users/'), 'no full path');
});

test('AE10: required session fields are validated', () => {
  const { session_name, ...noName } = base;
  assert.ok(validateMessage(noName).some((p) => p.startsWith('session_name: обязательное')));
  assert.ok(validateMessage({ ...base, basis: 'because' }).some((p) => p.startsWith('basis:')));
  assert.ok(validateMessage({ ...base, session_id: 'not-a-uuid' }).some((p) => p.startsWith('session_id:')));
  assert.ok(validateMessage({ ...base, session_id: '${CLAUDE_SESSION_ID}' }).some((p) => p.includes('обновите Claude Code')));
  assert.ok(validateMessage({ ...base, session_name: 'x'.repeat(41) }).some((p) => p.startsWith('session_name: не длиннее')));
  assert.deepEqual(validateMessage(base), []);
  assert.ok(validateMessage({ ...base, chat: 'me' }).some((p) => p.startsWith('chat: неизвестное поле')));
});

test('long text: every part fits 4096, carries the footer, keeps entities intact', () => {
  const footer = renderFooter({ botUsername: 'b', chatId: 1, projectName: 'p', sessionId: SID, sessionName: 'имя <&>' });
  assert.ok(footer.includes('имя &lt;&amp;&gt;'), 'session name escaped');
  const multi = renderFooter({ botUsername: 'b', chatId: 1, sessionId: SID, sessionName: ['строка1', 'строка2' + String.fromCharCode(0x2028) + 'x'].join(String.fromCharCode(10)) });
  assert.ok(multi.includes('«строка1 строка2 x»'), 'control chars and newlines collapsed');
  assert.equal(cleanLabel('sessions   list  s'), 'sessions list s');
  const parts = packWithFooter(renderBody({ ...base, text: ('строка <&> '.repeat(80) + '\n').repeat(10) }).blocks, footer);
  assert.ok(parts.length >= 2);
  for (const p of parts) {
    assert.ok(p.length <= 4096, `length ${p.length}`);
    assert.ok(p.endsWith(footer));
    assert.doesNotMatch(p, /&(?!amp;|lt;|gt;|quot;)/);
  }
});

test('secrets in text are detected (R21)', () => {
  assert.deepEqual(findSecrets('обычный отчёт: 1520 строк'), []);
  assert.ok(findSecrets('-----BEGIN OPENSSH PRIVATE KEY-----\nabc').includes('закрытый ключ'));
  assert.ok(findSecrets('token 7012345678:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1').includes('токен Telegram-бота'));
  assert.ok(messageSecrets({ ...base, fields: { key: TEST_TOKEN } }, { botToken: TEST_TOKEN }).includes('токен этого бота'));
  assert.ok(findSecrets('AKIAIOSFODNN7EXAMPLE').includes('ключ AWS'));
});

test('redactor hides token, its URL-encoded form and secret half', () => {
  const r = makeRedactor(TEST_TOKEN);
  const secret = TEST_TOKEN.split(':')[1];
  const out = r(`a ${TEST_TOKEN} b ${encodeURIComponent(TEST_TOKEN)} c ${secret} d https://api.telegram.org/botXYZ/sendMessage`);
  assert.ok(!out.includes(secret) && !out.includes('botXYZ'));
});

test('AE7 + quiet hours rules', () => {
  const q = parseQuietHours('23:00-08:00');
  assert.equal(silentFor({ type: 'warning' }, q, at(2)), true);
  assert.equal(silentFor({ type: 'error', urgent: true }, q, at(2)), false);
  const off = parseQuietHours('off');
  assert.equal(silentFor({ type: 'warning' }, off, at(2)), false);
  assert.equal(silentFor({ type: 'info' }, off, at(12)), true);
  assert.equal(silentFor({ type: 'report' }, off, at(12)), true);
  assert.equal(silentFor({ type: 'info', silent: false }, off, at(12)), false);
  const bad = parseQuietHours('ночью');
  assert.match(bad.warning, /не распознана/);
  assert.equal(silentFor({ type: 'warning' }, bad, at(2)), false, 'an unreadable setting falls back to "off"');
  for (const unset of ['', undefined, '${user_config.quiet_hours}']) {
    const q0 = parseQuietHours(unset);
    assert.equal(q0.enabled, false, `quiet hours are off by default (${unset})`);
    assert.equal(q0.warning, undefined);
  }
  const cross = parseQuietHours('22:00-02:00');
  assert.equal(silentFor({ type: 'warning' }, cross, at(1)), true);
  assert.equal(silentFor({ type: 'warning' }, cross, at(3)), false);
  assert.equal(silentFor({ type: 'warning' }, parseQuietHours('10:00-10:00'), at(10)), false);
});

test('API base override: loopback + test flag only', () => {
  assert.equal(resolveApiBase({}), DEFAULT_API_BASE);
  assert.equal(resolveApiBase({ TGN_API_BASE: 'http://127.0.0.1:9' }), DEFAULT_API_BASE, 'ignored without test flag');
  assert.equal(resolveApiBase({ TGN_API_BASE: 'http://127.0.0.1:9/', TGN_TEST_MODE: '1' }), 'http://127.0.0.1:9');
  assert.throws(() => resolveApiBase({ TGN_API_BASE: 'https://evil.example', TGN_TEST_MODE: '1' }), /только на локальный адрес/);
});

test('client: retries 429, gives up after two retries on 500, redacts token', async () => {
  const fake = await startFakeTelegram();
  try {
    const tg = createTelegram(TEST_TOKEN, { apiBase: fake.url });
    fake.failNext('sendMessage', { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 0 } });
    assert.equal((await tg.sendHtml(1, ['hi'])).length, 1);
    for (let i = 0; i < 3; i++) fake.failNext('sendMessage', { ok: false, error_code: 500, description: `boom ${TEST_TOKEN}` });
    const before = fake.calls.length;
    await assert.rejects(tg.sendHtml(1, ['x']), (e) => !e.message.includes(TEST_TOKEN.split(':')[1]));
    assert.equal(fake.calls.length - before, 3, 'initial call + 2 retries');
  } finally { await fake.close(); }
});

test('client: network failure message has no token', async () => {
  const tg = createTelegram(TEST_TOKEN, { apiBase: 'http://127.0.0.1:1', maxRetries: 0 });
  await assert.rejects(tg.call('getMe'), (e) => {
    assert.ok(!e.message.includes(TEST_TOKEN.split(':')[1]));
    assert.match(e.message, /api\.telegram\.org/);
    return true;
  });
});

// Slow Bot API: answers every request only after delayMs.
async function startSlowTelegram(delayMs) {
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain body */ }
    setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, result: { message_id: 7 } })); }, delayMs);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); } };
}

test('client: sendDocument timeout scales with payload, plain calls keep the short default', async () => {
  const slow = await startSlowTelegram(300);
  try {
    const tg = createTelegram(TEST_TOKEN, { apiBase: slow.url, timeoutMs: 100, maxRetries: 0 });
    await assert.rejects(tg.call('sendMessage', { chat_id: 1, text: 'x' }), (e) => e instanceof NetworkError && /нет ответа за 0\.1 с/.test(e.message));
    assert.equal((await tg.call('sendMessage', { chat_id: 1, text: 'x' }, { timeoutMs: 2000 })).message_id, 7, 'per-call override');
    assert.equal(await tg.sendDocument(1, { data: Buffer.from('hello'), filename: 'a.txt' }), 7, 'upload gets a longer timeout');
    const small = tg.documentTimeoutMs(1024);
    const big = tg.documentTimeoutMs(50 * 1024 * 1024);
    assert.ok(small >= 120_000, `floor ${small}`);
    assert.ok(big - small >= 799_000, `50 MB at 64 KB/s needs ~800 s more: ${big}`);
  } finally { await slow.close(); }
});

test('send_telegram_file: upload failure after header parts reports delivered message_ids', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tgn-'));
  try {
    const path = join(dir, 'report.txt');
    writeFileSync(path, 'data');
    const tg = {
      sendHtml: async (_chat, parts) => parts.map((_, i) => 501 + i),
      sendDocument: async () => { throw new NetworkError(`Не удалось связаться с api.telegram.org (нет ответа). bot${TEST_TOKEN}`); },
    };
    const tools = createTools({
      tg, state: { journal() {}, warnings: [] }, pairing: { currentBinding: () => ({ chat_id: 1, bot_username: 'b', username: 'ivan' }) },
      quiet: parseQuietHours('off'), projectName: 'p', redact: makeRedactor(TEST_TOKEN), botToken: TEST_TOKEN, dataDir: join(dir, 'data'),
    });
    const r = await tools.call('send_telegram_file', { ...base, path, text: 'длинный текст '.repeat(120) });
    assert.equal(r.isError, true);
    const text = r.content[0].text;
    assert.match(text, /уже доставлен/);
    assert.match(text, /501/);
    assert.match(text, /не отправлен|не удалось/i);
    assert.ok(!text.includes(TEST_TOKEN.split(':')[1]), 'token redacted');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
