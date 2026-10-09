// Secret handling: redact the bot token from every output (KTD10) and refuse
// to send text or file content that looks like a secret (KTD17, R20, R21).

const MASK = '[скрыто]';

export function makeRedactor(token) {
  const needles = new Set();
  if (token && token.length >= 8) {
    needles.add(token);
    needles.add(encodeURIComponent(token));
    const secret = token.includes(':') ? token.slice(token.indexOf(':') + 1) : '';
    if (secret.length >= 16) {
      needles.add(secret);
      needles.add(encodeURIComponent(secret));
    }
  }
  const list = [...needles].sort((a, b) => b.length - a.length);
  return (value) => {
    let s = typeof value === 'string' ? value : String(value ?? '');
    for (const n of list) s = s.split(n).join(MASK);
    // Never leak Bot API URLs even if the token variant was not recognised.
    return s.replace(/\/bot[^/\s]+\//g, `/bot${MASK}/`);
  };
}

const PATTERNS = [
  { re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/, why: 'закрытый ключ' },
  { re: /PuTTY-User-Key-File-\d/, why: 'ключ PuTTY' },
  { re: /\b\d{6,12}:AA[A-Za-z0-9_-]{30,}\b/, why: 'токен Telegram-бота' },
  { re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, why: 'ключ AWS' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{50,}\b/, why: 'токен GitHub' },
  { re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/, why: 'ключ Anthropic API' },
  { re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/, why: 'ключ OpenAI API' },
];

// Returns a list of reasons (empty = nothing found).
export function findSecrets(text, { botToken } = {}) {
  if (!text) return [];
  const s = String(text);
  const found = new Set();
  if (botToken && botToken.length >= 8 && s.includes(botToken)) found.add('токен этого бота');
  for (const { re, why } of PATTERNS) if (re.test(s)) found.add(why);
  return [...found];
}

// Scan every user-visible string of a message.
export function messageSecrets(m, opts) {
  const parts = [m.title, m.text, m.project, m.session_name, ...Object.keys(m.fields ?? {}), ...Object.values(m.fields ?? {}).map(String), ...(m.links ?? []).flatMap((l) => [l?.url, l?.label])];
  return findSecrets(parts.filter(Boolean).join('\n'), opts);
}
