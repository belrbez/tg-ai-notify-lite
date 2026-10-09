// U4: MCP server over stdio, tools, file checks — against the fake Telegram API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, linkSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { checkFile, FileRefused } from '../server/lib/files.mjs';
import { startFakeTelegram, TEST_TOKEN } from './fake-telegram.mjs';

const SID = '3f2a9c1e-1111-4222-8333-444455556666';
const ME = 555001;
const INDEX = new URL('../server/index.mjs', import.meta.url);
const msg = (extra = {}) => ({ type: 'success', title: 'Итог рефакторинга', session_id: SID, session_name: 'рефакторинг парсера', basis: 'user_request', ...extra });

let fake, root;

// Minimal MCP client: spawns the server over stdio.
function startServer({ env = {}, preload, dataDir = join(root, 'data-' + Math.random().toString(36).slice(2)) } = {}) {
  const projectDir = join(root, 'shop-parser');
  mkdirSync(projectDir, { recursive: true });
  const args = preload ? ['--input-type=module', '-e', `${preload}; await import(${JSON.stringify(INDEX.href)});`] : [INDEX.pathname.replace(/^\/([A-Za-z]:)/, '$1')];
  const child = spawn(process.execPath, args, {
    env: { ...process.env, TGN_BOT_TOKEN: TEST_TOKEN, TGN_API_BASE: fake.url, TGN_TEST_MODE: '1', TGN_DATA_DIR: dataDir, TGN_PROJECT_DIR: projectDir, TGN_QUIET_HOURS: 'off', ...env },
  });
  let buf = '', stderr = '', nextId = 1;
  const pending = new Map();
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    }
  });
  const rpc = (method, params) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const call = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result;
  const text = (r) => r.content[0].text;
  const ready = rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  return { child, rpc, call, text, ready, dataDir, projectDir, stderr: () => stderr, stop: () => child.kill() };
}

// The last pairing code the bot sent to a chat, as the user would read it in Telegram.
const codeFor = (chatId) => /<b>(\d{6})<\/b>/.exec(fake.sends().filter((x) => x.body.chat_id === chatId && /Код (пере)?привязки/.test(x.body.text)).at(-1)?.body.text ?? '')?.[1];

async function bind(s, { code } = {}) {
  await s.ready;
  await s.call('telegram_pair_start', { session_id: SID, session_name: 'рефакторинг парсера' });
  fake.addMessage({ chatId: ME, text: `/start ${SID}` });
  const check = s.text(await s.call('telegram_pair_check', { session_id: SID }));
  const ref = /candidate_ref: (\S+)/.exec(check)[1];
  return s.call('telegram_pair_confirm', { session_id: SID, candidate_ref: ref, code: code ?? codeFor(ME) });
}

