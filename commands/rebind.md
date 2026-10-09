---
description: Перепривязать плагин tg-ai-notify-lite к другому чату Telegram (или к новому боту)
disable-model-invocation: true
allowed-tools: mcp__plugin_tg-ai-notify-lite_telegram__telegram_setup, mcp__plugin_tg-ai-notify-lite_telegram__telegram_pair_start, mcp__plugin_tg-ai-notify-lite_telegram__telegram_pair_check, mcp__plugin_tg-ai-notify-lite_telegram__telegram_pair_confirm, mcp__plugin_tg-ai-notify-lite_telegram__telegram_status
---

Пользователь сам запустил перепривязку чата Telegram для плагина tg-ai-notify-lite.

ID текущей сессии Claude: `${CLAUDE_SESSION_ID}`

1. Вызови `telegram_status`, покажи пользователю, к какому боту и чату плагин привязан сейчас.
2. Если пользователь хочет сменить **бота**, вызови `telegram_setup` и дай ссылку на страницу, где он вставит новый токен. Токен в чат не проси. Привязка к прежнему боту после смены перестанет действовать — дальше пункт 3 без `replace`.
3. Вызови `telegram_pair_start` с `session_id` (ровно ID выше), `session_name` (короткое название текущего разговора) и `replace: true` (если чат уже привязан к текущему боту).
4. Покажи ссылку так, как написано в ответе `telegram_pair_start` (отдельной строкой-кнопкой), и попроси открыть её в том аккаунте Telegram, куда нужно получать сообщения, и нажать **Start**. Отвечать не нужно.
5. Сразу, не дожидаясь ответа, вызови `telegram_pair_check` — он ждёт нажатия до 3 минут. Если не дождался — попроси написать «нажал», когда сделает, и вызови ещё раз. Бот пришлёт в этот чат 6-значный код — попроси пользователя написать его тебе. Код никогда не придумывай.
6. Вызови `telegram_pair_confirm` с `candidate_ref` и кодом пользователя.
7. Сообщи результат. Прежний чат получит уведомление о переносе привязки.
