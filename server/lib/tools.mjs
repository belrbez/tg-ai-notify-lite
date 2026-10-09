// MCP tool definitions and handlers (U4). Every text returned to Claude passes through the token redactor.
import { basename } from 'node:path';
import { messageSchema, validateMessage, validateSessionId, renderBody, renderFooter, packWithFooter, htmlToText } from './message.mjs';
import { messageSecrets } from './secrets.mjs';
import { silentFor } from './sound.mjs';
import { checkFile, FileRefused } from './files.mjs';
import { PairingError, publicBinding } from './pairing.mjs';
import { StateError } from './state.mjs';

const WHEN = 'Вызывай ТОЛЬКО если пользователь явно попросил отправить что-то в Telegram («отправь/пришли/скинь в тг/телеграм») или это часть заданной им задачи с отправкой в Telegram. Никогда не отправляй по собственной инициативе.';
const SID_RULE = 'session_id бери ТОЛЬКО из скилла telegram этого плагина; если скилл не загружен — сначала вызови его. Никогда не придумывай ID.';
const SETUP_HINT = 'Если пользователь сейчас в разговоре — вызови telegram_setup и дай ему ссылку на страницу, где он вставит токен от @BotFather (сам токен в чате не проси). В задаче без пользователя сообщи, что токен не задан.';
const NOT_BOUND = 'НЕ_ПРИВЯЗАН: Telegram-чат ещё не привязан. Если пользователь сейчас в разговоре — проведи привязку по скиллу telegram (telegram_pair_start). Если это задача без пользователя — не начинай привязку, сообщи: «чат не привязан — пройдите привязку в интерактивной сессии».';

class ToolError extends Error {}