// Talks to the local setup page like a browser would.
async function setupRequest(url, { method = 'GET', token, headers = {} } = {}) {
  const res = await fetch(url, { method, headers: token === undefined ? headers : { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: token === undefined ? undefined : new URLSearchParams({ token }) });
  return { status: res.status, html: await res.text(), headers: res.headers };
}

before(async () => { fake = await startFakeTelegram(); root = mkdtempSync(join(tmpdir(), 'tgn-srv-')); });
after(async () => { await fake.close(); });

test('tools/list returns seven tools with the explicit-request rule and session fields', async () => {
  const s = startServer();
  try {
    await s.ready;
    const { tools } = (await s.rpc('tools/list')).result;
    assert.deepEqual(tools.map((t) => t.name), ['send_telegram_message', 'send_telegram_file', 'telegram_status', 'telegram_setup', 'telegram_pair_start', 'telegram_pair_check', 'telegram_pair_confirm']);
    assert.ok(tools.at(-1).inputSchema.required.includes('code'));
    const send = tools[0];
    assert.match(send.description, /ТОЛЬКО если пользователь явно попросил/);
    assert.match(send.description, /Никогда не придумывай ID/);
    for (const f of ['session_id', 'session_name', 'basis']) assert.ok(send.inputSchema.required.includes(f), f);
  } finally { s.stop(); }
});

test('AE6: send without binding returns НЕ_ПРИВЯЗАН immediately, no getUpdates, no waiting', async () => {
  const s = startServer();
  try {
    await s.ready;
    const before = fake.calls.length;
    const t0 = Date.now();
    const r = await s.call('send_telegram_message', msg());
    assert.equal(r.isError, true);
    assert.match(s.text(r), /^НЕ_ПРИВЯЗАН/);
    assert.ok(Date.now() - t0 < 2000);
    assert.equal(fake.calls.slice(before).filter((c) => c.method === 'getUpdates').length, 0);
  } finally { s.stop(); }
});

test('pair_start shows a clear "go to the link" button; the bound chat gets a list of commands', async () => {
  const s = startServer();
  try {
    await s.ready;
    const started = s.text(await s.call('telegram_pair_start', { session_id: SID, session_name: 'x' }));
    assert.match(started, /Перейдите по ссылке и нажмите Start/);
    assert.match(started, /\[▶ Запустить Telegram-бота @test_notify_bot\]\(https:\/\/t\.me\/test_notify_bot\?start=/);
    assert.match(started, /не дожидаясь ответа, вызови telegram_pair_check/);
    fake.addMessage({ chatId: ME, text: `/start ${SID}` });
    const ref = /candidate_ref: (\S+)/.exec(s.text(await s.call('telegram_pair_check', { session_id: SID })))[1];
    const done = await s.call('telegram_pair_confirm', { session_id: SID, candidate_ref: ref, code: codeFor(ME) });
    assert.ok(!done.isError, s.text(done));
    const welcome = fake.sends().filter((x) => x.body.chat_id === ME && /Этот чат привязан/.test(x.body.text)).at(-1).body.text;
    for (const cmd of ['пришли в тг', 'файл', 'каждый час', 'без звука', 'статус', 'смени токен', '/tg-ai-notify-lite:rebind']) assert.ok(welcome.includes(cmd), cmd);
  } finally { s.stop(); }
});

test('pairing with the code from Telegram, then send with footer; journal has basis but no text or token', async () => {
  const s = startServer();
  try {
    const confirmed = await bind(s);
    assert.ok(!confirmed.isError, s.text(confirmed));
    const r = await s.call('send_telegram_message', msg({ text: 'Секретного тут нет, просто итог' }));
    assert.ok(!r.isError, s.text(r));
    const sent = fake.sends().at(-1).body;
    assert.equal(sent.chat_id, ME);
    for (const part of ['@test_notify_bot', String(ME), 'shop-parser', '3f2a9c1e', 'рефакторинг парсера']) assert.ok(sent.text.includes(part), part);
    const journal = readFileSync(join(s.dataDir, 'journal.log'), 'utf8');
    assert.match(journal, /"basis":"user_request"/);
    assert.ok(!journal.includes('просто итог'));
    assert.ok(!journal.includes(TEST_TOKEN.split(':')[1]));
  } finally { s.stop(); }
});

test('AE12: a wrong or missing code never binds, and the check result does not reveal the code', async () => {
  const s = startServer();
  try {
    const r = await bind(s, { code: '000000' === codeFor(ME) ? '111111' : '000000' });
    assert.equal(r.isError, true);
    assert.match(s.text(r), /не совпал/);
    const st = s.text(await s.call('telegram_status', {}));
    assert.match(st, /Чат не привязан/);
  } finally { s.stop(); }
});

// --- Token setup page ---

test('no token: tools explain and offer the setup page; the page saves a valid token and the plugin works without restart', async () => {
  const s = startServer({ env: { TGN_BOT_TOKEN: '${user_config.bot_token}' } });
  try {
    await s.ready;
    const refused = await s.call('send_telegram_message', msg());
    assert.equal(refused.isError, true);
    assert.match(s.text(refused), /не подставлен/);
    assert.match(s.text(refused), /telegram_setup/);

    const opened = s.text(await s.call('telegram_setup', {}));
    const url = /(http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32})/.exec(opened)[1];
    assert.equal((await s.call('telegram_setup', {})).content[0].text.includes(url), true, 'a second call reuses the open page');

    const form = await setupRequest(url);
    assert.equal(form.status, 200);
    assert.match(form.html, /@BotFather/);
    assert.match(form.headers.get('content-security-policy'), /default-src 'none'/);

    const bad = await setupRequest(url, { method: 'POST', token: 'not-a-token' });
    assert.match(bad.html, /выглядит неправильно/);
    fake.failNext('getMe', { ok: false, error_code: 401, description: 'Unauthorized' });
    const rejected = await setupRequest(url, { method: 'POST', token: TEST_TOKEN });
    assert.match(rejected.html, /не принял этот токен/);
    assert.ok(!rejected.html.includes(TEST_TOKEN.split(':')[1]));

    const ok = await setupRequest(url, { method: 'POST', token: ` bot${TEST_TOKEN} ` });
    assert.match(ok.html, /@test_notify_bot/);
    assert.ok(!ok.html.includes(TEST_TOKEN.split(':')[1]));
    assert.equal(JSON.parse(readFileSync(join(s.dataDir, 'token.json'), 'utf8')).token, TEST_TOKEN);

    const st = s.text(await s.call('telegram_status', {}));
    assert.match(st, /задан на странице настройки/);
    assert.ok(!st.includes(TEST_TOKEN.split(':')[1]));
    const bound = await bind(s);
    assert.ok(!bound.isError, s.text(bound));
  } finally { s.stop(); }
});

test('setup page: wrong secret path, foreign Host and foreign Origin are refused', async () => {
  const s = startServer({ env: { TGN_BOT_TOKEN: '' } });
  try {
    await s.ready;
    const url = /(http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32})/.exec(s.text(await s.call('telegram_setup', {})))[1];
    const origin = new URL(url).origin;
    assert.equal((await setupRequest(`${origin}/wrong`)).status, 404);
    // fetch cannot override Host (DNS rebinding case), so use a raw request.
    const rebound = await new Promise((resolve, reject) => {
      const u = new URL(url);
      httpRequest({ host: '127.0.0.1', port: u.port, path: u.pathname, headers: { host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject).end();
    });
    assert.equal(rebound, 404);
    const csrf = await setupRequest(url, { method: 'POST', token: TEST_TOKEN, headers: { origin: 'https://evil.example' } });
    assert.equal(csrf.status, 403);
    assert.ok(!existsSync(join(s.dataDir, 'token.json')));
  } finally { s.stop(); }
});

test('a token saved on the setup page wins over the plugin setting after restart', async () => {
  const dataDir = join(root, 'data-saved-' + Math.random().toString(36).slice(2));
  const first = startServer({ env: { TGN_BOT_TOKEN: '' }, dataDir });
  try {
    await first.ready;
    const url = /(http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32})/.exec(first.text(await first.call('telegram_setup', {})))[1];
    await setupRequest(url, { method: 'POST', token: TEST_TOKEN });
  } finally { first.stop(); }
  const second = startServer({ env: { TGN_BOT_TOKEN: '7654321:AAanotherpluginsettingtoken_abcdefghij' }, dataDir });
  try {
    await second.ready;
    const st = second.text(await second.call('telegram_status', {}));
    assert.match(st, /задан на странице настройки/);
    assert.ok(!st.includes('anotherpluginsettingtoken'));
  } finally { second.stop(); }
});

test('AE11 over the wire: .env refused, normal file sent as a document with footer in caption', async () => {
  const s = startServer();
  try {
    await bind(s);
    const env = join(s.projectDir, '.env');
    writeFileSync(env, 'X=1');
    const refused = await s.call('send_telegram_file', msg({ path: env }));
    assert.equal(refused.isError, true);
    assert.match(s.text(refused), /похож на секрет/);
    const report = join(s.projectDir, 'отчёт.xlsx');
    writeFileSync(report, 'fake xlsx content');
    const ok = await s.call('send_telegram_file', msg({ path: report, type: 'report', title: 'Выгрузка' }));
    assert.ok(!ok.isError, s.text(ok));
    const doc = fake.sends().at(-1);
    assert.equal(doc.method, 'sendDocument');
    assert.match(doc.body.multipart, /filename="отчёт.xlsx"/);
    assert.match(doc.body.multipart, /3f2a9c1e/);
  } finally { s.stop(); }
});

test('long caption: message with footer first, then file with footer in caption', async () => {
  const s = startServer();
  try {
    await bind(s);
    const report = join(s.projectDir, 'big-caption.txt');
    writeFileSync(report, 'data');
    const before = fake.sends().length;
    const r = await s.call('send_telegram_file', msg({ path: report, text: 'подробности '.repeat(200) }));
    assert.ok(!r.isError, s.text(r));
    const [first, second] = fake.sends().slice(before);
    assert.equal(first.method, 'sendMessage');
    assert.match(first.body.text, /3f2a9c1e/);
    assert.equal(second.method, 'sendDocument');
    assert.match(second.body.multipart, /📎/);
    assert.match(second.body.multipart, /3f2a9c1e/);
  } finally { s.stop(); }
});

test('secret in message text is refused; dry_run works unbound; status hides token', async () => {
  const s = startServer();
  try {
    await s.ready;
    const dry = await s.call('send_telegram_message', msg({ dry_run: true }));
    assert.match(s.text(dry), /Предпросмотр/);
    const secret = await s.call('send_telegram_message', msg({ text: `вот токен ${TEST_TOKEN}` }));
    assert.equal(secret.isError, true);
    assert.match(s.text(secret), /похоже на секрет/);
    assert.ok(!s.text(secret).includes(TEST_TOKEN.split(':')[1]));
    const st = s.text(await s.call('telegram_status', { session_id: SID }));
    assert.match(st, /Чат не привязан/);
    assert.ok(!st.includes(TEST_TOKEN.split(':')[1]));
  } finally { s.stop(); }
});

test('Telegram error with token in description is redacted in result', async () => {
  const s = startServer();
  try {
    await bind(s);
    fake.failNext('sendMessage', { ok: false, error_code: 400, description: `chat not found for ${TEST_TOKEN}` });
    const r = await s.call('send_telegram_message', msg());
    assert.equal(r.isError, true);
    assert.ok(!s.text(r).includes(TEST_TOKEN.split(':')[1]));
    assert.ok(!s.stderr().includes(TEST_TOKEN.split(':')[1]));
  } finally { s.stop(); }
});

test('empty and unsubstituted token → Russian error that points to the setup page', async () => {
  for (const tok of ['', '${user_config.bot_token}']) {
    const s = startServer({ env: { TGN_BOT_TOKEN: tok } });
    try {
      await s.ready;
      const r = await s.call('send_telegram_message', msg());
      assert.equal(r.isError, true);
      assert.match(s.text(r), /Токен бота не (задан|подставлен)/);
      assert.match(s.text(r), /сам токен в чате не проси/);
    } finally { s.stop(); }
  }
});

test('AE8-like: Node older than 22 answers with an install message', async () => {
  const s = startServer({ preload: "Object.defineProperty(process.versions, 'node', { value: '18.20.0' })" });
  try {
    const init = await s.ready;
    assert.match(init.result.instructions, /Node\.js 22/);
    const r = await s.call('send_telegram_message', msg());
    assert.equal(r.isError, true);
    assert.match(s.text(r), /nodejs\.org/);
  } finally { s.stop(); }
});

test('startup failure (data folder cannot be created) still answers initialize and explains in Russian', { timeout: 15000 }, async () => {
  const blocker = join(root, 'blocker-file-' + Math.random().toString(36).slice(2));
  writeFileSync(blocker, 'x');
  for (const env of [{ TGN_DATA_DIR: join(blocker, 'sub') }, { TGN_DATA_DIR: '', CLAUDE_PLUGIN_DATA: '' }]) {
    const s = startServer({ env });
    try {
      const init = await s.ready;
      assert.ok(init.result, JSON.stringify(init));
      const { tools } = (await s.rpc('tools/list')).result;
      assert.equal(tools.length, 7);
      const r = await s.call('send_telegram_message', msg());
      assert.equal(r.isError, true);
      assert.match(s.text(r), /не запустился/);
      assert.match(s.text(r), /папк[уаи] данных/);
      assert.match(s.text(r), /[Пп]ереустановите плагин/);
      assert.ok(!s.text(r).includes(TEST_TOKEN.split(':')[1]));
    } finally { s.stop(); }
  }
});

test('unhandled rejection / uncaught exception text is redacted on stderr', async () => {
  const s = startServer({ preload: "setTimeout(() => { Promise.reject(new Error('boom ' + process.env.TGN_BOT_TOKEN)); }, 50); setTimeout(() => { throw new Error('bang ' + process.env.TGN_BOT_TOKEN); }, 80)" });
  try {
    await s.ready;
    await new Promise((r) => setTimeout(r, 300));
    assert.match(s.stderr(), /boom/);
    assert.match(s.stderr(), /bang/);
    assert.ok(!s.stderr().includes(TEST_TOKEN.split(':')[1]));
  } finally { s.stop(); }
});

test('telegram_status with a malformed token shows the token error without leaking it', async () => {
  const s = startServer({ env: { TGN_BOT_TOKEN: 'abc' } });
  try {
    await s.ready;
    const r = await s.call('telegram_status', { session_id: SID });
    assert.match(s.text(r), /Токен: Токен бота выглядит неправильно/);
    assert.ok(!/\babc\b/.test(s.text(r)));
  } finally { s.stop(); }
});

test('send_telegram_file dry_run without binding previews name and size, sends nothing', async () => {
  const s = startServer();
  try {
    await s.ready;
    const f = join(s.projectDir, 'предпросмотр.txt');
    writeFileSync(f, '12345');
    const before = fake.sends().length;
    const r = await s.call('send_telegram_file', msg({ path: f, dry_run: true }));
    assert.ok(!r.isError, s.text(r));
    assert.match(s.text(r), /^Предпросмотр/);
    assert.ok(s.text(r).includes('предпросмотр.txt'));
    assert.match(s.text(r), /5 байт/);
    assert.equal(fake.sends().length, before);
  } finally { s.stop(); }
});

// --- File checks (KTD11) ---

function fileEnv() {
  const home = mkdtempSync(join(tmpdir(), 'tgn-home-'));
  const work = join(home, 'work');
  mkdirSync(work);
  mkdirSync(join(home, '.ssh'));
  const opts = { home, dataDir: join(home, 'plugin-data'), env: {}, botToken: TEST_TOKEN };
  return { home, work, opts };
}
const refusedBy = (re) => (e) => e instanceof FileRefused && re.test(e.message);

test('files: secret names, secret folders and ~/.claude.json are refused; normal file passes', () => {
  const { home, work, opts } = fileEnv();
  for (const name of ['.env', '.env.local', 'id_rsa', 'key.pem', 'CREDENTIALS.json', '.envrc', 'prod.env', 'terraform.tfvars', 'app.keystore', '.htpasswd', 'secrets.yaml']) {
    writeFileSync(join(work, name), 'x');
    assert.throws(() => checkFile(join(work, name), opts), refusedBy(/похож на секрет/), name);
  }
  // Letter case must not matter on case-sensitive systems either.
  assert.throws(() => checkFile(join(work, 'CREDENTIALS.json'), { ...opts, platform: 'linux' }), refusedBy(/похож на секрет/));
  writeFileSync(join(home, '.claude.json'), '{}');
  assert.throws(() => checkFile(join(home, '.claude.json'), opts), refusedBy(/похож на секрет/));
  writeFileSync(join(home, '.ssh', 'config'), 'Host x');
  assert.throws(() => checkFile(join(home, '.ssh', 'config'), opts), refusedBy(/из папки/));
  mkdirSync(opts.dataDir);
  writeFileSync(join(opts.dataDir, 'state.json'), '{}');
  assert.throws(() => checkFile(join(opts.dataDir, 'state.json'), opts), refusedBy(/из папки/));
  writeFileSync(join(work, 'report.xlsx'), 'ok');
  assert.equal(checkFile(join(work, 'report.xlsx'), opts).filename, 'report.xlsx');
  writeFileSync(join(work, 'environment.txt'), 'ok');
  assert.equal(checkFile(join(work, 'environment.txt'), opts).filename, 'environment.txt');
});

test('files: a file with several hard links is refused', () => {
  const { work, opts } = fileEnv();
  const plain = join(work, 'plain.txt');
  writeFileSync(plain, 'x');
  linkSync(plain, join(work, 'innocent.txt'));
  assert.throws(() => checkFile(join(work, 'innocent.txt'), opts), refusedBy(/жёстких ссылок/));
});

test('files: Windows bypass attempts are refused before or at the filesystem', { skip: process.platform !== 'win32' }, () => {
  const { home, work, opts } = fileEnv();
  writeFileSync(join(work, 'key.pem'), 'x');
  writeFileSync(join(work, 'id_rsa'), 'x');
  assert.throws(() => checkFile(join(work, 'key.pem') + '::$DATA', opts), refusedBy(/потоки NTFS/));
  assert.throws(() => checkFile(join(work, 'id_rsa') + '.', opts), refusedBy(/похож на секрет/));
  assert.throws(() => checkFile('\\\\?\\' + join(work, 'report.xlsx'), opts), refusedBy(/Сетевые/));
  assert.throws(() => checkFile('\\\\localhost\\c$\\x\\.ssh\\id_rsa', opts), refusedBy(/Сетевые/));
  assert.throws(() => checkFile('\\\\attacker.example\\share\\x.txt', opts), refusedBy(/Сетевые/));
  // 8.3 short name of ~/.ssh, when the volume generates them.
  writeFileSync(join(home, '.ssh', 'known.txt'), 'x');
  const short = execFileSync('cmd', ['/d', '/s', '/c', `"for %I in ("${join(home, '.ssh')}") do @echo %~sI"`], { encoding: 'utf8', windowsVerbatimArguments: true }).trim();
  if (short && !short.toLowerCase().endsWith('.ssh')) assert.throws(() => checkFile(join(short, 'known.txt'), opts), refusedBy(/из папки/));
});

test('files: Windows ".." segments survive trailing-dot normalisation', { skip: process.platform !== 'win32' }, () => {
  const { work, opts } = fileEnv();
  mkdirSync(join(work, 'sub'));
  writeFileSync(join(work, 'report.xlsx'), 'ok');
  // Built by hand: join() would collapse '..' before checkFile sees it.
  const raw = (...segs) => [work, ...segs].join('\\');
  const r = checkFile(raw('sub', '..', 'report.xlsx'), opts);
  assert.equal(r.filename, 'report.xlsx');
  assert.equal(r.data.toString(), 'ok');
  assert.equal(checkFile(raw('.', 'report.xlsx'), opts).filename, 'report.xlsx');
  writeFileSync(join(work, 'id_rsa'), 'x');
  assert.throws(() => checkFile(raw('sub', '..', 'id_rsa.'), opts), refusedBy(/похож на секрет/));
});

test('files: secret content, directories, empty, missing, relative and oversized files', () => {
  const { work, opts } = fileEnv();
  writeFileSync(join(work, 'notes.txt'), '-----BEGIN OPENSSH PRIVATE KEY-----\nabc');
  assert.throws(() => checkFile(join(work, 'notes.txt'), opts), refusedBy(/похоже на секрет/));
  assert.throws(() => checkFile(work, opts), refusedBy(/папка/));
  writeFileSync(join(work, 'empty.txt'), '');
  assert.throws(() => checkFile(join(work, 'empty.txt'), opts), refusedBy(/пустой/));
  assert.throws(() => checkFile(join(work, 'missing.txt'), opts), refusedBy(/не найден/));
  assert.throws(() => checkFile('report.xlsx', opts), refusedBy(/абсолютный/));
  writeFileSync(join(work, 'big.bin'), Buffer.alloc(2048));
  assert.throws(() => checkFile(join(work, 'big.bin'), { ...opts, maxBytes: 1024 }), refusedBy(/больше/));
  assert.ok(!existsSync(join(work, 'x')));
});
