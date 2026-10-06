# Карта кода

Где что лежит — по одной строке на файл. Подробности — в шапке каждого файла (1–3 строки `//`) и в ADR. Обновлять вместе с добавлением/переносом файлов.

## Путь сообщения

```
Telegram → POST /telegram/webhook (src/index.ts)
  → bot/gate.ts (посторонние — ответ сразу; доступ: allowlist или дом; в группе — только обращённое к боту)
  → inbox.ts: запись в D1 (дедуп по update_id) → 200
  → waitUntil: process.ts → bot/handle-update.ts        (очередь INBOX — страховка через 60 с и ретраи с backoff)
       повтор после сбоя: ctx.progress из inbox (текст голосового, «🎙» отправлено, интент) — STT/LLM не повторяются
       handleUpdate (доступ, вступление в дом по ссылке, регистрация, группа → household/group.ts, команды дома, «Подключить»;
                     участник без Google — ctx.calendarScope: общие календари дома через Google владельца)
         → bot/input/message.ts:handleCommand — текст / голос (input/voice.ts → stt/whisper.ts) / пересланное (forwarded.ts)
         → bot/dialog.ts:runCommand — /connect, /settings, ответы на вопросы (dialog_state), отмена карточек, «отмени последнее»,
                                     поводы переслушать (voice-rehear.ts)
         → bot/nlu-step.ts — nlu/intents.ts (LLM, nlu/llm.ts), лимит (input/limit.ts), журнал
         → bot/route-intent.ts:routeIntent — nlu/intent-overrides.ts → bot/{read-events,event-lookup,create-event,modify-event,delete-event}.ts
         → bot/callbacks.ts:handleCallback — нажатия кнопок: настройки, карточки pending_actions (CALENDAR_CARDS: kind → обработчик)
       → calendar/google-provider.ts → google/calendar-api.ts → Google   (access token — кеш в D1, 401 → обновить и повторить;
                                                                          GET — один повтор на 5xx/429, net/retry.ts)
       → telegram/api.ts → Telegram
cron (каждую минуту) → scheduler.ts:tick → очередь → runQueuedJob (jobs/digest.ts); раз в 5 мин — ops/alerts.ts (алерты владельцу);
                       раз в час — cleanup, ensureDigests
GET /health → ops/health.ts (D1 + возраст последнего cron; 503 — для внешнего монитора)
```

В TEST_MODE обработку запускает раннер через `/__test/drain` (упавшие апдейты — 500 со списком), ретрай очереди — `/__test/retry`, часы — `/__test/clock` (src/testing/routes.ts).

## Где искать фичу

