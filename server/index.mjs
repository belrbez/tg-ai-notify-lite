// Entry point (KTD12). Written in conservative syntax so an old Node can parse it and explain
// the problem instead of dying silently. On Node 22+ it loads every module at start-up.
var MIN_NODE = 22;
var major = parseInt(String(process.versions.node).split('.')[0], 10);

if (major >= MIN_NODE) {
  // .catch (not a second .then argument) so a synchronous throw from run() also reaches the message.
  import('./main.mjs').then(function (m) { m.run(); }).catch(function (e) {
    process.stderr.write('[tg-ai-notify-lite] не удалось запустить сервер: ' + (e && e.message) + '\n');
    process.exit(1);
  });
} else {
  var NODE_MSG = 'Плагину tg-ai-notify-lite нужен Node.js ' + MIN_NODE + ' или новее, а установлен ' + process.versions.node +
    '. Установите актуальную LTS-версию с https://nodejs.org и перезапустите Claude Code.';
  var TOOL_NAMES = ['send_telegram_message', 'send_telegram_file', 'telegram_status', 'telegram_setup', 'telegram_pair_start', 'telegram_pair_check', 'telegram_pair_confirm'];
  var send = function (o) { o.jsonrpc = '2.0'; process.stdout.write(JSON.stringify(o) + '\n'); };
  var buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', function (chunk) {
    buf += chunk;
    var i;
    while ((i = buf.indexOf('\n')) >= 0) {
      var line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      var msg;
      try { msg = JSON.parse(line); } catch (e) { continue; }
      if (msg.id === undefined || msg.id === null) continue;
      if (msg.method === 'initialize') {
        send({ id: msg.id, result: { protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'tg-ai-notify-lite', version: '0.2.1' }, instructions: NODE_MSG } });
      } else if (msg.method === 'tools/list') {
        send({ id: msg.id, result: { tools: TOOL_NAMES.map(function (n) { return { name: n, description: NODE_MSG, inputSchema: { type: 'object' } }; }) } });
      } else if (msg.method === 'tools/call') {
        send({ id: msg.id, result: { content: [{ type: 'text', text: NODE_MSG }], isError: true } });
      } else {
        send({ id: msg.id, result: {} });
      }
    }
  });
}
