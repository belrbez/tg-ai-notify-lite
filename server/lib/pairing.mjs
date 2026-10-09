// Chat pairing (KTD5–KTD7, KTD15): pair_start issues a t.me link whose start code is the Claude
// session id, pair_check finds the /start without confirming updates and has the bot send a one-time
// code to that chat, pair_confirm saves the binding only when the user types that code back to Claude.
// The code lives only in this server process's memory, so neither the model nor a file reader can see it.
import { randomInt, timingSafeEqual } from 'node:crypto';
import { validateSessionId, cleanLabel, escapeHtml, sessionTag } from './message.mjs';
import { TelegramError } from './telegram.mjs';

export const PAIR_WINDOW_MS = 10 * 60 * 1000;
export const MAX_CODE_ATTEMPTS = 5;
const CLOCK_SKEW_MS = 60 * 1000;
const TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;

export class PairingError extends Error {}

// Sent once with the "chat is bound" confirmation: what the user can ask Claude from now on.
export const HELP_TEXT = [
  '<b>Что можно попросить Claude:</b>',
  '• «пришли в тг итог по задаче» — сообщение сюда (можно «в tg», «в телегу», «в телеграм»)',
  '• «сделай … и в конце отправь итог в тг» — сообщение после задачи',
  '• «скинь в тг файл отчёта …» — файл до 50 МБ',
  '• «каждый час присылай в тг сводку» — регулярная задача',
  '• «пришли в тг без звука…» / «это срочно…»',
  '• «покажи статус telegram-плагина» — к какому боту и чату привязан',
  '• «смени токен telegram-бота» — страница для нового токена',
  '• <code>/tg-ai-notify-lite:rebind</code> — привязать другой чат',
  '',
  'Сами по себе сообщения не приходят — только по вашей просьбе. Тихие часы (ночью без звука) включаются в настройках плагина.',
].join('\n');

// Returns { token } or { error } with a short Russian description.
export function normalizeToken(raw) {
  let t = String(raw ?? '').trim();
  if (!t) return { error: 'Токен бота не задан.' };
  if (t.includes('${')) return { error: 'Токен бота не подставлен из настроек плагина.' };
  if (/^bot\d+:/.test(t)) t = t.slice(3);
  if (!TOKEN_RE.test(t)) return { error: 'Токен бота выглядит неправильно (ожидается вид 123456789:AA…).' };
  return { token: t };
}

const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');
const sameCode = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export const botIdFromToken = (token) => token.slice(0, token.indexOf(':'));

const describeUser = (u) => {
  const name = cleanLabel([u.first_name, u.last_name].filter(Boolean).join(' ') || '—');
  return `${u.username ? '@' + cleanLabel(u.username, 40) : 'нет username'}, ${name}, ID ${u.user_id}, chat_id ${u.chat_id}`;
};