| Нужно | Смотреть |
|---|---|
| Разрешение черновика создания, расчёт изменения (чистые, с юнит-тестами) | `src/bot/create-logic.ts` (`test/create-logic.test.ts`), `src/bot/modify-logic.ts` |
| Новый интент / поле интента | `src/nlu/intents.ts` (схемы tools, промпт), `docs/intents.md`, `testdata/nlu/intents.yaml`; маршрут — `routeIntent` в `src/bot/route-intent.ts` |
| Разбор дат, длительностей, повторений | `src/dates/*` + `testdata/dates/*.yaml` (правила — `docs/date-rules.md`) |
| Даты из всего сообщения, название без дат | `src/dates/extract.ts` + `testdata/extract/*.yaml` |
| Тексты ответов бота | `src/bot/messages/*.ts` — словарь RU/EN по областям (новый текст — в файл своей области), `t()` и `MessageKey` — `src/bot/messages.ts`; форматирование — `src/bot/format.ts`, `format-events.ts` |
| Кнопки и карточки подтверждения | `src/bot/keyboards.ts`, `src/db/conversations.ts` (pending_actions), `src/db/card-status.ts` (статусы, повтор), `src/bot/callbacks.ts` (`handleCallback`, `CALENDAR_CARDS`, `RETRYABLE`) |
| Учёт функций (US-64) | `src/db/features.ts` (`Feature`, `recordFeature` — вызывать после успешного действия), сводка — `/admin/usage` |
| Настройки пользователя | `src/bot/settings/*` (экраны, кнопки, ввод текстом, подписи), `src/db/settings.ts` |
| Схема БД | `migrations/*.sql` (только новые файлы), доступ — `src/db/*` |
| Внешние URL, лимиты, цены | `src/config.ts` |
| Провайдеры LLM/STT, цепочки | `src/nlu/llm.ts`, `src/stt/whisper.ts`, `src/voice/understand.ts`; сборка цепочек — `scripts/deploy.ts` |
| Админка | `src/admin/*`, `docs/admin-console.md` |
| Алерты владельцу, `/health`, структурные логи | правила и пороги — `src/ops/alert-rules.ts` (чистый, `test/alert-rules.test.ts`), сбор и отправка — `src/ops/alerts.ts`, `alert_state` — `src/db/alert-state.ts`; `log()` — `src/log.ts` |
| Дом, участники, приглашения, групповой чат (US-90, US-94) | `src/bot/household/*` (разбор команд и «обращено к боту» — `logic.ts`, чистый, `test/household-logic.test.ts`), SQL — `src/db/households.ts`; чьи календари — `AppContext.calendarScope` → `with-calendar.ts` |
| Поведение для приёмочного теста | `acceptance/scenarios/NN-*.yaml`, шаги — тип `Step` в `acceptance/runner.ts`, фейки — `acceptance/fakes/server.ts` |

## src/

