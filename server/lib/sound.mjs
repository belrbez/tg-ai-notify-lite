// Quiet hours and notification sound (KTD14). Logic ported from tg-notify service
// server.mjs isQuiet()/silentFor() (commit 8c18a3f); interval comes from plugin settings.

// Off unless the user sets an interval in the plugin settings.
export const DEFAULT_QUIET = 'off';
const SILENT_TYPES = new Set(['info', 'report']);
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

// Returns { enabled, from, to } in minutes, plus a warning when the setting was invalid.
export function parseQuietHours(raw) {
  const value = String(raw ?? '').trim();
  if (!value || value.includes('${')) return parseQuietHours(DEFAULT_QUIET);
  if (value.toLowerCase() === 'off') return { enabled: false };
  const [a, b, ...rest] = value.split('-').map((x) => x.trim());
  const ma = HHMM.exec(a ?? ''), mb = HHMM.exec(b ?? '');
  if (!ma || !mb || rest.length) {
    return { ...parseQuietHours(DEFAULT_QUIET), warning: `Настройка тихих часов «${value}» не распознана (нужно HH:MM-HH:MM или off), тихие часы выключены.` };
  }
  return { enabled: true, from: +ma[1] * 60 + +ma[2], to: +mb[1] * 60 + +mb[2] };
}

export function isQuiet(quiet, now = new Date()) {
  if (!quiet.enabled || quiet.from === quiet.to) return false;
  const m = now.getHours() * 60 + now.getMinutes();
  return quiet.from < quiet.to ? m >= quiet.from && m < quiet.to : m >= quiet.from || m < quiet.to;
}

export function silentFor(msg, quiet, now = new Date()) {
  if (msg.urgent) return false;
  if (isQuiet(quiet, now)) return true;
  return msg.silent ?? SILENT_TYPES.has(msg.type);
}