export function createTools(ctx) {
  const { tokenError, tokenSource, tg, state, pairing, quiet, projectName, redact, botToken, openSetup } = ctx;
  const sidProp = { type: 'string', description: 'ID текущей сессии Claude из скилла telegram' };

  const tools = [
    {
      name: 'send_telegram_message',
      description: `Отправить сообщение в привязанный личный чат Telegram пользователя в едином формате tg-notify. ${WHEN} ${SID_RULE}`,
      inputSchema: messageSchema(),
    },
    {
      name: 'send_telegram_file',
      description: `Отправить локальный файл (до 50 MB) документом в привязанный чат Telegram с подписью в едином формате. Путь — абсолютный. Секретные файлы (.env, ключи, ~/.ssh) плагин не отправляет. ${WHEN} ${SID_RULE}`,
      inputSchema: messageSchema({ file: true }),
    },
    {
      name: 'telegram_status',
      description: 'Показать состояние плагина: бот, привязанный чат, когда и из какой сессии сделана привязка, тихие часы. Только чтение.',
      inputSchema: { type: 'object', additionalProperties: false, properties: { session_id: sidProp } },
    },
    {
      name: 'telegram_setup',
      description: 'Открыть страницу настройки токена бота: вернёт локальную ссылку (http://127.0.0.1:…), пользователь откроет её в браузере и вставит токен от @BotFather. После сохранения плагин сразу работает с новым ботом, перезапуск не нужен. Вызывай, когда токен не задан или пользователь просит сменить бота. Никогда не проси прислать токен в чат.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    },
    {
      name: 'telegram_pair_start',
      description: `Начать привязку чата: вернуть ссылку на бота, которую пользователь должен открыть и нажать Start. Вызывай только в интерактивном разговоре с пользователем, никогда в задаче без пользователя. ${SID_RULE}`,
      inputSchema: { type: 'object', additionalProperties: false, required: ['session_id', 'session_name'], properties: { session_id: sidProp, session_name: messageSchema().properties.session_name, replace: { type: 'boolean', description: 'Заменить существующую привязку — только по команде пользователя /tg-ai-notify-lite:rebind' } } },
    },
    {
      name: 'telegram_pair_check',
      description: 'Дождаться, пока пользователь нажмёт Start по ссылке привязки (ждёт до 3 минут и возвращается сразу, как только нажатие пришло). Если нажал — бот пришлёт ему в Telegram 6-значный код. Вызывай сразу после того, как показал ссылку, не дожидаясь ответа пользователя. Если за 3 минуты не пришло — попроси написать «нажал» и после ответа вызови ещё один раз.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['session_id'], properties: { session_id: sidProp } },
    },
    {
      name: 'telegram_pair_confirm',
      description: 'Сохранить привязку найденного чата по коду, который бот прислал пользователю в Telegram. Код вводит только пользователь — никогда не придумывай и не подбирай его.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['session_id', 'candidate_ref', 'code'], properties: { session_id: sidProp, candidate_ref: { type: 'string', description: 'candidate_ref из ответа telegram_pair_check' }, code: { type: 'string', description: '6 цифр, которые пользователь прочитал в сообщении бота и написал тебе' } } },
    },
  ];

  const need = () => { if (tokenError) throw new ToolError(`${tokenError} ${openSetup ? SETUP_HINT : ''}`.trim()); };

  function footerFor(m, binding) {
    return renderFooter({ botUsername: binding?.bot_username, chatId: binding?.chat_id, projectName, sessionId: m.session_id, sessionName: m.session_name });
  }

  function prepare(m, { file }) {
    const problems = validateMessage(m, { file });
    if (problems.length) throw new ToolError(`Сообщение не соответствует формату:\n- ${problems.join('\n- ')}`);
    const secrets = messageSecrets(m, { botToken });
    if (secrets.length) throw new ToolError(`В сообщении похоже на секрет (${secrets.join(', ')}) — плагин такое не отправляет. Уберите секрет из текста.`);
    return { body: renderBody(m), silent: silentFor(m, quiet) };
  }

  const warningsText = () => [quiet.warning, ...state.warnings].filter(Boolean).map((w) => `\nПредупреждение: ${w}`).join('');

  const handlers = {
    async send_telegram_message(m) {
      need();
      const { body, silent } = prepare(m, { file: false });
      const binding = pairing.currentBinding();
      if (m.dry_run) return `Предпросмотр (не отправлено${binding ? '' : ', чат не привязан'}):\n\n${packWithFooter(body.blocks, footerFor(m, binding)).map(htmlToText).join('\n\n— — —\n\n')}`;
      if (!binding) throw new ToolError(NOT_BOUND);
      const parts = packWithFooter(body.blocks, footerFor(m, binding));
      const ids = await tg.sendHtml(binding.chat_id, parts, { silent });
      state.journal({ tool: 'message', session: m.session_id.slice(0, 8), basis: m.basis, type: m.type, text_length: (m.text ?? '').length, parts: ids.length });
      return `Отправлено в Telegram (${binding.username ? '@' + binding.username : binding.chat_title})${silent ? ' без звука' : ''}. message_id: ${ids.join(', ')}${warningsText()}`;
    },

    async send_telegram_file(m) {
      need();
      const { body, silent } = prepare(m, { file: true });
      const binding = pairing.currentBinding();
      if (!binding && !m.dry_run) throw new ToolError(NOT_BOUND);
      const file = checkFile(m.path, { dataDir: ctx.dataDir, botToken });
      const footer = footerFor(m, binding);
      const asCaption = packWithFooter(body.blocks, footer, 1024);
      const [before, caption] = asCaption.length === 1 ? [[], asCaption[0]] : [packWithFooter(body.blocks, footer), `📎 ${body.headline}\n\n${footer}`];
      if (m.dry_run) return `Предпросмотр (не отправлено): файл ${file.filename}, ${file.size} байт\n\n${[...before, caption].map(htmlToText).join('\n\n— — —\n\n')}`;
      const ids = before.length ? await tg.sendHtml(binding.chat_id, before, { silent }) : [];
      try {
        ids.push(await tg.sendDocument(binding.chat_id, file, { caption, silent }));
      } catch (e) {
        if (!ids.length) throw e;
        // The header is already in the chat: tell the model so a retry does not resend it.
        throw new ToolError(`Текст сообщения уже доставлен в Telegram (message_id: ${ids.join(', ')}), но файл ${file.filename} отправить не удалось: ${e.message}\nНе отправляй текст повторно — при повторе отправь только файл.`);
      }
      state.journal({ tool: 'file', session: m.session_id.slice(0, 8), basis: m.basis, type: m.type, file: file.filename, size: file.size });
      return `Файл ${file.filename} отправлен в Telegram${silent ? ' без звука' : ''}. message_id: ${ids.join(', ')}${warningsText()}`;
    },

    async telegram_status(a = {}) {
      const lines = ['Плагин tg-ai-notify-lite'];
      if (tokenError) lines.push(`Токен: ${tokenError}${openSetup ? ' Задать: telegram_setup.' : ''}`);
      else {
        lines.push(`Токен: ${tokenSource === 'page' ? 'задан на странице настройки' : 'из настроек плагина'}`);
        const b = pairing.currentBinding();
        lines.push(b ? `Бот: @${b.bot_username}\nЧат: ${publicBinding(b).chat}\nПривязан: ${b.paired_at} из сессии ${publicBinding(b).paired_session}` : 'Чат не привязан.');
      }
      lines.push(`Тихие часы: ${quiet.enabled ? `${fmt(quiet.from)}–${fmt(quiet.to)}` : 'выключены'}`);
      lines.push(`Папка проекта в подписи: ${projectName || '—'}`);
      if (a.session_id) lines.push(`Текущая сессия: ${validateSessionId(a.session_id) ? 'ID не распознан' : a.session_id}`);
      return lines.join('\n') + warningsText();
    },

    async telegram_setup() {
      if (!openSetup) throw new ToolError(tokenError || 'Страница настройки недоступна.');
      const r = await openSetup();
      return [
        'Покажи пользователю ровно этот блок (ссылка отдельной строкой — в интерфейсе она выглядит как кнопка):',
        '',
        'Чтобы я мог писать вам в Telegram, нужен ваш собственный Telegram-бот. На странице ниже — пошаговая инструкция, как создать его за 2 минуты, и поле для его токена.',
        '',
        `### [⚙ Открыть страницу настройки бота](${r.url})`,
        '',
        'Страница открывается только на этом компьютере и работает 15 минут. Токен вводите там, а не в этот чат. Когда нажмёте «Сохранить» — напишите мне «готово».',
        '',
        `Когда пользователь ответит — продолжай исходную задачу, перезапуск не нужен. Страница работает до ${r.expires_at}.`,
      ].join('\n');
    },

    async telegram_pair_start(a = {}) {
      need();
      const r = await pairing.start({ sessionId: a.session_id, sessionName: a.session_name, replace: a.replace === true });
      return [
        `${r.replacing ? 'Перепривязка. ' : ''}Покажи пользователю ровно этот блок (ссылка отдельной строкой — в интерфейсе она выглядит как кнопка):`,
        '',
        `**Перейдите по ссылке и нажмите Start в Telegram:**`,
        '',
        `### [▶ Запустить Telegram-бота @${r.bot_username}](${r.link})`,
        '',
        'Отвечать мне не нужно — я жду нажатия до 3 минут, затем бот пришлёт вам в Telegram 6-значный код, его нужно будет написать сюда.',
        '',
        `Сразу после этого, не дожидаясь ответа, вызови telegram_pair_check. Ссылка действует до ${r.expires_at}.`,
      ].join('\n');
    },

    async telegram_pair_check(a = {}) {
      need();
      const r = await pairing.check({ sessionId: a.session_id });
      if (!r.found) return r.hint;
      return `Найден чат: ${r.candidate.description}\ncandidate_ref: ${r.candidate.ref}\nБот прислал в этот чат 6-значный код. Попроси пользователя написать тебе код из Telegram и вызови telegram_pair_confirm с этим кодом. Сам код не придумывай.`;
    },

    async telegram_pair_confirm(a = {}) {
      need();
      const r = await pairing.confirm({ sessionId: a.session_id, candidateRef: a.candidate_ref, code: a.code });
      return `Чат привязан: ${r.binding.chat}. Бот прислал подтверждение в чат. Теперь повтори исходную отправку.${r.warnings.map((w) => `\nПредупреждение: ${w}`).join('')}`;
    },
  };

  async function call(name, args) {
    const h = handlers[name];
    if (!h) return { content: [{ type: 'text', text: `Неизвестный инструмент ${name}` }], isError: true };
    try {
      return { content: [{ type: 'text', text: redact(await h(args ?? {})) }] };
    } catch (e) {
      const known = e instanceof ToolError || e instanceof PairingError || e instanceof FileRefused || e instanceof StateError;
      return { content: [{ type: 'text', text: redact(known ? e.message : `Ошибка: ${e.message}`) }], isError: true };
    }
  }

  return { list: () => tools, call };
}

const fmt = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
export const projectNameOf = (dir) => (dir ? basename(dir.replace(/[\\/]+$/, '')) : '');
