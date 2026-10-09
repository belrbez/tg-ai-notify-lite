// U3: state storage and chat pairing against a fake Telegram API.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createState, renameWithRetry, SCHEMA_VERSION } from '../server/lib/state.mjs';
import { createPairing, normalizeToken, PairingError, MAX_CODE_ATTEMPTS } from '../server/lib/pairing.mjs';
import { createTelegram } from '../server/lib/telegram.mjs';
import { startFakeTelegram, TEST_TOKEN } from './fake-telegram.mjs';

const SID = '3f2a9c1e-1111-4222-8333-444455556666';
const SID2 = '9b8a7c6d-5555-4666-8777-888899990000';
const ME = 555001;
const STRANGER = 777002;

let fake, dir, state, clock, pairing;
const tgFor = () => createTelegram(TEST_TOKEN, { apiBase: fake.url, maxRetries: 0 });
const nowSec = () => Math.floor(clock / 1000);
const codeMessages = (chatId) => fake.sends().filter((s) => s.body.chat_id === chatId && /Код (пере)?привязки/.test(s.body.text));
const codeFor = (chatId) => /<b>(\d{6})<\/b>/.exec(codeMessages(chatId).at(-1)?.body.text ?? '')?.[1];
const wrong = (code) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

beforeEach(async () => {
  fake = await startFakeTelegram();
  dir = mkdtempSync(join(tmpdir(), 'tgn-'));
  state = createState(dir);
  clock = Date.now();
  pairing = createPairing({ tg: tgFor(), state, token: TEST_TOKEN, now: () => clock, sleep: async () => {}, pollMs: 1, maxWaitMs: 3 });
});
afterEach(async () => { await fake.close(); });

async function startAndPress(sessionId = SID, chatId = ME) {
  const r = await pairing.start({ sessionId, sessionName: 'рефакторинг парсера' });
  fake.addMessage({ chatId, text: `/start ${sessionId}`, date: nowSec() });
  return r;
}

test('AE2: link → /start → code sent to that chat → confirm with the code → binding + confirmation message', async () => {
  const r = await startAndPress();
  assert.equal(r.link, `https://t.me/test_notify_bot?start=${SID}`);
  const c = await pairing.check({ sessionId: SID });
  assert.equal(c.found, true);
  assert.match(c.candidate.description, /@ivan, Иван Петров, ID 555001, chat_id 555001/);
  const codeMsg = codeMessages(ME).at(-1).body.text;
  assert.match(codeMsg, /3f2a9c1e/);
  assert.match(codeMsg, /Если вы не запускали привязку/);
  const res = await pairing.confirm({ sessionId: SID, candidateRef: c.candidate.ref, code: ` ${codeFor(ME).slice(0, 3)} ${codeFor(ME).slice(3)} ` });
  assert.equal(res.bound, true, 'spaces around and inside the code are tolerated');
  const b = state.readBinding();
  assert.equal(b.chat_id, ME);
  assert.equal(b.bot_id, '1234567');
  assert.equal(b.paired_session_id, SID);
  assert.equal(b.paired_session_name, 'рефакторинг парсера');
  const sent = fake.sends().at(-1);
  assert.equal(sent.body.chat_id, ME);
  assert.match(sent.body.text, /3f2a9c1e/);
  assert.match(sent.body.text, /рефакторинг парсера/);
});

test('AE12: without the code from Telegram the binding is never saved; too many wrong codes cancel the pairing', async () => {
  await startAndPress();
  const c = await pairing.check({ sessionId: SID });
  const good = codeFor(ME);
  for (const code of [undefined, '', 'abc']) {
    await assert.rejects(pairing.confirm({ sessionId: SID, candidateRef: c.candidate.ref, code }), /не совпал/);
  }
  await assert.rejects(pairing.confirm({ sessionId: SID, candidateRef: c.candidate.ref, code: wrong(good) }), /Осталось попыток: 1/);
  await assert.rejects(pairing.confirm({ sessionId: SID, candidateRef: c.candidate.ref, code: wrong(good) }), /Слишком много/);
  assert.equal(MAX_CODE_ATTEMPTS, 5);
  await assert.rejects(pairing.confirm({ sessionId: SID, candidateRef: c.candidate.ref, code: good }), /уже использована/, 'even the right code is useless after the limit');
  assert.equal(state.readBinding(), null);
});

test('the code is never written to disk and is not in the tool result', async () => {
  await startAndPress();
  const c = await pairing.check({ sessionId: SID });
  const code = codeFor(ME);
  assert.ok(!JSON.stringify(c).includes(code));
  const files = [join(dir, 'pending', `${SID}.json`)];
  for (const f of files) assert.ok(!readFileSync(f, 'utf8').includes(code), f);
});