| Файл | Назначение |
|---|---|
| `index.ts` | Точка входа Worker: `fetch` (webhook, OAuth, админка, страницы, `/__test/*`), `queue` (inbox и задачи), `scheduled` (cron) |
| `process.ts` | Обработка апдейта из inbox — общая для очереди, `waitUntil` и `/__test/drain`; кладёт `progress` в контекст |
| `inbox.ts` | Inbox в D1: дедупликация, атомарный захват (pending → processing → done), сделанные шаги для повтора (`UpdateProgress`: `saveTranscript`, `markHeardSent`, `saveIntent`; tech-debt #5) |
| `scheduler.ts` | Планировщик `scheduled_jobs`: tick раздаёт в очередь, повторы с backoff, `cleanup` (ретеншн) |
| `config.ts` | Конфиг из Env: URL внешних API, цепочки провайдеров, `USAGE_LIMITS`, `COST_ESTIMATES` |
| `clock.ts` | Внедряемые часы; в TEST_MODE «сейчас» хранится в D1 |
| `crypto.ts` | AES-GCM для секретов в D1: формат `v1:` с AAD, legacy без префикса, связка ключей для ротации (tech-debt #8); сравнение за постоянное время |
| `limits.ts` | Лимиты расходов на пользователя (час/сутки), оценка стоимости |
| `env.d.ts` | Секреты в типе `Env` (`wrangler types` их не знает) |
| `log.ts` | Структурные логи: `log(event, fields)` — одна строка JSON, `logged()` — с длительностью и исходом, `errorClass()` — ошибка без хвоста сообщения |
| `oauth-routes.ts` | `/oauth/google/*`: промежуточная страница, PKCE, привязка к браузеру, callback |
| `pages.ts` | Публичные страницы (homepage, privacy, terms) — заглушки до R3 |
| **bot/** | Сценарии и рендер ответов |
| `bot/handle-update.ts` | Вход апдейта: правки/боты мимо, доступ, регистрация, `/disconnect`, без календаря — «Подключить»; дальше — сообщение или нажатие |
| `bot/input/message.ts` | Приём сообщения: текст, голосовое, пересланное (→ карточка), прочее — «пока не умею» |
| `bot/input/voice.ts` | `recognizeVoice`: голосовое → текст (длина/размер, STT-цепочка, журнал, поправки Whisper, «Услышал: …») |
| `bot/input/limit.ts` | `withinLimit`: лимит LLM/STT на пользователя перед внешним вызовом (tech-debt #4) |
| `bot/dialog.ts` | Слой до LLM: `/connect`, `/settings`, ответ на вопрос о названии, `awaiting` (время, ввод настроек), отмена карточек, «отмени последнее», поводы переслушать |
| `bot/nlu-step.ts` | Текст → интент через цепочку LLM, лимит, запись в журнал |
| `bot/route-intent.ts` | `routeIntent`: интент (с поправками по тексту) → обработчик фичи; даты и «что менять» — из текста |
| `bot/callbacks.ts` | `handleCallback`: кнопки настроек и карточек; `CALENDAR_CARDS` — kind → обработчик |
| `bot/voice-rehear.ts` | `escalateVoice`: переслушать голосовое мультимодальной моделью, затем `routeIntent` |
| `bot/with-calendar.ts` | `withCalendar`: провайдер календаря и ошибки → понятный текст (US-14, US-02) |
| `bot/with-typing.ts` | `withTyping`: «печатает…» на время обработки |
| `bot/context.ts` | `AppContext`: конфиг, часы, D1, Telegram; `calendarScope` — календари дома вместо своих (US-90, US-94) |
| `bot/gate.ts` | Ранний фильтр в webhook: `hasAccess` (allowlist, участник дома, `/start home_…`), в группах — только обращённое к боту |
| `bot/household/logic.ts` | US-90/94, чистый: разбор `/home …`, «Создай дом», имя и другие имена, код приглашения, `isAddressedToBot`, `stripBotMention`, календари дома по умолчанию |
| `bot/household/commands.ts` | Команды дома в личном чате: создать, пригласить, вступить по ссылке (`joinByInvite`), имя, дети, `/leave` |
| `bot/household/menu.ts` | Экран `/home` и кнопки `hm:*` (пригласить, календари дома, убрать участника/ребёнка, выйти, распустить); `dissolveWithNotice` |
| `bot/household/group.ts` | Групповой чат: `/home link`/`unlink`, команды участников по календарям дома, нажатия карточек любым участником (от имени автора) |
| `bot/household/scope.ts` | Чьи календари в разговоре (`CalendarScope`), «👤 Добавляет: …», запись автора в `event_meta` |
| `bot/create-event.ts` | US-30/31/32: сценарий создания — календарь, «во сколько?», карточка, пересечения, подтверждение, вопрос о названии |
| `bot/create-logic.ts` | Чистая логика создания: черновик → варианты (`resolveDraft`, серии, длительность), `resolveCalendar`, типы карточки |
| `bot/create-view.ts` | Карточка создания: тело события, варианты дат кнопками, выбор для 29–31 числа |
| `bot/modify-event.ts` | US-40/41/42/43: сценарий изменения — проверки, карточка, подтверждение «эту/всю серию», отмена |
| `bot/modify-logic.ts` | Чистый `computeChange`: перенос, длительность, переименование, место, описание, напоминания; тип карточки |
| `bot/modify-view.ts` | Карточка «Было → Стало», кнопки, итог изменения |
| `bot/delete-event.ts` | US-50: удаление, чужая встреча → отклонить, серии |
| `bot/find-event.ts` | Поиск события по описанию для изменения/удаления; «её», «вторую», «следующую» |
| `bot/event-lookup.ts` | US-21: «следующая встреча», «когда встреча с Петей?» |
| `bot/read-events.ts` | US-20: расписание за период |
| `bot/format-events.ts` | Список событий для Telegram, разбиение по лимиту длины |
| `bot/format.ts` | Общие форматтеры времени, дат, интервалов, `escapeHtml` |
| `bot/messages.ts` | `t()`, `MessageKey`: склейка словаря из `bot/messages/*` |
| `bot/messages/*.ts` | Тексты RU/EN по областям: `common`, `account`, `read`, `create`, `find`, `modify`, `delete`, `undo`, `settings`, `input` (голос, пересланные), `household` (дом, групповой чат); ключи не повторяются (`test/messages.test.ts`) |
| `bot/keyboards.ts` | Inline-клавиатуры |
| `bot/settings/callbacks.ts` | `/settings`: нажатия кнопок `st:<раздел>:<значение>` (пояс, календари, длительность, напоминания, сводка, язык) |
| `bot/settings/input.ts` | `/settings`: ввод текстом — пояс, время сводки, другие названия календаря |
| `bot/settings/screens.ts` | Экраны меню (текст + кнопки), пресеты значений |
| `bot/settings/common.ts` | Показ меню, список календарей, смена сводки, «Подключить» (`sendReconnect`) |
| `bot/settings/labels.ts` | Подписи: длительность, напоминания («за 1 ч», «накануне в 9:00») |
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
| `calendar/google-provider.ts` | Адаптер Google: календари из D1 (один запрос на экземпляр), события из API, идемпотентное создание; access token — кеш в D1, 401 → обновить и повторить (tech-debt #13) |
| `calendar/google-errors.ts` | Ошибки Google → ошибки модели |
| `calendar/match.ts` | Сопоставление описания с названиями (падежи) |
| `calendar/sync.ts` | Синхронизация списка календарей при переподключении |
| **google/** | HTTP к Google |
| `google/calendar-api.ts`, `auth.ts`, `oauth.ts`, `errors.ts` | Calendar API (GET — с одним повтором); access token; OAuth-ссылка, обмен кода, отзыв; ошибки |
| `google/token-cache.ts` | Срок кеша access token: годен до 5 мин до истечения (чистый, `test/google-reliability.test.ts`) |
| **telegram/** | `api.ts` — клиент Bot API (таймауты, `retry_after`); `types.ts` — минимальные типы |
| **stt/** | `whisper.ts` — цепочка STT (Groq OpenAI-совместимый → Workers AI) |
| **voice/** | `understand.ts` — мультимодальное «переслушивание» (VOICE_CHAIN); `signals.ts` — когда переслушивать |
| **db/** | Доступ к D1: `users.ts` (пользователи, `deleteUserData`), `accounts.ts` (OAuth state, аккаунты, календари, кеш access token: `googleTokens`/`saveAccessToken`), `conversations.ts` (диалог с оптимистичной записью, карточки: `claimCard`/`finishCard`), `settings.ts`, `households.ts` (дом, участники, дети, общие календари, приглашения, привязка чатов), `usage.ts` (журнал и учёт), `features.ts` (US-64: учёт использованных функций, `recordFeature`), `ops-state.ts`, `alert-state.ts` (состояние алертов и их счётчики) |
| `db/card-status.ts` | Машина состояний карточки `open → executing → done/failed` и решение для повторного нажатия (чистый, tech-debt #6) |
| **jobs/** | `digest.ts` — US-70 утренний дайджест |
| **admin/** | `/admin`: `index.ts` (маршруты), `auth.ts`, `queries.ts` (весь SQL админки), `mask.ts`, `webhook.ts`, `yaml-snippet.ts` («В тест»), `views/*` |
| **ops/** | Эксплуатация: `alert-rules.ts` (правила, пороги — общие со светофором `/admin`, дедупликация, тексты), `alerts.ts` (cron раз в 5 мин → Telegram владельцу), `health.ts` (`GET /health`) |
| **net/** | `fetch.ts` — fetch с таймаутом; `retry.ts` — когда и через сколько повторить GET (5xx/429, Retry-After, бюджет времени; чистый) |
| **testing/** | `routes.ts` — `/__test/{clock,tick,hourly,alerts,drain,retry,reset}` (только TEST_MODE и не https) |

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
