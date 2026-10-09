// Plugin state in ${CLAUDE_PLUGIN_DATA} (KTD18):
//   binding.json            — the single chat binding, written only on confirmation
//   pending/<session>.json  — one pairing issuance per Claude session (parallel sessions never clobber each other)
//   journal.log             — append-only send journal, rotated by size; never message text, paths or token
//   token.json              — bot token entered on the local setup page (owner-only file permissions)
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, appendFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const SCHEMA_VERSION = 1;
const JOURNAL_MAX_BYTES = 256 * 1024;
const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

export class StateError extends Error {}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Windows antivirus or another process may briefly hold the target open; retry a few times.
export function renameWithRetry(from, to, { attempts = 6, rename = renameSync } = {}) {
  for (let i = 1; ; i++) {
    try { return rename(from, to); } catch (e) {
      if (!RETRY_CODES.has(e.code) || i >= attempts) throw e;
      sleepSync(25 * i);
    }
  }
}

export function createState(dataDir, { rename } = {}) {
  if (!dataDir) throw new StateError('Не задана папка данных плагина (CLAUDE_PLUGIN_DATA). Переустановите плагин.');
  const pendingDir = join(dataDir, 'pending');
  const bindingPath = join(dataDir, 'binding.json');
  const journalPath = join(dataDir, 'journal.log');
  const tokenPath = join(dataDir, 'token.json');
  let readOnly = false;
  const warnings = [];

  mkdirSync(pendingDir, { recursive: true, mode: 0o700 });

  function readJson(path) {
    const warn = (w) => { if (!warnings.includes(w)) warnings.push(w); };
    let raw;
    try { raw = readFileSync(path, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    let data;
    try { data = JSON.parse(raw); } catch {
      warn(`Файл ${path} повреждён и проигнорирован.`);
      return null;
    }
    if ((data?.schema_version ?? 0) > SCHEMA_VERSION) {
      readOnly = true;
      warn('Состояние создано более новой версией плагина — работаю только на чтение. Перезапустите сессию Claude Code после обновления плагина.');
    }
    return data;
  }

  function writeJson(path, data) {
    if (readOnly) throw new StateError('Состояние создано более новой версией плагина — изменение запрещено. Перезапустите сессию Claude Code после обновления плагина.');
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...data, schema_version: SCHEMA_VERSION }, null, 2), { mode: 0o600 });
    try { renameWithRetry(tmp, path, { rename }); } catch (e) { rmSync(tmp, { force: true }); throw e; }
  }

  const pendingPath = (sessionId) => join(pendingDir, `${sessionId}.json`);

  return {
    warnings,
    get readOnly() { return readOnly; },
    readBinding: () => readJson(bindingPath),
    writeBinding: (b) => writeJson(bindingPath, b),
    readToken: () => readJson(tokenPath)?.token ?? null,
    writeToken: (token) => writeJson(tokenPath, { token, saved_at: new Date().toISOString() }),
    readPending: (sessionId) => readJson(pendingPath(sessionId)),
    writePending: (sessionId, p) => writeJson(pendingPath(sessionId), p),
    listPending() {
      return readdirSync(pendingDir).filter((f) => f.endsWith('.json')).map((f) => readJson(join(pendingDir, f))).filter(Boolean);
    },
    journal(entry) {
      try {
        if (statSync(journalPath, { throwIfNoEntry: false })?.size > JOURNAL_MAX_BYTES) renameWithRetry(journalPath, `${journalPath}.1`, { rename });
        appendFileSync(journalPath, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 });
      } catch { /* the journal is best-effort and must never block a send */ }
    },
  };
}
