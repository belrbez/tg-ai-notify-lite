// Unified tg-notify message format: schema, validation, Telegram rendering.
// Copied from tg-notify service lib/message.mjs (commit 8c18a3f) and adapted for the Lite plugin:
// no chat/source fields, required Claude session fields, and a service footer on every part.

export const TYPES = {
  success: { emoji: '✅', label: 'Готово' },
  error: { emoji: '❌', label: 'Ошибка' },
  warning: { emoji: '⚠️', label: 'Внимание' },
  info: { emoji: 'ℹ️', label: 'Инфо' },
  question: { emoji: '❓', label: 'Нужен ответ' },
  report: { emoji: '📊', label: 'Отчёт' },
};

export const BASIS = ['user_request', 'user_task'];

// The sender is always Claude in the Lite plugin.
export const SENDER = { name: 'claude', title: 'Claude', emoji: '🧠' };

const LIMITS = { title: 120, text: 20000, project: 40, sessionName: 40, fields: 15, fieldKey: 40, fieldValue: 300, links: 5, linkLabel: 60, tags: 5, tag: 30 };
const TAG_RE = /^[\p{L}\p{N}_]{1,30}$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MESSAGE_PROPERTIES = {
  type: { enum: Object.keys(TYPES), description: 'success — задача выполнена; error — сбой, нужна реакция; warning — нештатно, но работает; info — к сведению; question — нужен ответ человека; report — сводка/цифры' },
  title: { type: 'string', minLength: 1, maxLength: LIMITS.title, description: 'Суть одной строкой: что произошло' },
  project: { type: 'string', maxLength: LIMITS.project, description: 'К какому проекту относится ("WB", "сайт"). Станет хештегом' },
  text: { type: 'string', maxLength: LIMITS.text, description: 'Подробности простым текстом, без разметки' },
  fields: { type: 'object', maxProperties: LIMITS.fields, additionalProperties: { type: ['string', 'number', 'boolean'] }, description: 'Ключевые цифры: {"Строк": 1520}' },
  links: { type: 'array', maxItems: LIMITS.links, items: { type: 'object', required: ['url'], additionalProperties: false, properties: { url: { type: 'string', pattern: '^https?://' }, label: { type: 'string', maxLength: LIMITS.linkLabel } } } },
  tags: { type: 'array', maxItems: LIMITS.tags, items: { type: 'string', pattern: TAG_RE.source }, description: 'Доп. хештеги без #' },
  session_id: { type: 'string', description: 'ID текущей сессии Claude — ровно строка из скилла telegram. Никогда не придумывай его' },
  session_name: { type: 'string', minLength: 1, maxLength: LIMITS.sessionName, description: 'Название сессии: из /rename, если пользователь его сообщил, иначе короткое название разговора' },
  basis: { enum: BASIS, description: 'user_request — пользователь попросил в этом разговоре; user_task — это часть заданной пользователем задачи' },
  silent: { type: 'boolean', description: 'Без звука' },
  urgent: { type: 'boolean', description: 'Со звуком даже в тихие часы — только для действительно срочного' },
  dry_run: { type: 'boolean', description: 'Не отправлять, вернуть как будет выглядеть' },
};

const REQUIRED = ['type', 'title', 'session_id', 'session_name', 'basis'];

export function messageSchema({ file = false } = {}) {
  const properties = { ...MESSAGE_PROPERTIES };
  if (file) properties.path = { type: 'string', description: 'Абсолютный путь к файлу на этом компьютере' };
  return { type: 'object', additionalProperties: false, required: file ? ['path', ...REQUIRED] : REQUIRED, properties };
}

export function validateSessionId(id) {
  if (typeof id !== 'string' || !id) return 'session_id: обязательное поле — ID сессии из скилла telegram';
  if (id.includes('${')) return 'session_id: Claude Code не подставил ID сессии — обновите Claude Code до последней версии';
  if (!UUID_RE.test(id)) return 'session_id: должен быть ID сессии Claude (UUID) из скилла telegram, не придумывайте его';
  return null;
}

