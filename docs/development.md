# Разработка

Команды репозитория, запуск плагина из рабочей копии и отладка. Порядок работы с PR — в [CONTRIBUTING.md](../CONTRIBUTING.md), правила кода — в [AGENTS.md](../AGENTS.md).

## Команды

```bash
npm test          # все тесты (node:test), так же, как в CI
npm run validate  # claude plugin validate --strict для marketplace и плагина (нужен `claude` в PATH)
npm run check     # тесты + проверка
```

Нужен только Node.js 22+. `npm install` не нужен — зависимостей нет.

## Запуск плагина из рабочей копии

Установка через marketplace кэширует снимок репозитория, поэтому для разработки загружайте плагин прямо из папки:

```bash
claude --plugin-dir .
```

В такой сессии работают скилл `tg-ai-notify-lite:telegram`, команда `/tg-ai-notify-lite:rebind` и MCP-сервер из `server/`. После правок начните новую сессию — сервер и скилл читаются при старте.

Если у вас установлен и опубликованный плагин, на время разработки отключите его, чтобы не было двух серверов с одинаковыми инструментами:

```bash
claude plugin disable tg-ai-notify-lite@tg-ai-notify-lite
```

Вернуть: `claude plugin enable tg-ai-notify-lite@tg-ai-notify-lite`.

## Проверка на настоящем боте

1. Заведите **отдельного тестового бота** в @BotFather — не используйте бота, который работает где-то ещё.
2. В сессии `claude --plugin-dir .` попросите «пришли мне в тг тест». Claude даст ссылку на страницу настройки — вставьте токен там. Токен в чат не вставляйте.
3. Пройдите привязку: ссылка → Start → 6 цифр из Telegram → Claude.
4. Ручные проверки перед выпуском — в [ACCEPTANCE.md](ACCEPTANCE.md).

Состояние плагина (токен со страницы, привязка, журнал) лежит в папке данных плагина `~/.claude/plugins/data/<плагин>-<marketplace>/`. Чтобы начать «с нуля», удалите из неё `binding.json` и `token.json`.

## Отладка MCP-сервера вручную

Сервер общается построчным JSON-RPC через stdin/stdout. Его можно запустить без Claude Code с поддельным Telegram из тестов:

```bash
TGN_TEST_MODE=1 TGN_API_BASE=http://127.0.0.1:<порт поддельного API> \
TGN_DATA_DIR=/tmp/tgn-data TGN_BOT_TOKEN= node server/index.mjs
```

и отправить ему строки:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"capabilities":{}}}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"telegram_status","arguments":{}}}
```

Пример целиком — функция `startServer` в `test/server.test.mjs`.

| Переменная | Откуда в плагине | Назначение |
|---|---|---|
| `TGN_BOT_TOKEN` | `${user_config.bot_token}` | токен из `/plugin` (токен со страницы настройки главнее) |
| `TGN_QUIET_HOURS` | `${user_config.quiet_hours}` | `HH:MM-HH:MM` или `off` (по умолчанию `off`) |
| `TGN_DATA_DIR` | `${CLAUDE_PLUGIN_DATA}` | папка состояния |
| `TGN_PROJECT_DIR` | `${CLAUDE_PROJECT_DIR}` | имя папки проекта для подписи |
| `TGN_TEST_MODE`, `TGN_API_BASE` | — | только тесты: подмена адреса Telegram API на локальный |

## Выпуск версии

1. Поднимите версию в четырёх местах (см. [AGENTS.md](../AGENTS.md#рабочие-договорённости)) и добавьте раздел в [CHANGELOG.md](../CHANGELOG.md).
2. PR → зелёный CI → слияние в `main`.
3. Пользователи обновляются так:

   ```bash
   claude plugin marketplace update tg-ai-notify-lite
   claude plugin update tg-ai-notify-lite@tg-ai-notify-lite
   ```

   и начинают новую сессию.
