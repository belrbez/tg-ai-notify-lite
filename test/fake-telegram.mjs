// Fake Telegram Bot API for tests: records calls, serves configurable updates, injects failures.
import { createServer } from 'node:http';

export const TEST_TOKEN = '1234567:AAtestsecretpart_abcdefghijklmnopqrstu';

export async function startFakeTelegram({ botId = 1234567, username = 'test_notify_bot' } = {}) {
  const calls = [];
  const failures = new Map(); // method -> [{ status?, body }]
  let updates = [];
  let msgId = 100;

  const server = createServer(async (req, res) => {
    const parts = [];
    for await (const p of req) parts.push(p);
    const raw = Buffer.concat(parts);
    const method = req.url.split('/').pop();
    const token = req.url.split('/')[1]?.replace(/^bot/, '');
    const body = req.headers['content-type']?.includes('json') ? JSON.parse(raw.toString('utf8') || '{}') : { multipart: raw.toString('utf8') };
    calls.push({ method, body, token });
    const reply = (obj, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

    const queue = failures.get(method);
    if (queue?.length) { const f = queue.shift(); return reply(f.body, f.status ?? 200); }

    switch (method) {
      case 'getMe': return reply({ ok: true, result: { id: botId, is_bot: true, username } });
      case 'getUpdates': {
        const offset = body.offset;
        const visible = updates.filter((u) => offset === undefined || u.update_id >= offset);
        if (offset !== undefined) updates = visible; // confirming earlier updates deletes them, as in Telegram
        return reply({ ok: true, result: visible.slice(0, body.limit ?? 100) });
      }
      case 'sendMessage':
      case 'sendDocument':
        return reply({ ok: true, result: { message_id: ++msgId } });
      default:
        return reply({ ok: false, error_code: 404, description: 'Not Found' }, 404);
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  let nextUpdateId = 1000;
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    sends: () => calls.filter((c) => c.method === 'sendMessage' || c.method === 'sendDocument'),
    failNext(method, body, status) { if (!failures.has(method)) failures.set(method, []); failures.get(method).push({ body, status }); },
    setUpdates(list) { updates = list; },
    // Adds a private-chat message; returns the update.
    addMessage({ chatId, text, date = Math.floor(Date.now() / 1000), chatType = 'private', fromBot = false, username = 'ivan', firstName = 'Иван', lastName = 'Петров' }) {
      const u = { update_id: nextUpdateId++, message: { message_id: nextUpdateId, date, text, chat: { id: chatId, type: chatType, first_name: firstName, last_name: lastName, username }, from: { id: chatId, is_bot: fromBot, first_name: firstName, last_name: lastName, username } } };
      updates.push(u);
      return u;
    },
    close: () => new Promise((r) => server.close(r)),
  };
}