// Returns a list of human-readable problems (empty = valid).
export function validateMessage(m, { file = false } = {}) {
  const e = [];
  if (!m || typeof m !== 'object' || Array.isArray(m)) return ['аргументы должны быть JSON-объектом'];
  const allowed = new Set(Object.keys(messageSchema({ file }).properties));
  const str = (k, max, req = false) => {
    if (m[k] === undefined) return req && e.push(`${k}: обязательное поле`);
    if (typeof m[k] !== 'string' || (req && !m[k].trim())) return e.push(`${k}: строка`);
    if (m[k].length > max) e.push(`${k}: не длиннее ${max} символов (сейчас ${m[k].length})`);
  };
  for (const k of Object.keys(m)) if (!allowed.has(k)) e.push(`${k}: неизвестное поле (допустимо: ${[...allowed].join(', ')})`);
  const typeList = Object.keys(TYPES).join(' | ');
  if (m.type === undefined) e.push(`type: обязательное поле — ${typeList}`);
  else if (!(m.type in TYPES)) e.push(`type: "${m.type}" — допустимо ${typeList}`);
  str('title', LIMITS.title, true);
  if (typeof m.title === 'string' && m.title.includes('\n')) e.push('title: одна строка, подробности — в text');
  str('project', LIMITS.project);
  str('text', LIMITS.text);
  const sid = validateSessionId(m.session_id);
  if (sid) e.push(sid);
  str('session_name', LIMITS.sessionName, true);
  const basisList = BASIS.join(' | ');
  if (m.basis === undefined) e.push(`basis: обязательное поле — ${basisList}`);
  else if (!BASIS.includes(m.basis)) e.push(`basis: "${m.basis}" — допустимо ${basisList}`);
  if (m.fields !== undefined) {
    const entries = m.fields && typeof m.fields === 'object' && !Array.isArray(m.fields) ? Object.entries(m.fields) : null;
    if (!entries) e.push('fields: объект {"ключ": значение}');
    else {
      if (entries.length > LIMITS.fields) e.push(`fields: не больше ${LIMITS.fields} пар`);
      for (const [k, v] of entries) {
        if (k.length > LIMITS.fieldKey) e.push(`fields."${k}": ключ не длиннее ${LIMITS.fieldKey}`);
        if (!['string', 'number', 'boolean'].includes(typeof v)) e.push(`fields."${k}": строка, число или boolean`);
        else if (String(v).length > LIMITS.fieldValue) e.push(`fields."${k}": значение не длиннее ${LIMITS.fieldValue}`);
      }
    }
  }
  if (m.links !== undefined) {
    if (!Array.isArray(m.links) || m.links.length > LIMITS.links) e.push(`links: массив до ${LIMITS.links} объектов {url, label}`);
    else m.links.forEach((l, i) => {
      if (typeof l?.url !== 'string' || !/^https?:\/\/\S+$/.test(l.url)) e.push(`links[${i}].url: http(s)-ссылка`);
      if (l?.label !== undefined && (typeof l.label !== 'string' || l.label.length > LIMITS.linkLabel)) e.push(`links[${i}].label: строка до ${LIMITS.linkLabel}`);
    });
  }
  if (m.tags !== undefined) {
    if (!Array.isArray(m.tags) || m.tags.length > LIMITS.tags) e.push(`tags: массив до ${LIMITS.tags} строк`);
    else m.tags.forEach((t, i) => (typeof t === 'string' && TAG_RE.test(t)) || e.push(`tags[${i}]: буквы/цифры/_ без #, до ${LIMITS.tag}`));
  }
  for (const k of ['silent', 'urgent', 'dry_run']) if (m[k] !== undefined && typeof m[k] !== 'boolean') e.push(`${k}: true/false`);
  if (file && (typeof m.path !== 'string' || !m.path)) e.push('path: обязательное поле — абсолютный путь к файлу');
  return e;
}

export const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const hashtag = (s) => '#' + String(s).replace(/[^\p{L}\p{N}_]+/gu, '_').replace(/^_+|_+$/g, '');
// Strip control characters and newlines from externally supplied labels.
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e]', 'g');
export const cleanLabel = (s, max = 60) => String(s ?? '').replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Message body exactly as the tg-notify service renders it for sender SENDER:
 *   ✅ Готово · 🧠 Claude
 *   <b>Title</b>
 *
 *   text…
 *
 *   Ключ: значение
 *   🔗 ссылки
 *   #claude #проект #теги · 27.09 14:32
 */