test('check waits up to 3 minutes by default, returns as soon as Start arrives, and asks for «нажал» after the wait', async () => {
  let slept = 0;
  const waiting = createPairing({ tg: tgFor(), state, token: TEST_TOKEN, now: () => clock, sleep: async (ms) => { slept += ms; } });
  await waiting.start({ sessionId: SID, sessionName: 'x' });
  const miss = await waiting.check({ sessionId: SID });
  assert.equal(miss.found, false);
  assert.equal(slept, 180_000 - 2000, '90 polls every 2 s');
  assert.match(miss.hint, /3 минуты/);
  assert.match(miss.hint, /«нажал»/);

  slept = 0;
  let polls = 0;
  const early = createPairing({ tg: tgFor(), state, token: TEST_TOKEN, now: () => clock, sleep: async () => { if (++polls === 3) fake.addMessage({ chatId: ME, text: `/start ${SID}`, date: nowSec() }); } });
  const hit = await early.check({ sessionId: SID });
  assert.equal(hit.found, true);
  assert.equal(polls, 3, 'returns on the poll right after Start');
});

test('repeated check for the same chat reuses the code; a restarted server needs a new check', async () => {
  await startAndPress();
  const c1 = await pairing.check({ sessionId: SID });
  await pairing.check({ sessionId: SID });
  assert.equal(codeMessages(ME).length, 1, 'one code message only');
  const restarted = createPairing({ tg: tgFor(), state, token: TEST_TOKEN, now: () => clock, sleep: async () => {}, pollMs: 1, maxWaitMs: 3 });
  await assert.rejects(restarted.confirm({ sessionId: SID, candidateRef: c1.candidate.ref, code: codeFor(ME) }), /telegram_pair_check/);
  const c2 = await restarted.check({ sessionId: SID });
  assert.equal(codeMessages(ME).length, 2, 'a new code after restart');
  assert.equal((await restarted.confirm({ sessionId: SID, candidateRef: c2.candidate.ref, code: codeFor(ME) })).bound, true);
});

