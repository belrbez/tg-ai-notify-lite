// MCP stdio server: line-delimited JSON-RPC, as in tg-notify service mcp/mcp-server.mjs (commit 8c18a3f).
// stdout carries protocol only.
import { createInterface } from 'node:readline';
import { createTelegram, resolveApiBase } from './lib/telegram.mjs';
import { createState } from './lib/state.mjs';
import { createPairing, normalizeToken } from './lib/pairing.mjs';
import { parseQuietHours } from './lib/sound.mjs';
import { makeRedactor } from './lib/secrets.mjs';
import { createTools, projectNameOf } from './lib/tools.mjs';
import { createSetupPage } from './lib/setup-page.mjs';

const VERSION = '0.2.1';

export function run({ env = process.env, input = process.stdin, output = process.stdout, errors = process.stderr } = {}) {
  // Every token this process has seen is masked in all output, including ones replaced on the setup page.
  const redactors = [makeRedactor(String(env.TGN_BOT_TOKEN ?? ''))];
  const redact = (s) => redactors.reduce((acc, r) => r(acc), s);
  const remember = (token) => { if (token) redactors.push(makeRedactor(token)); };
  const logErr = (msg) => errors.write(redact(`[tg-ai-notify-lite] ${msg}`) + '\n');

  process.on('uncaughtException', (e) => { logErr(`необработанная ошибка: ${e?.stack ?? e}`); });
  process.on('unhandledRejection', (e) => { logErr(`необработанное отклонение: ${e?.stack ?? e}`); });

  const dataDir = env.TGN_DATA_DIR || env.CLAUDE_PLUGIN_DATA;
  const projectDir = env.TGN_PROJECT_DIR || env.CLAUDE_PROJECT_DIR || process.cwd();
  const send = (o) => output.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n');

  // Start-up can fail (no data folder, unwritable folder, bad API override). The protocol loop is attached
  // regardless so the client still gets initialize and a Russian explanation instead of vanished tools.
  let tools;
  try {
    const quiet = parseQuietHours(env.TGN_QUIET_HOURS);
    const state = createState(dataDir);
    const apiBase = resolveApiBase(env);
    const projectName = projectNameOf(projectDir);

    // A token saved on the setup page wins over the plugin setting: it is the user's most recent explicit choice.
    const saved = state.readToken();
    remember(saved);
    const fromPage = saved ? normalizeToken(saved) : null;
    const initial = fromPage?.token ? { ...fromPage, source: 'page' } : { ...normalizeToken(env.TGN_BOT_TOKEN), source: 'plugin' };

    const setup = createSetupPage({ apply: applyToken });

    const build = ({ token, error, source }) => {
      const tg = token ? createTelegram(token, { apiBase }) : null;
      const pairing = token ? createPairing({ tg, state, token }) : { currentBinding: () => null };
      return createTools({ tokenError: error, tokenSource: source, tg, state, pairing, quiet, projectName, redact, botToken: token, dataDir, openSetup: () => setup.open() });
    };

    async function applyToken(raw) {
      const { token, error } = normalizeToken(raw);
      if (error) return { error: `${error} Скопируйте токен из @BotFather целиком.` };
      remember(token);
      let me;
      try {
        me = await createTelegram(token, { apiBase, maxRetries: 0 }).call('getMe');
      } catch (e) {
        return { error: e.code === 401 ? 'Telegram не принял этот токен (401). Проверьте, что скопировали его полностью, или выпустите новый в @BotFather.' : redact(e.message) };
      }
      try { state.writeToken(token); } catch (e) { return { error: `Не удалось сохранить токен: ${redact(e.message)}` }; }
      tools = build({ token, source: 'page' });
      return { botUsername: me.username };
    }

    tools = build(initial);
  } catch (e) {
    tools = startupFailedTools(e, redact);
    logErr(`не удалось запустить: ${e?.stack ?? e}`);
  }

  createInterface({ input }).on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return send({ id: null, error: { code: -32700, message: 'Parse error' } }); }
    const { id, method, params } = msg;
    if (id === undefined || method === undefined) return; // notifications and stray responses
    switch (method) {
      case 'initialize':
        return send({ id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'tg-ai-notify-lite', version: VERSION } } });
      case 'ping':
        return send({ id, result: {} });
      case 'tools/list':
        return send({ id, result: { tools: tools.list() } });
      case 'tools/call':
        return send({ id, result: await tools.call(params?.name, params?.arguments) });
      default:
        return send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  });
}

// Keep in sync with the tool list in lib/tools.mjs and TOOL_NAMES in index.mjs.
const FALLBACK_TOOL_NAMES = ['send_telegram_message', 'send_telegram_file', 'telegram_status', 'telegram_setup', 'telegram_pair_start', 'telegram_pair_check', 'telegram_pair_confirm'];

function startupFailedTools(error, redact) {
  const text = redact(`Плагин tg-ai-notify-lite не запустился: ${error?.message ?? error}
` +
    'Проверьте, что папка данных плагина (CLAUDE_PLUGIN_DATA) существует и доступна для записи, и перезапустите сессию Claude Code. ' +
    'Если не помогло — переустановите плагин (/plugin → tg-ai-notify-lite).');
  let list;
  try {
    list = createTools({ tokenError: text, tg: null, state: null, pairing: { currentBinding: () => null }, quiet: { enabled: false }, projectName: '', redact, botToken: null }).list();
  } catch {
    list = FALLBACK_TOOL_NAMES.map((name) => ({ name, description: text, inputSchema: { type: 'object' } }));
  }
  return { list: () => list, call: async () => ({ content: [{ type: 'text', text }], isError: true }) };
}