export function renderBody(m, { timezone, now = new Date() } = {}) {
  const t = TYPES[m.type];
  const who = `${SENDER.emoji} ${escapeHtml(SENDER.title)}`;
  const blocks = [{ html: `${t.emoji} <b>${t.label}</b> · ${who}\n<b>${escapeHtml(m.title)}</b>` }];

  for (const chunk of splitText(m.text ?? '', 3000)) blocks.push({ html: escapeHtml(chunk), sep: '\n\n' });

  const fields = Object.entries(m.fields ?? {});
  fields.forEach(([k, v], i) => blocks.push({ html: `<b>${escapeHtml(k)}:</b> ${escapeHtml(v)}`, sep: i ? '\n' : '\n\n' }));

  if (m.links?.length) {
    const links = m.links.map((l) => `<a href="${escapeHtml(l.url)}">${escapeHtml(l.label || new URL(l.url).host)}</a>`).join(' · ');
    blocks.push({ html: `🔗 ${links}`, sep: fields.length ? '\n' : '\n\n' });
  }

  const tags = [SENDER.name, m.project, ...(m.tags ?? [])].filter(Boolean).map(hashtag);
  const time = new Intl.DateTimeFormat('ru-RU', { timeZone: timezone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(now).replace(',', '');
  blocks.push({ html: `<i>${[...new Set(tags)].join(' ')} · ${time}</i>`, sep: '\n\n' });

  return { blocks, headline: blocks[0].html };
}

// Short session id plus cleaned session name, e.g. 3f2a9c1e «рефакторинг парсера».
export const sessionTag = (sessionId, sessionName) => `${String(sessionId).slice(0, 8)} «${cleanLabel(sessionName, LIMITS.sessionName)}»`;

// Service line under every message part (R18): bot, recipient chat, project folder, short session id and name.
export function renderFooter({ botUsername, chatId, projectName, sessionId, sessionName }) {
  const parts = [
    `🤖 @${escapeHtml(botUsername || 'bot')} → ${escapeHtml(chatId ?? '—')}`,
    projectName ? `📁 ${escapeHtml(projectName)}` : null,
    `сессия ${escapeHtml(sessionTag(sessionId, sessionName))}`,
  ].filter(Boolean);
  return `<code>${parts.join(' · ')}</code>`;
}

// Greedily packs blocks into Telegram messages; each message gets the footer appended (KTD9).
export function packWithFooter(blocks, footer, limit = 4096) {
  const room = limit - footer.length - 2;
  const out = [];
  let cur = '';
  for (const { html, sep = '' } of blocks) {
    for (const piece of html.length > room ? splitHtmlBlock(html, room) : [html]) {
      if (cur && cur.length + sep.length + piece.length > room) { out.push(cur); cur = piece; }
      else cur = cur ? cur + sep + piece : piece;
    }
  }
  if (cur) out.push(cur);
  return out.map((m) => `${m}\n\n${footer}`);
}

// A single block larger than the room is plain escaped text (text chunks); split it on entity-safe boundaries.
function splitHtmlBlock(html, room) {
  const out = [];
  let rest = html;
  while (rest.length > room) {
    let cut = rest.lastIndexOf('\n', room);
    if (cut < room / 2) cut = rest.lastIndexOf(' ', room);
    if (cut < room / 2) cut = room;
    const amp = rest.lastIndexOf('&', cut);
    if (amp > cut - 6 && rest.indexOf(';', amp) >= cut) cut = amp;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest) out.push(rest);
  return out;
}

// Split plain text on paragraph/line/space boundaries so each chunk's *escaped* form fits.
export function splitText(text, limit) {
  const chunks = [];
  let rest = text.trim();
  while (rest.length) {
    let size = Math.min(rest.length, limit);
    while (escapeHtml(rest.slice(0, size)).length > limit) size = Math.floor(size * 0.8);
    if (size < rest.length) {
      const window = rest.slice(0, size);
      let cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'));
      if (cut < size / 2) cut = window.lastIndexOf(' ');
      if (cut >= size / 2) size = cut;
    }
    chunks.push(rest.slice(0, size).trimEnd());
    rest = rest.slice(size).trimStart();
  }
  return chunks;
}

// For the plain-text fallback if Telegram ever rejects the HTML.
export const htmlToText = (html) =>
  html.replace(/<a href="([^"]*)">([^<]*)<\/a>/g, '$2 ($1)').replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