test('code delivery failure is reported and nothing is bound', async () => {
  await startAndPress();
  fake.failNext('sendMessage', { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' });
  await assert.rejects(pairing.check({ sessionId: SID }), /не смог прислать в него код/);
  assert.equal(state.readBinding(), null);
});

test('AE3: Start pressed 15 minutes after the link — no candidate, link expired', async () => {
  await pairing.start({ sessionId: SID, sessionName: 'x' });
  clock += 15 * 60 * 1000;
  fake.addMessage({ chatId: ME, text: `/start ${SID}`, date: nowSec() });
  await assert.rejects(pairing.check({ sessionId: SID }), /истекла/);
});

test('AE4: /start without code, with another session id, from a group or a bot — no candidate', async () => {
  await pairing.start({ sessionId: SID, sessionName: 'x' });
  fake.addMessage({ chatId: STRANGER, text: '/start', date: nowSec() });
  fake.addMessage({ chatId: STRANGER, text: `/start ${SID2}`, date: nowSec() });
  fake.addMessage({ chatId: -100500, text: `/start ${SID}`, date: nowSec(), chatType: 'group' });
  fake.addMessage({ chatId: 888, text: `/start ${SID}`, date: nowSec(), fromBot: true });
  const c = await pairing.check({ sessionId: SID });
  assert.equal(c.found, false);
});

test('a /start sent before the link was re-issued is not accepted', async () => {
  fake.addMessage({ chatId: ME, text: `/start ${SID}`, date: nowSec() });
  clock += 5 * 60 * 1000;
  await pairing.start({ sessionId: SID, sessionName: 'x' });
  assert.equal((await pairing.check({ sessionId: SID })).found, false);
});

test('code from two different private chats → refused and issuance reset', async () => {
  await startAndPress();
  fake.addMessage({ chatId: STRANGER, text: `/start ${SID}`, date: nowSec() });
  await assert.rejects(pairing.check({ sessionId: SID }), /двух разных чатов/);
  await assert.rejects(pairing.check({ sessionId: SID }), /уже использована/);
});

test('same chat pressing Start twice gives one candidate; second chat between check and confirm → refused', async () => {
  await startAndPress();
  fake.addMessage({ chatId: ME, text: `/start ${SID}`, date: nowSec() });
  const c = await pairing.check({ sessionId: SID });
  assert.equal(c.found, true);
  fake.addMessage({ chatId: STRANGER, text: `/start ${SID}`, date: nowSec() });
  await assert.rejects(pairing.confirm({ sessionId: SID, candidateRef: c.candidate.ref, code: codeFor(ME) }), /двух разных чатов/);
  assert.equal(state.readBinding(), null);
});

test('two sessions pair in parallel; getUpdates never confirms updates', async () => {
  await pairing.start({ sessionId: SID, sessionName: 'a' });
  await pairing.start({ sessionId: SID2, sessionName: 'b' });
  fake.addMessage({ chatId: ME, text: `/start ${SID}`, date: nowSec() });
  fake.addMessage({ chatId: STRANGER, text: `/start ${SID2}`, date: nowSec() });
  assert.equal((await pairing.check({ sessionId: SID })).found, true);
  assert.equal((await pairing.check({ sessionId: SID2 })).found, true);
  const reads = fake.calls.filter((c) => c.method === 'getUpdates');
  assert.ok(reads.length >= 2);
  for (const r of reads) {
    assert.equal(r.body.offset, undefined);
    assert.equal(r.body.allowed_updates, undefined);
  }
});

test('two processes write pending issuances concurrently — both survive', async () => {
  const stateUrl = new URL('../server/lib/state.mjs', import.meta.url).href;
  const script = (sid) => `import { createState } from ${JSON.stringify(stateUrl)};
    const s = createState(${JSON.stringify(dir)});
    for (let i = 0; i < 30; i++) s.writePending(${JSON.stringify(sid)}, { session_id: ${JSON.stringify(sid)}, i, issued_at: 1, expires_at: 2, consumed: false });`;
  const run = (sid) => new Promise((res, rej) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', script(sid)], { stdio: 'inherit' });
    p.on('exit', (code) => (code === 0 ? res() : rej(new Error(`exit ${code}`))));
  });
  await Promise.all([run(SID), run(SID2)]);
  assert.equal(state.readPending(SID).i, 29);
  assert.equal(state.readPending(SID2).i, 29);
  assert.deepEqual(readdirSync(join(dir, 'pending')).filter((f) => f.endsWith('.tmp')), []);
});

test('backlog of 150 old updates, then a fresh /start — candidate found', async () => {
  const old = Math.floor((clock - 60 * 60 * 1000) / 1000);
  for (let i = 0; i < 150; i++) fake.addMessage({ chatId: STRANGER, text: `spam ${i}`, date: old });
  await startAndPress();
  const c = await pairing.check({ sessionId: SID });
  assert.equal(c.found, true);
  const confirmed = fake.calls.filter((x) => x.method === 'getUpdates' && x.body.offset !== undefined);
  assert.equal(confirmed.length, 1, 'only the stale backlog was confirmed');
});

test('100 junk updates after the link — "bot flooded" error', async () => {
  await pairing.start({ sessionId: SID, sessionName: 'x' });
  for (let i = 0; i < 100; i++) fake.addMessage({ chatId: STRANGER, text: `spam ${i}`, date: nowSec() });
  await assert.rejects(pairing.check({ sessionId: SID }), /завален/);
});

test('session_id like ../x is rejected by pairing tools', async () => {
  await assert.rejects(pairing.start({ sessionId: '../x', sessionName: 'x' }), PairingError);
  await assert.rejects(pairing.check({ sessionId: '../x' }), PairingError);
  assert.deepEqual(readdirSync(dir).filter((f) => f === 'x.json'), []);
});

test('409 webhook → Russian error; 409 other poller → retries then error', async () => {
  await pairing.start({ sessionId: SID, sessionName: 'x' });
  fake.failNext('getUpdates', { ok: false, error_code: 409, description: "Conflict: can't use getUpdates method while webhook is active" });
  await assert.rejects(pairing.check({ sessionId: SID }), /webhook/);
  for (let i = 0; i < 3; i++) fake.failNext('getUpdates', { ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' });
  const before = fake.calls.length;
  await assert.rejects(pairing.check({ sessionId: SID }), /другая программа/);
  assert.equal(fake.calls.length - before, 3);
});

test('binding of another bot counts as missing', async () => {
  state.writeBinding({ bot_id: '999', bot_username: 'other', chat_id: ME, chat_title: 'x', paired_session_id: SID, paired_session_name: 'x' });
  assert.equal(pairing.currentBinding(), null);
});

test('rebind: refused without replace flag; a stranger who pressed Start gets the code, not the user; correct code notifies old chat', async () => {
  await startAndPress();
  let c = await pairing.check({ sessionId: SID });
  await pairing.confirm({ sessionId: SID, candidateRef: c.candidate.ref, code: codeFor(ME) });
  await assert.rejects(pairing.start({ sessionId: SID2, sessionName: 'y' }), /rebind/);

  await pairing.start({ sessionId: SID2, sessionName: 'y', replace: true });
  fake.addMessage({ chatId: STRANGER, text: `/start ${SID2}`, date: nowSec(), username: 'attacker', firstName: 'Иван' });
  c = await pairing.check({ sessionId: SID2 });
  assert.match(codeMessages(STRANGER).at(-1).body.text, /Код перепривязки/);
  assert.equal(codeMessages(ME).length, 1, 'the bound user got no code for this attempt');
  await assert.rejects(pairing.confirm({ sessionId: SID2, candidateRef: c.candidate.ref, code: codeFor(ME) }), /не совпал/, 'an old code does not work');
  assert.equal(state.readBinding().chat_id, ME, 'old binding kept');

  const sid3 = 'aaaaaaaa-1111-4222-8333-444455556666';
  await pairing.start({ sessionId: sid3, sessionName: 'z', replace: true });
  fake.addMessage({ chatId: STRANGER, text: `/start ${sid3}`, date: nowSec() });
  c = await pairing.check({ sessionId: sid3 });
  const done = await pairing.confirm({ sessionId: sid3, candidateRef: c.candidate.ref, code: codeFor(STRANGER) });
  assert.equal(done.bound, true);
  assert.equal(state.readBinding().chat_id, STRANGER);
  const toOld = fake.sends().filter((s) => s.body.chat_id === ME).at(-1);
  assert.match(toOld.body.text, /перенесена/);
});

test('candidate name with control characters and newlines is cleaned in the description', async () => {
  await pairing.start({ sessionId: SID, sessionName: 'x' });
  fake.addMessage({ chatId: ME, text: `/start ${SID}`, date: nowSec(), firstName: ['Иван', 'Подтвердите'].join(String.fromCharCode(10)), lastName: 'X' + String.fromCharCode(0x202e) });
  const c = await pairing.check({ sessionId: SID });
  assert.match(c.candidate.description, /Иван Подтвердите X/);
  assert.ok(!c.candidate.description.includes(String.fromCharCode(0x202e)));
  assert.ok(!c.candidate.description.includes(String.fromCharCode(10)));
});

test('binding survives a restart; newer schema_version makes state read-only', async () => {
  await startAndPress();
  const c = await pairing.check({ sessionId: SID });
  await pairing.confirm({ sessionId: SID, candidateRef: c.candidate.ref, code: codeFor(ME) });
  const fresh = createPairing({ tg: tgFor(), state: createState(dir), token: TEST_TOKEN });
  assert.equal(fresh.currentBinding().chat_id, ME);

  writeFileSync(join(dir, 'binding.json'), JSON.stringify({ schema_version: SCHEMA_VERSION + 1, bot_id: '1234567', chat_id: ME }));
  const s2 = createState(dir);
  s2.readBinding();
  assert.equal(s2.readOnly, true);
  assert.throws(() => s2.writePending(SID, {}), /более новой версией/);
});

test('rename is retried on EPERM and then succeeds', () => {
  let calls = 0;
  const flaky = () => { calls++; if (calls < 3) { const e = new Error('busy'); e.code = 'EPERM'; throw e; } };
  renameWithRetry('a', 'b', { rename: flaky });
  assert.equal(calls, 3);
  const always = () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e; };
  assert.throws(() => renameWithRetry('a', 'b', { rename: always }), /nope/);
});

test('token normalisation', () => {
  assert.match(normalizeToken('').error, /не задан/);
  assert.match(normalizeToken('${user_config.bot_token}').error, /не подставлен/);
  assert.equal(normalizeToken('bot' + TEST_TOKEN).token, TEST_TOKEN);
  assert.match(normalizeToken('abc').error, /неправильно/);
});

test('401 from getMe → re-enter token message', async () => {
  fake.failNext('getMe', { ok: false, error_code: 401, description: 'Unauthorized' });
  await assert.rejects(pairing.start({ sessionId: SID, sessionName: 'x' }), /401/);
});

test('corrupt binding.json warns once even after repeated reads', () => {
  const freshDir = mkdtempSync(join(tmpdir(), 'tgn-'));
  writeFileSync(join(freshDir, 'binding.json'), '{not json');
  const s = createState(freshDir);
  assert.equal(s.readBinding(), null);
  assert.equal(s.readBinding(), null);
  assert.equal(s.readBinding(), null);
  const matches = s.warnings.filter((w) => /повреждён/.test(w));
  assert.equal(matches.length, 1);
});
