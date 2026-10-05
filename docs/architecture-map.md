# Карта кода

Где что лежит — по одной строке на файл. Подробности — в шапке каждого файла (1–3 строки `//`) и в ADR. Обновлять вместе с добавлением/переносом файлов.

## Путь сообщения

```
Telegram → POST /telegram/webhook (src/index.ts)
  → bot/gate.ts (посторонние, группы — ответ сразу)
  → inbox.ts: запись в D1 (дедуп по update_id) → 200
  → waitUntil: process.ts → bot/handle-update.ts        (очередь INBOX — страховка через 60 с)
       handleUpdate → handleCommand → runCommand: /команды, ответы на вопросы (dialog_state), пересланное
                   → recognizeVoice (stt/whisper.ts)  → nlu/intents.ts (LLM, nlu/llm.ts)
                   → routeIntent: nlu/intent-overrides.ts → bot/{read-events,event-lookup,create-event,modify-event,delete-event,undo}.ts
                   → handleCallback: нажатия кнопок карточек (pending_actions)
       → calendar/google-provider.ts → google/calendar-api.ts → Google
       → telegram/api.ts → Telegram
cron (каждую минуту) → scheduler.ts:tick → очередь → runQueuedJob (jobs/digest.ts); раз в час — cleanup, ensureDigests
```

В TEST_MODE обработку запускает раннер через `/__test/drain`, часы — `/__test/clock` (src/testing/routes.ts).

## Где искать фичу

| Нужно | Смотреть |
|---|---|
| Новый интент / поле интента | `src/nlu/intents.ts` (схемы tools, промпт), `docs/intents.md`, `testdata/nlu/intents.yaml`; маршрут — `routeIntent` в `src/bot/handle-update.ts` |
| Разбор дат, длительностей, повторений | `src/dates/*` + `testdata/dates/*.yaml` (правила — `docs/date-rules.md`) |
| Даты из всего сообщения, название без дат | `src/dates/extract.ts` + `testdata/extract/*.yaml` |
| Тексты ответов бота | `src/bot/messages.ts` (RU/EN), форматирование — `src/bot/format.ts`, `format-events.ts` |
| Кнопки и карточки подтверждения | `src/bot/keyboards.ts`, `src/db/conversations.ts` (pending_actions), `handleCallback` |
| Настройки пользователя | `src/bot/settings.ts`, `src/db/settings.ts` |
| Схема БД | `migrations/*.sql` (только новые файлы), доступ — `src/db/*` |
| Внешние URL, лимиты, цены | `src/config.ts` |
| Провайдеры LLM/STT, цепочки | `src/nlu/llm.ts`, `src/stt/whisper.ts`, `src/voice/understand.ts`; сборка цепочек — `scripts/deploy.ts` |
| Админка | `src/admin/*`, `docs/admin-console.md` |
| Поведение для приёмочного теста | `acceptance/scenarios/NN-*.yaml`, шаги — тип `Step` в `acceptance/runner.ts`, фейки — `acceptance/fakes/server.ts` |

## src/

