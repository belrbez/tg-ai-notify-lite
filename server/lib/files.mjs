// File checks before sending (KTD11, R11, R20): absolute local paths only, secret names and folders
// refused, one open handle checked and read, first kilobytes scanned for secrets.
import { openSync, fstatSync, readSync, closeSync, realpathSync } from 'node:fs';
import { isAbsolute, basename, join, sep } from 'node:path';
import { homedir } from 'node:os';
import { findSecrets } from './secrets.mjs';

export const MAX_FILE_BYTES = 50 * 1024 * 1024;
const SNIFF_BYTES = 8 * 1024;

export class FileRefused extends Error {}

const DENIED_NAMES = [
  /^\.env(rc)?(\..*)?$/,
  /\.env$/,
  /\.(pem|key|p12|pfx|ppk|kdbx|tfstate)$/,
  /\.(tfvars|jks|keystore)$/,
  /^\.htpasswd$/,
  /^secrets?\.(json|ya?ml|toml)$/,
  /^id_(rsa|ed25519|ecdsa|dsa)(\..*)?$/,
  /^credentials(\..*)?$/,
  /^(\.npmrc|\.netrc|\.git-credentials|\.pypirc|\.claude\.json)$/,
  /^(login data|cookies)$/,
];

function deniedDirs({ home, dataDir, env }) {
  const dirs = ['.ssh', '.gnupg', '.aws', '.docker', '.kube', '.claude', join('.config', 'gcloud')].map((d) => join(home, d));
  if (env.APPDATA) dirs.push(join(env.APPDATA, 'Claude'));
  if (dataDir) dirs.push(dataDir);
  return dirs;
}

const refuse = (why) => { throw new FileRefused(why); };

export function checkFile(rawPath, { dataDir, botToken, home = homedir(), env = process.env, platform = process.platform, maxBytes = MAX_FILE_BYTES } = {}) {
  const win = platform === 'win32';
  const fold = (s) => (win || platform === 'darwin' ? s.toLowerCase() : s);
  if (typeof rawPath !== 'string' || !rawPath.trim()) refuse('Укажите путь к файлу.');
  let p = rawPath.trim();

  // 1. Only plain absolute local paths; checked before any filesystem call (no SMB lookups).
  if (/^[\\/]{2}/.test(p)) refuse('Сетевые и служебные пути (\\\\server\\…, \\\\?\\…) не поддерживаются — укажите обычный путь к локальному файлу.');
  if (!isAbsolute(p)) refuse('Нужен абсолютный путь к файлу (например C:\\Users\\…\\report.xlsx).');
  if (win && p.indexOf(':', 2) !== -1) refuse('Путь содержит «:» после буквы диска — такие пути (потоки NTFS) не отправляются.');

  // 2. Win32 silently drops trailing dots and spaces; normalise before matching ('.' and '..' stay as-is).
  if (win) p = p.split(/[\\/]/).map((seg, i) => (i === 0 || seg === '.' || seg === '..' ? seg : seg.replace(/[. ]+$/, ''))).join(sep);

  let real;
  try { real = realpathSync.native(p); } catch (e) {
    refuse(e.code === 'ENOENT' ? `Файл не найден: ${p}` : `Не удалось открыть путь: ${e.code ?? e.message}`);
  }

  // 3. Secret-looking names and folders.
  // Secret-looking names are refused in any letter case on every OS: CREDENTIALS.json is as secret as credentials.json.
  const name = basename(real).toLowerCase();
  if (DENIED_NAMES.some((re) => re.test(name))) refuse(`Файл «${basename(real)}» похож на секрет (ключ, пароли, токены) — плагин такие файлы не отправляет.`);
  const target = fold(real);
  for (const dir of deniedDirs({ home, dataDir, env })) {
    let d = dir;
    try { d = realpathSync.native(dir); } catch { /* folder may not exist */ }
    const fd = fold(d);
    if (target === fd || target.startsWith(fd.endsWith(sep) ? fd : fd + sep)) refuse(`Файлы из папки ${dir} плагин не отправляет — там хранятся ключи и настройки.`);
  }

  // 4. One handle: validate and read the very file that will be sent.
  let fh;
  try { fh = openSync(real, 'r'); } catch (e) { refuse(`Не удалось открыть файл (${e.code ?? e.message}). Возможно, он занят другой программой.`); }
  try {
    const st = fstatSync(fh);
    if (st.isDirectory()) refuse('Это папка, а не файл. Заархивируйте её и отправьте архив.');
    if (!st.isFile()) refuse('Это не обычный файл.');
    if (st.size === 0) refuse('Файл пустой — Telegram не принимает пустые файлы.');
    if (st.size > maxBytes) refuse(`Файл больше ${Math.round(maxBytes / 1048576)} MB (лимит Telegram для ботов). Заархивируйте или разделите его.`);
    if (st.nlink > 1) refuse('У файла несколько жёстких ссылок — такой файл не отправляется, скопируйте его в обычный файл.');
    const data = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fh, data, off, st.size - off, off);
      if (!n) break;
      off += n;
    }
    // 5. Content sniff for secrets.
    const found = findSecrets(data.subarray(0, SNIFF_BYTES).toString('utf8'), { botToken });
    if (found.length) refuse(`В начале файла похоже на секрет (${found.join(', ')}) — плагин его не отправляет.`);
    return { data: data.subarray(0, off), filename: basename(real), size: off };
  } finally {
    closeSync(fh);
  }
}