export function createPairing({ tg, state, token, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = 2000, maxWaitMs = 180_000 }) {
  const botId = botIdFromToken(token);
  const challenges = new Map(); // sessionId -> { ref, chatId, code, attempts }

  // The binding counts only for the bot that owns the current token (KTD7).
  function currentBinding() {
    const b = state.readBinding();
    return b && String(b.bot_id) === botId ? b : null;
  }

  async function getMe() {
    try { return await tg.call('getMe'); } catch (e) {
      if (e instanceof TelegramError && e.code === 401) throw new PairingError('Telegram отклонил токен бота (401) — возможно, его отозвали в @BotFather. Задайте новый токен через страницу настройки (telegram_setup).');
      throw e;
    }
  }

  function checkSession(sessionId) {
    const problem = validateSessionId(sessionId);
    if (problem) throw new PairingError(problem);
  }

  async function start({ sessionId, sessionName, replace = false }) {
    checkSession(sessionId);
    const existing = currentBinding();
    if (existing && !replace) {
      throw new PairingError(`Чат уже привязан (${existing.username ? '@' + existing.username : existing.chat_title}, chat_id ${existing.chat_id}). Для перепривязки пользователь должен сам запустить команду /tg-ai-notify-lite:rebind.`);
    }
    const me = await getMe();
    const issuedAt = now();
    state.writePending(sessionId, { session_id: sessionId, session_name: cleanLabel(sessionName, 40), bot_username: me.username, issued_at: issuedAt, expires_at: issuedAt + PAIR_WINDOW_MS, consumed: false, replace: !!existing, candidate: null });
    return { link: `https://t.me/${me.username}?start=${sessionId}`, bot_username: me.username, expires_at: new Date(issuedAt + PAIR_WINDOW_MS).toISOString(), replacing: !!existing };
  }

  // getUpdates never confirms updates (no offset), so parallel sessions keep seeing their /start (KTD6).
  async function peekUpdates() {
    for (let attempt = 1; ; attempt++) {
      try { return await tg.call('getUpdates', { timeout: 0, limit: 100 }); } catch (e) {
        if (!(e instanceof TelegramError) || e.code !== 409) throw e;
        if (/webhook/i.test(e.description)) throw new PairingError('Этот бот уже используется другим приложением через webhook, поэтому плагин не может прочитать нажатие Start. Создайте для плагина отдельного бота в @BotFather.');
        if (attempt >= 3) throw new PairingError('Сообщения этого бота сейчас читает другая программа (409). Закройте её или создайте для плагина отдельного бота в @BotFather.');
        await sleep(300 + Math.floor(Math.random() * 700));
      }
    }
  }

  function matches(updates, pending) {
    const code = `/start ${pending.session_id}`;
    return updates.map((u) => u.message).filter((m) =>
      m && m.chat?.type === 'private' && m.from && !m.from.is_bot && m.text === code && m.date * 1000 >= pending.issued_at - CLOCK_SKEW_MS);
  }

  // Only updates older than every live issuance may be confirmed: they can never match any pairing.
  async function dropStaleBacklog(updates) {
    const live = state.listPending().filter((p) => !p.consumed && p.expires_at > now());
    if (!live.length) return false;
    const cutoff = Math.min(...live.map((p) => p.issued_at)) - CLOCK_SKEW_MS;
    const stale = updates.filter((u) => ((u.message ?? u.edited_message ?? u.channel_post)?.date ?? 0) * 1000 < cutoff);
    if (!stale.length) return false;
    await tg.call('getUpdates', { timeout: 0, limit: 1, offset: Math.max(...stale.map((u) => u.update_id)) + 1 });
    return true;
  }

  async function findCandidates(pending) {
    let updates = await peekUpdates();
    let found = matches(updates, pending);
    if (!found.length && updates.length >= 100 && await dropStaleBacklog(updates)) {
      updates = await peekUpdates();
      found = matches(updates, pending);
    }
    const flooded = !found.length && updates.length >= 100;
    return { found, flooded };
  }

  function livePending(sessionId) {
    checkSession(sessionId);
    const p = state.readPending(sessionId);
    if (!p) throw new PairingError('Привязка не начата. Сначала вызовите telegram_pair_start.');
    if (p.consumed) throw new PairingError('Эта ссылка привязки уже использована или отменена. Получите новую через telegram_pair_start.');
    if (now() > p.expires_at) throw new PairingError('Ссылка привязки истекла (действует 10 минут). Получите новую через telegram_pair_start.');
    return p;
  }

  const consume = (p) => { challenges.delete(p.session_id); state.writePending(p.session_id, { ...p, consumed: true }); };

  function toCandidate(m, updateId) {
    return { ref: `${m.chat.id}:${updateId ?? m.message_id}`, chat_id: m.chat.id, user_id: m.from.id, username: m.from.username ?? null, first_name: m.from.first_name ?? '', last_name: m.from.last_name ?? '' };
  }

  async function check({ sessionId }) {
    const pending = livePending(sessionId);
    const attempts = Math.max(1, Math.floor(maxWaitMs / pollMs));
    for (let attempt = 1; ; attempt++) {
      const { found, flooded } = await findCandidates(pending);
      const chats = [...new Set(found.map((m) => m.chat.id))];
      if (chats.length > 1) {
        consume(pending);
        throw new PairingError('Код привязки прислали из двух разных чатов — привязка отменена. Получите новую ссылку и нажмите Start только в своём чате.');
      }
      if (chats.length === 1) {
        const m = found[found.length - 1];
        const candidate = toCandidate(m, m.message_id);
        state.writePending(sessionId, { ...pending, candidate });
        await sendCode(pending, candidate);
        return { found: true, candidate: { ref: candidate.ref, description: describeUser(candidate) } };
      }
      if (flooded) throw new PairingError('Бот завален сообщениями, и нажатие Start не видно среди них. Создайте для плагина нового бота в @BotFather и введите его токен в настройках плагина.');
      if (attempt >= attempts) return { found: false, hint: 'За 3 минуты нажатие Start не пришло. Попроси пользователя открыть ссылку, нажать Start и написать тебе «нажал», когда сделает; после ответа вызови telegram_pair_check ещё раз.' };
      await sleep(pollMs);
    }
  }

  // The bot sends a one-time code to the chat that pressed Start. Only the owner of that chat can read it
  // and type it into this Claude session, so a stranger who pressed Start cannot complete the binding.
  // A repeated check for the same chat reuses the code instead of sending a new one.
  async function sendCode(pending, candidate) {
    const prev = challenges.get(pending.session_id);
    if (prev && prev.chatId === candidate.chat_id) { prev.ref = candidate.ref; return; }
    const code = newCode();
    const replacing = !!currentBinding();
    const text = [
      `🔐 Код ${replacing ? 'перепривязки' : 'привязки'}: <b>${code}</b>`,
      '',
      `Напишите его в чат Claude, сессия <code>${pending.session_id.slice(0, 8)}</code> «${escapeHtml(pending.session_name)}».`,
      `После этого ${replacing ? 'сообщения плагина будут приходить сюда вместо прежнего чата' : 'Claude сможет присылать сюда сообщения по вашей просьбе'}.`,
      'Если вы не запускали привязку — никому не сообщайте код и ничего не делайте.',
    ].join('\n');
    try {
      await tg.sendHtml(candidate.chat_id, [text]);
    } catch (e) {
      throw new PairingError(`Чат найден, но бот не смог прислать в него код привязки: ${e.message}`);
    }
    challenges.set(pending.session_id, { ref: candidate.ref, chatId: candidate.chat_id, code, attempts: 0 });
  }

  async function confirm({ sessionId, candidateRef, code }) {
    const pending = livePending(sessionId);
    const candidate = pending.candidate;
    if (!candidate || candidate.ref !== candidateRef) throw new PairingError('Кандидат для привязки не найден или изменился. Вызовите telegram_pair_check ещё раз.');
    const challenge = challenges.get(sessionId);
    if (!challenge || challenge.chatId !== candidate.chat_id) {
      throw new PairingError('Код привязки ещё не отправлен или сервер плагина перезапускался. Вызовите telegram_pair_check — бот пришлёт новый код.');
    }

    const { found } = await findCandidates(pending);
    if (new Set([candidate.chat_id, ...found.map((m) => m.chat.id)]).size > 1) {
      consume(pending);
      throw new PairingError('Код привязки прислали из двух разных чатов — привязка отменена. Получите новую ссылку и нажмите Start только в своём чате.');
    }

    const typed = String(code ?? '').replace(/\D/g, '');
    if (!sameCode(typed, challenge.code)) {
      challenge.attempts += 1;
      const left = MAX_CODE_ATTEMPTS - challenge.attempts;
      if (left <= 0) {
        consume(pending);
        throw new PairingError('Слишком много неверных кодов — привязка отменена. Начните заново: новая ссылка, Start, новый код.');
      }
      throw new PairingError(`Код не совпал. Попроси пользователя переписать 6 цифр из последнего сообщения бота в Telegram. Осталось попыток: ${left}.`);
    }

    const existing = currentBinding();
    const botUsername = pending.bot_username ?? (await getMe()).username;
    const title = cleanLabel([candidate.first_name, candidate.last_name].filter(Boolean).join(' ') || '—');
    const binding = {
      bot_id: botId, bot_username: botUsername, chat_id: candidate.chat_id, user_id: candidate.user_id,
      username: candidate.username, chat_title: title,
      paired_session_id: pending.session_id, paired_session_name: pending.session_name, paired_at: new Date(now()).toISOString(),
    };
    state.writeBinding(binding);
    consume(pending);

    const warnings = [];
    const short = pending.session_id.slice(0, 8);
    try {
      await tg.sendHtml(candidate.chat_id, [`✅ Этот чат привязан к плагину tg-ai-notify-lite из сессии Claude <code>${short}</code> «${escapeHtml(pending.session_name)}».\n\n${HELP_TEXT}`]);
    } catch (e) { warnings.push(`Привязка сохранена, но подтверждение в чат не отправилось: ${e.message}`); }
    if (existing && String(existing.chat_id) !== String(candidate.chat_id)) {
      try {
        await tg.sendHtml(existing.chat_id, [`⚠️ Привязка плагина tg-ai-notify-lite перенесена на ${escapeHtml(binding.username ? '@' + binding.username : title)} (chat_id ${binding.chat_id}) из сессии Claude <code>${short}</code>. Если это были не вы — запустите перепривязку и проверьте, что делают ваши сессии Claude.`]);
      } catch (e) { warnings.push(`Не удалось уведомить прежний чат: ${e.message}`); }
    }
    return { bound: true, binding: publicBinding(binding), warnings };
  }

  return { start, check, confirm, currentBinding, getMe, botId };
}

export function publicBinding(b) {
  if (!b) return null;
  return { bot: '@' + b.bot_username, chat: `${b.username ? '@' + b.username : 'нет username'}, ${b.chat_title}, chat_id ${b.chat_id}`, paired_at: b.paired_at, paired_session: sessionTag(b.paired_session_id, b.paired_session_name) };
}