| Файл | Назначение |
|---|---|
| `index.ts` | Точка входа Worker: `fetch` (webhook, OAuth, админка, страницы, `/__test/*`), `queue` (inbox и задачи), `scheduled` (cron) |
| `process.ts` | Обработка апдейта из inbox — общая для очереди, `waitUntil` и `/__test/drain` |
| `inbox.ts` | Inbox в D1: дедупликация, атомарный захват (pending → processing → done) |
| `scheduler.ts` | Планировщик `scheduled_jobs`: tick раздаёт в очередь, повторы с backoff, `cleanup` (ретеншн) |
| `config.ts` | Конфиг из Env: URL внешних API, цепочки провайдеров, `USAGE_LIMITS`, `COST_ESTIMATES` |
| `clock.ts` | Внедряемые часы; в TEST_MODE «сейчас» хранится в D1 |
| `crypto.ts` | AES-GCM для refresh token, сравнение за постоянное время |
| `limits.ts` | Лимиты расходов на пользователя (час/сутки), оценка стоимости |
| `env.d.ts` | Секреты в типе `Env` (`wrangler types` их не знает) |
| `oauth-routes.ts` | `/oauth/google/*`: промежуточная страница, PKCE, привязка к браузеру, callback |
| `pages.ts` | Публичные страницы (homepage, privacy, terms) — заглушки до R3 |
| **bot/** | Сценарии и рендер ответов |
| `bot/handle-update.ts` | Роутер апдейта: команды, голос, интенты, нажатия кнопок (≈690 строк — кандидат на разделение, tech-debt #9) |
| `bot/context.ts` | `AppContext`: конфиг, часы, D1, Telegram |
| `bot/gate.ts` | Ранний фильтр в webhook (allowlist, только личные чаты) |
| `bot/create-event.ts` | US-30/31/32: создание, варианты дат, «во сколько?», пересечения, серии |
| `bot/modify-event.ts` | US-40/41/42/43: перенос, переименование, место, описание, напоминания, «эту/всю серию» |
| `bot/delete-event.ts` | US-50: удаление, чужая встреча → отклонить, серии |
| `bot/find-event.ts` | Поиск события по описанию для изменения/удаления; «её», «вторую», «следующую» |
| `bot/event-lookup.ts` | US-21: «следующая встреча», «когда встреча с Петей?» |
| `bot/read-events.ts` | US-20: расписание за период |
| `bot/format-events.ts` | Список событий для Telegram, разбиение по лимиту длины |
| `bot/format.ts` | Общие форматтеры времени, дат, интервалов, `escapeHtml` |
| `bot/messages.ts` | Все тексты бота RU/EN |
| `bot/keyboards.ts` | Inline-клавиатуры |
| `bot/settings.ts` | `/settings`: меню кнопками, пояс, алиасы, дайджест |
| `bot/undo.ts` | US-61: отмена последнего действия |
| `bot/disconnect.ts` | US-03: `/disconnect` — отзыв токена и удаление данных |
| `bot/forwarded.ts` | US-10: пересланное — не команда, карточка «Выполнить как команду?» |
| `bot/typing.ts` | «печатает…» каждые 4 с до ответа |
| **nlu/** | Понимание текста |
| `nlu/intents.ts` | Реестр интентов: `SYSTEM_PROMPT`, `TOOLS`, разбор ответа LLM |
| `nlu/llm.ts` | OpenAI-совместимый клиент LLM, цепочка с переключением на ошибке |
| `nlu/intent-overrides.ts` | Детерминированные поправки интента («перенеси», «отмени», «когда …?») |
| `nlu/modify-hints.ts` | Что именно менять/какое событие — из текста, без LLM |
| `nlu/detail-hints.ts` | Место, описание, напоминания из фразы |
| **dates/** | Чистый детерминированный парсер (портируемый, ADR-0005 п.8, ADR-0006) |
| `dates/index.ts` | `parseDateFragment` — вход парсера |
| `dates/types.ts` | Контракт = формат золотого корпуса |
| `dates/tokenize.ts`, `lexicon.ts` | Нормализация, токены, словари RU/EN (табличный стиль, формат выключен) |
| `dates/point.ts` | Грамматика момента и периода (≈940 строк, табличная) |
| `dates/duration.ts`, `recurrence.ts` | Длительности; правила повторения |
| `dates/rrule.ts` | Ближайшие даты серии, RRULE для Google, описание словами |
| `dates/extract.ts` | Фрагменты дат из всего сообщения, `cleanTitle`, `looksAllDay` |
| `dates/calendar.ts`, `timezone.ts`, `daily.ts` | Календарная арифметика и пояса; ввод пояса; «ЧЧ:ММ каждый день» |
| **calendar/** | Доменная модель календаря (ADR-0003) |
| `calendar/model.ts` | `CalendarEvent`, `CalendarProvider`, провайдер-нейтральные ошибки |
| `calendar/google-provider.ts` | Адаптер Google: календари из D1, события из API, идемпотентное создание |
| `calendar/google-errors.ts` | Ошибки Google → ошибки модели |
| `calendar/match.ts` | Сопоставление описания с названиями (падежи) |
| `calendar/sync.ts` | Синхронизация списка календарей при переподключении |
| **google/** | HTTP к Google |
| `google/calendar-api.ts`, `auth.ts`, `oauth.ts`, `errors.ts` | Calendar API; access token; OAuth-ссылка, обмен кода, отзыв; ошибки |
| **telegram/** | `api.ts` — клиент Bot API (таймауты, `retry_after`); `types.ts` — минимальные типы |
| **stt/** | `whisper.ts` — цепочка STT (Groq OpenAI-совместимый → Workers AI) |
| **voice/** | `understand.ts` — мультимодальное «переслушивание» (VOICE_CHAIN); `signals.ts` — когда переслушивать |
| **db/** | Доступ к D1: `users.ts` (пользователи, `deleteUserData`), `accounts.ts` (OAuth state, аккаунты, календари), `conversations.ts` (диалог, карточки), `settings.ts`, `usage.ts` (журнал и учёт), `ops-state.ts` |
| **jobs/** | `digest.ts` — US-70 утренний дайджест |
| **admin/** | `/admin`: `index.ts` (маршруты), `auth.ts`, `queries.ts` (весь SQL админки), `mask.ts`, `webhook.ts`, `yaml-snippet.ts` («В тест»), `views/*` |
| **net/** | `fetch.ts` — fetch с таймаутом |
| **testing/** | `routes.ts` — `/__test/{clock,tick,hourly,drain,reset}` (только TEST_MODE и не https) |

## Вне src/

| Путь | Что |
|---|---|
| `acceptance/runner.ts` | Раннер YAML-сценариев (чёрный ящик по HTTP); фильтр `SCENARIO=…`, `--list` |
| `acceptance/fakes/server.ts` | Фейки Telegram, Google (+OAuth), LLM, STT, Gemini; управление `/__fake/*` |
| `acceptance/scenarios/NN-*.yaml` | Сценарии; поле `story:` связывает с `docs/user-stories.md` |
| `test/*.test.ts` | Vitest: чистая логика и адаптеры переносимых наборов (`dates.corpus`, `extract`, `rrule`) |
| `testdata/` | Переносимые наборы: `dates/` (золотой корпус), `extract/`, `recurrence/`, `nlu/` (только для живых замеров) |
| `migrations/` | Схема D1 (применённые не редактируются) |
| `scripts/deploy.ts` | Деплой: проверки → миграции → `wrangler deploy` → секреты → webhook |
| `scripts/story-coverage.ts` | История → сценарии → файлы кода (`npm run -s stories`) |
| `scripts/date-corpus.ts` | Отчёт по корпусу дат (`npm run -s corpus:dates -- --failures`) |
| `scripts/eval-intents.ts`, `nlu-variants.ts` | Живой замер интентов (тратит квоты, см. CLAUDE.md) |
| `scripts/probe-{intents,stt,voice}.ts` | Ручные живые пробы провайдеров (сервис `deploy`) |
| `reports/` | Выводы замеров (в .gitignore) |
| `worker-configuration.d.ts` | Сгенерирован `npm run types` — не править руками, не читать целиком (≈600 КБ) |
