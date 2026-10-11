# Карта кода

Где что лежит — по одной строке на файл. Подробности — в шапке каждого файла (1–3 строки `//`) и в ADR. Обновлять вместе с добавлением/переносом файлов.

## Путь сообщения

```
Telegram → POST /telegram/webhook (src/index.ts)
  → inline_query → bot/inline/query.ts — ответ сразу, без inbox (US-95)
  → bot/gate.ts (посторонние — ответ сразу; доступ: allowlist или дом; в группе — только обращённое к боту;
                 посторонним — ссылки inline-карточки, bot/inline/guest.ts)
  → inbox.ts: запись в D1 (дедуп по update_id) → 200
  → waitUntil: process.ts → bot/handle-update.ts        (очередь INBOX — страховка через 60 с и ретраи с backoff)
       повтор после сбоя: ctx.progress из inbox (текст голосового, «🎙» отправлено, интент) — STT/LLM не повторяются
       handleUpdate (доступ, вступление в дом по ссылке, регистрация, группа → household/group.ts, команды дома, «Подключить»;
                     участник без Google — ctx.calendarScope: общие календари дома через Google владельца)
         → bot/input/message.ts:handleCommand — текст / голос (input/voice.ts → stt/whisper.ts) / пересланное (forwarded.ts) /
                                                фото и .ics (ingest.ts → vision/understand.ts, ics/*)
         → bot/dialog.ts:runCommand — /connect, /settings, ответы на вопросы (dialog_state), отмена карточек, «отмени последнее»,
                                     поводы переслушать (voice-rehear.ts)
         → bot/nlu-step.ts — nlu/intents.ts (LLM, nlu/llm.ts), лимит (input/limit.ts), журнал
         → bot/route-intent.ts:routeIntent — nlu/intent-overrides.ts → bot/{read-events,event-lookup,create-event,modify-event,delete-event}.ts
         → bot/callbacks.ts:handleCallback — нажатия кнопок: настройки, карточки pending_actions (CALENDAR_CARDS: kind → обработчик)
       → calendar/google-provider.ts → google/calendar-api.ts → Google   (access token — кеш в D1, 401 → обновить и повторить;
                                                                          GET — один повтор на 5xx/429, net/retry.ts)
       → telegram/api.ts → Telegram
cron (каждую минуту) → scheduler.ts:tick → очередь → runQueuedJob (jobs/digest.ts, jobs/assign.ts, sync/*); раз в 5 мин — ops/alerts.ts (алерты владельцу);
                       раз в час — cleanup, ensureDigests, ensureCalendarSyncs (подписки календарей, ретеншн уведомлений)
Google push → POST /google/push (sync/push.ts: канал + секрет) → задача cal_push → очередь → sync/engine.ts:syncCalendar
       (syncToken / 410 → полный синк окна) → applyEntries: снимки, напоминания US-71, уведомления US-72 (sync/notify.ts) — один batch
запись бота в календарь → GoogleCalendarProvider(onWrite) → sync/bot-writes.ts → applyEntries (сразу, в другие чаты; эхо push — по etag)
GET /health → ops/health.ts (D1 + возраст последнего cron; 503 — для внешнего монитора)
GET /ics/<токен> → bot/inline/guest.ts (файл события inline-карточки, US-95)
```

В TEST_MODE обработку запускает раннер через `/__test/drain` (упавшие апдейты — 500 со списком), ретрай очереди — `/__test/retry`, часы — `/__test/clock` (src/testing/routes.ts).

## Где искать фичу

| Нужно | Смотреть |
|---|---|
| Разрешение черновика создания, расчёт изменения (чистые, с юнит-тестами) | `src/bot/create-logic.ts` (`test/create-logic.test.ts`), `src/bot/modify-logic.ts` |
| Новый интент / поле интента | `src/nlu/intents.ts` (схемы tools, промпт), `docs/intents.md`, `testdata/nlu/intents.yaml`; маршрут — `routeIntent` в `src/bot/route-intent.ts` |
| Разбор дат, длительностей, повторений | `src/dates/*` + `testdata/dates/*.yaml` (правила — `docs/date-rules.md`) |
| Даты из всего сообщения, название без дат | `src/dates/extract.ts` + `testdata/extract/*.yaml` |
| Справка `/help`, приветствие `/start` | `src/bot/help.ts`, тексты — `src/bot/messages/help.ts`; меню команд — `scripts/deploy.ts` (`setMyCommands`) |
| Тексты ответов бота | `src/bot/messages/*.ts` — словарь RU/EN по областям (новый текст — в файл своей области), `t()` и `MessageKey` — `src/bot/messages.ts`; форматирование — `src/bot/format.ts`, `format-events.ts` |
| Кнопки и карточки подтверждения | `src/bot/keyboards.ts`, `src/db/conversations.ts` (pending_actions), `src/db/card-status.ts` (статусы, повтор), `src/bot/callbacks.ts` (`handleCallback`, `CALENDAR_CARDS`, `RETRYABLE`) |
| Качество дат: сверка с LLM и правки после карточки | лог `date_check` (`bot/route-intent.ts`, `bot/ingest.ts`), `date_fix` — `src/bot/date-fix.ts`, сводка — `/admin/usage#date-fix` |
| Учёт функций (US-64) | `src/db/features.ts` (`Feature`, `recordFeature` — вызывать после успешного действия), сводка — `/admin/usage` |
| Настройки пользователя | `src/bot/settings/*` (экраны, кнопки, ввод текстом, подписи), `src/db/settings.ts` |
| Часовой пояс и поездки (US-07, R2) | фразы — `src/nlu/timezone-command.ts` (без LLM, до шага NLU в `bot/dialog.ts`; кейсы `testdata/nlu/timezone.yaml`), сценарий и карточки «поездка / навсегда», «Не знаю», «Вернулись?», задача `trip_check` — `src/bot/timezone.ts`, когда спрашивать — `src/bot/trip-logic.ts`; текущий пояс `User.tz` = поездка ?? дом (`src/db/users.ts`), запись — `setTrip`/`endTrip`/`setHomeTz` в `src/db/settings.ts` |
| Схема БД | `migrations/*.sql` (только новые файлы), доступ — `src/db/*` |
| Внешние URL, лимиты, цены | `src/config.ts` |
| Провайдеры LLM/STT, цепочки | `src/nlu/llm.ts`, `src/stt/whisper.ts`, `src/voice/understand.ts`; сборка цепочек — `scripts/deploy.ts` |
| Админка | `src/admin/*`, `docs/admin-console.md`; дома — `views/households.ts`, синхронизация / уведомления / напоминания — `views/sync.ts`, контент → событие и inline — `views/usage.ts`; подписи функций US-64 — `src/admin/labels.ts` (`test/admin-r1.test.ts`) |
| Алерты владельцу, `/health`, структурные логи | правила и пороги — `src/ops/alert-rules.ts` (чистый, `test/alert-rules.test.ts`), здоровье синхронизации и порог `sync_stale` — `src/ops/sync-health.ts` (чистый, `test/admin-r1.test.ts`), сбор и отправка — `src/ops/alerts.ts`, `alert_state` — `src/db/alert-state.ts`; `log()` — `src/log.ts` |
| Остатки квот провайдеров и платформы Cloudflare — Workers, D1, Queues (`/admin/quotas`, алерт `quota_low`) | разбор и пороги — `src/ops/quota-rules.ts` (лимиты тарифов — `CF_LIMITS`; тариф — `vars.CF_WORKERS_PLAN`, аккаунт и токен аналитики — `src/config.ts:cloudflareAnalytics`), запросы и кеш — `src/ops/quotas.ts`, страница — `src/admin/views/quotas.ts`; заголовки лимитов — `ops_state` (`src/db/ops-state.ts`), расход за сутки — `src/db/usage.ts:usageTodayByProvider` |
| Поручения «Беру / Не могу» (US-91), ответственный и «для кого» (US-92), семейный дайджест (US-93) | `src/bot/assign/*` (разбор фраз, имена с падежами, роли `roleAlias`, расписание напоминаний и эскалации — `planAssignmentJobs` в `logic.ts`, чистый, `test/assign-logic.test.ts`), задачи — `src/jobs/assign.ts`, SQL — `src/db/assignments.ts`, `src/db/event-meta.ts`; дайджест — `src/jobs/family-digest.ts` |
| Дом, участники, приглашения, групповой чат (US-90, US-94) | `src/bot/household/*` (разбор команд и «обращено к боту» — `logic.ts`, чистый, `test/household-logic.test.ts`), SQL — `src/db/households.ts`; чьи календари — `AppContext.calendarScope` → `with-calendar.ts` |
| Событие из чужого контента (US-65/66/67) | `src/bot/ingest.ts` (сценарий: пересланное, фото, `.ics`, карточка `ics`), `src/bot/ingest-logic.ts` (дата по предложениям, место, название без LLM; `test/ingest-logic.test.ts`), `src/ics/*` (`test/ics.test.ts`, `testdata/ics/`), `src/vision/understand.ts` |
| Настройки фразой / голосом (US-04, US-06, R2) | фразы — `src/nlu/settings-command.ts` (без LLM, до шага NLU в `bot/dialog.ts` сразу после фраз о поясе; кейсы `testdata/nlu/settings.yaml`), применение и ответ — `src/bot/settings/voice.ts`, строки значений — `settingLine` в `src/bot/settings/screens.ts` |
| Сводки «Сегодня» / «Завтра» / «Неделя» (US-70) | `src/jobs/digest.ts` (виды задач, период, тексты «пусто»), `nextWeeklyAt` — `src/dates/daily.ts`, экран — `digestScreen` в `src/bot/settings/screens.ts` |
| Inline-карточка «📅 Добавить себе» (US-95) | `src/bot/inline/*`: разбор запроса, текст карточки, шаблон Google Calendar, `.ics` — `logic.ts` (чистый, `test/inline-logic.test.ts`); inline-запрос — `query.ts` (из webhook, без inbox); нажатие и `/start add_<токен>` — `press.ts` (зарегистрированные) и `guest.ts` (посторонние — из `gate.ts`, `/ics/<токен>`); SQL — `src/db/inline.ts` |
| Синхронизация Google, push, опрос, каналы | `src/sync/engine.ts` (задачи `cal_sync`/`cal_push`/`watch_renew`, `applyEntries`), `src/sync/push.ts`, SQL — `src/db/sync.ts`; требования Google — `docs/research/google-push.md` |
| Уведомления об изменениях (US-72), напоминания в Telegram (US-71) | «что изменилось», окно, тихие часы, пачка, тексты — `src/sync/logic.ts` (чистый, `test/sync-logic.test.ts`); рассылка — `src/sync/notify.ts`; «календарь → чаты» (личные чаты с календарём, участники дома без него в своём Google, групповые чаты дома) — `db/sync.ts:chatsForCalendar`; напоминания — `src/sync/reminders.ts` |
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
| `bot/dialog.ts` | Слой до LLM: `/connect`, `/settings`, ответ на вопрос о названии, `awaiting` (время, ввод настроек), отмена карточек, «отмени последнее», фразы о поясе и настройках, поводы переслушать |
| `bot/nlu-step.ts` | Текст → интент через цепочку LLM, лимит, запись в журнал |
| `bot/route-intent.ts` | `routeIntent`: интент (с поправками по тексту) → обработчик фичи; даты и «что менять» — из текста |
| `bot/callbacks.ts` | `handleCallback`: кнопки настроек и карточек; `CALENDAR_CARDS` — kind → обработчик |
| `bot/voice-rehear.ts` | `escalateVoice`: переслушать голосовое мультимодальной моделью, затем `routeIntent` |
| `bot/with-calendar.ts` | `withCalendar`: провайдер календаря и ошибки → понятный текст (US-14, US-02) |
| `bot/with-typing.ts` | `withTyping`: «печатает…» на время обработки |
| `bot/context.ts` | `AppContext`: конфиг, часы, D1, Telegram; `calendarScope` — календари дома вместо своих (US-90, US-94) |
| `bot/gate.ts` | Ранний фильтр в webhook: `hasAccess` (allowlist, участник дома, `/start home_…`), в группах — только обращённое к боту |
| `bot/household/logic.ts` | US-90/94, чистый: разбор `/home …`, «Создай дом», имя и другие имена (`looksLikeNames`), код приглашения, `isAddressedToBot`, `stripBotMention`, календари дома по умолчанию (только «семейные») |
| `bot/household/commands.ts` | Команды дома в личном чате: создать, пригласить, вступить по ссылке (`joinByInvite`, язык из Telegram), имя, дети, `/leave`; ответы на вопросы дома (`awaiting`: home_name / home_kid / home_create) |
| `bot/household/menu.ts` | Экран `/home` и кнопки `hm:*` (пригласить, календари дома и ⭐ основной, имена, убрать участника с подтверждением, дети, сводка «Завтра», чек-лист «Что дальше», выйти, распустить); `dissolveWithNotice` |
| `bot/household/group.ts` | Групповой чат: `/home link`/`unlink`, приветствие при добавлении (`greetGroup`, `my_chat_member`, кнопка `hg:link`), `/help`, команды участников по календарям дома, «Беру» ответом, нажатия карточек любым участником (от имени автора) |
| `bot/inline/logic.ts` | US-95, чистый: inline-запрос → событие(я), текст карточки, заголовок результата, ссылка-шаблон Google Calendar, `.ics`, `ia:<токен>` и `/start add_<токен>` |
| `bot/inline/query.ts` | Inline-запрос: доступ, разбор, токены в D1, `answerInlineQuery` (прямо из webhook, без inbox) |
| `bot/inline/press.ts` | «📅 Добавить себе» от пользователя бота: с Google — карточка создания в личном чате, без — ссылки; чат не начат — deep link |
| `bot/inline/guest.ts` | Токен (HMAC), кнопка, счётчик «Добавили себе», ссылки без OAuth; посторонние — нажатие и `/start add_<токен>` из `gate.ts`; `GET /ics/<токен>` |
| `bot/household/scope.ts` | Чьи календари в разговоре (`CalendarScope` с основным общим календарём), `privateScope` (участник — общие календари дома, если их нет в его Google, QA-08), «👤 Добавляет: …», запись автора в `event_meta` |
| `bot/assign/logic.ts` | US-91/92, чистый: «напомни мужу …», «пусть Аня …», «кто-то должен …», «мои дела», «…, отводит папа»; имена с падежами (`sameName`), ребёнок в скобках (`familyTitle`), расписание напоминаний (`planAssignmentJobs`); `assignOverride` — до `effectiveIntent` |
| `bot/assign/start.ts` | Карточка поручения автору (кому, срок, событие — найти или «+ в календарь» в основной общий), «Кому поручить?» (`ASSIGN_WHO_CARD`, роль запоминается), `confirmAssign` |
| `bot/assign/answers.ts` | Кнопки `as:<id>:…` и ответ словом (`actOnAssignment`, `handleTextAnswer`: Беру / Не могу / Сделано / отмена / Сделаю я / Предложить другому), «мои дела», «что я поручил» (`listAssignedByMe`), уход участника (`releaseMemberAssignments`), роспуск (`cancelHouseholdAssignments`), `shiftAssignmentsForEvent` / `cancelAssignmentsForEvent` (перенос и удаление события — через бота; `…ForProviderEvent` — из синка Google, `sync/engine.ts:applyEntries`) |
| `bot/assign/notify.ts`, `view.ts` | Сообщения поручения по статусу и их обновление у всех получателей; подписи срока, кнопки |
| `bot/assign/family.ts` | Дом с участниками и детьми (`loadHome`), подсказки «отводит / для кого» при создании, метки в списках (`familyLabeler`), личное «Отводите вы» ответственному (`notifyResponsible`) |
| `bot/create-event.ts` | US-30/31/32: сценарий создания — календарь, «во сколько?», карточка, пересечения, подтверждение, вопрос о названии |
| `bot/create-logic.ts` | Чистая логика создания: черновик → варианты (`resolveDraft`, серии, длительность), `resolveCalendar`, типы карточки |
| `bot/date-fix-logic.ts`, `bot/date-fix.ts` | Метрика `date_fix` (tech-debt #26): правка даты сразу после карточки — классификация (чистая) и хуки создания / изменения / отмены |
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
| `bot/messages/*.ts` | Тексты RU/EN по областям: `common`, `account`, `read`, `create`, `find`, `modify`, `delete`, `undo`, `settings`, `input` (голос, пересланные), `household` (дом, групповой чат), `assign` (поручения), `help` (справка и /start), `ingest` (событие из чужого контента, сводки «Завтра»/«Неделя»), `inline` (inline-карточка), `notify` (уведомления об изменениях, напоминания в Telegram), `timezone` (пояс и поездки); ключи не повторяются (`test/messages.test.ts`) |
| `bot/keyboards.ts` | Inline-клавиатуры |
| `bot/settings/callbacks.ts` | `/settings`: нажатия кнопок `st:<раздел>:<значение>` (пояс, календари, длительность, напоминания, сводка, язык, «📣 Уведомления») |
| `bot/settings/input.ts` | `/settings`: ввод текстом — пояс, время сводки, другие названия календаря |
| `bot/settings/screens.ts` | Экраны меню (текст + кнопки), пресеты значений |
| `bot/settings/voice.ts` | Настройка фразой (текстом или голосом): применяет сразу, отвечает новым значением; имя календаря без кавычек — граница по списку календарей |
| `bot/settings/common.ts` | Показ меню, список календарей, смена сводки, «Подключить» (`sendReconnect`) |
| `bot/settings/labels.ts` | Подписи: длительность, напоминания («за 1 ч», «накануне в 9:00») |
| `bot/undo.ts` | US-61: отмена последнего действия |
| `bot/disconnect.ts` | US-03: `/disconnect` — отзыв токена и удаление данных |
| `bot/forwarded.ts` | US-10: пересланное — не команда, карточка «Выполнить как команду?» / «📅 Создать событие из этого» (US-65); `forwardOrigin` — автор и дата |
| `bot/ingest.ts` | US-65/66/67: событие из чужого контента — черновик из пересланного или фото → карточка создания; `.ics` → карточка `ics` (`confirmIcs`); вложения — `handleAttachment` |
| `bot/ingest-logic.ts` | Чистая логика для ingest: дата по предложениям (`foreignDateSpans`), место (`guessPlace`), название без LLM, описание-источник |
| `bot/help.ts` | Ревью R1 §4: `/help` и «что ты умеешь» без LLM (личка и группа), `/start` по состоянию (новый, с Google без дома, владелец, участник) |
| `bot/typing.ts` | «печатает…» каждые 4 с до ответа |
| **nlu/** | Понимание текста |
| `nlu/intents.ts` | Реестр интентов: `SYSTEM_PROMPT`, `TOOLS` (и `*_NO_WHEN` — без структуры даты для звена с `dateStructure: false`, `test/intent-prompt.test.ts`), разбор ответа LLM |
| `nlu/date-structure.ts` | Схема и правила «структуры даты» `when` для LLM (create_event, фото, замер `eval-llm-dates`) |
| `nlu/llm.ts` | OpenAI-совместимый клиент LLM, цепочка с переключением на ошибке |
| `nlu/intent-overrides.ts` | Детерминированные поправки интента («перенеси», «отмени», «когда …?») |
| `nlu/modify-hints.ts` | Что именно менять/какое событие — из текста, без LLM |
| `nlu/detail-hints.ts` | Место, описание, напоминания из фразы |
| `nlu/settings-command.ts` | Фразы о настройках без LLM: настройка — только если кроме значения одни служебные слова |
| **dates/** | Чистый детерминированный парсер (портируемый, ADR-0005 п.8, ADR-0006) |
| `dates/index.ts` | `parseDateFragment` — вход парсера |
| `dates/types.ts` | Контракт = формат золотого корпуса |
| `dates/tokenize.ts`, `lexicon.ts` | Нормализация, токены, словари RU/EN (табличный стиль, формат выключен) |
| `dates/point.ts` | Грамматика момента и периода (≈940 строк, табличная) |
| `dates/duration.ts`, `recurrence.ts` | Длительности; правила повторения |
| `dates/rrule.ts` | Ближайшие даты серии, RRULE для Google, описание словами |
| `dates/extract.ts` | Фрагменты дат из всего сообщения, `cleanTitle`, `looksAllDay`; `unsure` / `unknownZone` — не угадывать |
| `dates/structured.ts` | Структура даты от LLM (`when`): строгая проверка и разрешение нашими правилами (`resolvePointOrRange`) — второе мнение в сверке дат |
| `dates/zone.ts` | Явный пояс во фрагменте: «по Киеву», «UTC+4», «London time», «по местному» (`readZone`, `namedZone` для карточки, `zoneByTz` — подпись пояса из структуры LLM) |
| `dates/calendar.ts`, `timezone.ts`, `daily.ts` | Календарная арифметика и пояса; ввод пояса; «ЧЧ:ММ каждый день» |
| **calendar/** | Доменная модель календаря (ADR-0003) |
| `calendar/model.ts` | `CalendarEvent`, `CalendarProvider`, провайдер-нейтральные ошибки |
| `calendar/google-provider.ts` | Адаптер Google: календари из D1 (один запрос на экземпляр), события из API, идемпотентное создание; access token — кеш в D1, 401 → обновить и повторить (tech-debt #13) |
| `calendar/google-errors.ts` | Ошибки Google → ошибки модели |
| `calendar/match.ts` | Сопоставление описания с названиями (падежи) |
| `calendar/sync.ts` | Синхронизация списка календарей при переподключении |
| **google/** | HTTP к Google |
| `google/calendar-api.ts`, `auth.ts`, `oauth.ts`, `errors.ts` | Calendar API (GET — с одним повтором; `syncEvents`, `watchEvents`, `stopChannel`); access token; OAuth-ссылка, обмен кода, отзыв; ошибки |
| `google/token-cache.ts` | Срок кеша access token: годен до 5 мин до истечения (чистый, `test/google-reliability.test.ts`) |
| **telegram/** | `api.ts` — клиент Bot API (таймауты, `retry_after`); `types.ts` — минимальные типы |
| **stt/** | `whisper.ts` — цепочка STT (Groq OpenAI-совместимый → Workers AI) |
| **voice/** | `understand.ts` — мультимодальное «переслушивание» (VOICE_CHAIN); `signals.ts` — когда переслушивать |
| **vision/** | `understand.ts` — US-66: картинка → видимый текст + `create_event`/`no_event` (`config.vision` = VISION_CHAIN: `openai` — DeepSeek, `image_url`; `gemini` — generateContent; без него — Gemini из VOICE_CHAIN) |
| **ics/** | `parse.ts` — разбор `.ics` (RFC 5545: свёртка, TZID, DATE, DURATION, RRULE; чистый); `convert.ts` — событие файла → время в поясе пользователя |
| **db/** | Доступ к D1: `users.ts` (пользователи, `deleteUserData`), `accounts.ts` (OAuth state, аккаунты, календари, кеш access token: `googleTokens`/`saveAccessToken`), `conversations.ts` (диалог с оптимистичной записью, карточки: `claimCard`/`finishCard`), `settings.ts`, `households.ts` (дом, участники, дети, общие календари, приглашения, привязка чатов), `inline.ts` (токены inline-карточек, счётчик нажатий, US-95), `assignments.ts` (поручения, их сообщения, задачи напоминаний), `event-meta.ts` (ответственный и «для кого»), `usage.ts` (журнал и учёт), `features.ts` (US-64: учёт использованных функций, `recordFeature`), `date-metrics.ts` (метрика правок даты `date_fix`, tech-debt #26), `ops-state.ts`, `alert-state.ts` (состояние алертов и их счётчики) |
| `db/card-status.ts` | Машина состояний карточки `open → executing → done/failed` и решение для повторного нажатия (чистый, tech-debt #6) |
| **jobs/** | `digest.ts` — US-70 сводки «Сегодня» (утро), «Завтра» (21:00), «Неделя» (вс 20:00 / пн 08:00): виды задач `digest`, `digest_tomorrow`, `digest_week`; `family-digest.ts` — US-93: чьи календари (участник без Google — общие календари дома), «Ваши дела сегодня»; `assign.ts` — US-91: напоминания, эскалация, «истекло» |
| **sync/** | Синхронизация Google и то, что на ней держится (ADR-0005 §2) |
| `sync/engine.ts` | Синк календаря провайдера: владелец, lease, `syncToken`/410/полный синк окна, каналы `events.watch` (открыть, продлить, остановить), цепочка опроса/сверки, `ensureCalendarSyncs`; `applyEntries` — снимки + напоминания + уведомления одним batch; перенос события мимо бота сдвигает поручения (US-91) |
| `sync/push.ts` | `POST /google/push`: канал и секрет, задача синка — сразу в очередь |
| `sync/bot-writes.ts` | Слушатель записей провайдера: журнал `bot_writes`, снимок по ответу Google (эхо), уведомление в другие чаты с автором |
| `sync/notify.ts` | US-72: получатели, outbox `change_notices` (тихие часы → задача `notify_flush`), отправка по одному или сводкой |
| `sync/reminders.ts` | US-71: задачи `tg_reminder` на горизонт 3 дня, пересчёт при изменении события и настройки, срабатывание со сверкой |
| `sync/logic.ts` | Чистое: снимок события, `diffEvent`, окно 30 дней, тихие часы, план пачки, момент напоминания, тексты |
| **admin/** | `/admin`: `index.ts` (маршруты: здоровье, `/admin/sync`, `/admin/households[/:id]`, журнал, расход, `/admin/quotas`, аудит), `auth.ts`, `queries.ts` (весь SQL админки), `mask.ts` (маски, псевдонимы `u-`/`c-`), `labels.ts` (русские подписи, чистый), `webhook.ts`, `yaml-snippet.ts` («В тест»), `views/*` |
| **ops/** | Эксплуатация: `alert-rules.ts` (правила, пороги — общие со светофором `/admin`, дедупликация, тексты), `sync-health.ts` (сводка `calendar_sync`, «устарел», светофор `/admin/sync`), `alerts.ts` (cron раз в 5 мин → Telegram владельцу), `health.ts` (`GET /health`), `quota-rules.ts` (остатки квот: разбор ответов OpenRouter/DeepSeek, GraphQL Cloudflare — neurons, Workers, D1, Queues — и заголовков Groq, лимиты тарифов, пороги — чистый, `test/quota-rules.test.ts`), `quotas.ts` (сбор для `/admin/quotas` и алерта `quota_low`, кеш 1 мин, запись `rate_headers:*` из цепочек) |
| **net/** | `fetch.ts` — fetch с таймаутом; `retry.ts` — когда и через сколько повторить GET (5xx/429, Retry-After, бюджет времени; чистый) |
| **testing/** | `routes.ts` — `/__test/{clock,tick,hourly,alerts,drain,retry,reset}` (только TEST_MODE и не https) |

## Вне src/

| Путь | Что |
|---|---|
| `acceptance/runner.ts` | Раннер YAML-сценариев (чёрный ящик по HTTP); фильтр `SCENARIO=…`, `--list` |
| `acceptance/fakes/server.ts` | Фейки Telegram, Google (+OAuth, `syncToken`/410, `events.watch`/`channels.stop`, push, общие календари, внешние изменения, страницы, лимит 403/429), LLM, STT, Gemini; чтение картинок OpenAI-совместимым (`/vision/v1`); управление `/__fake/*`; Gemini (голос и картинки — по `mimeType`) |
| `acceptance/scenarios/NN-*.yaml` | Сценарии; поле `story:` связывает с `docs/user-stories.md` |
| `test/*.test.ts` | Vitest: чистая логика и адаптеры переносимых наборов (`dates.corpus`, `extract`, `rrule`) |
| `testdata/` | Переносимые наборы: `dates/` (золотой корпус), `extract/`, `recurrence/`, `nlu/` (только для живых замеров) |
| `migrations/` | Схема D1 (применённые не редактируются) |
| `scripts/deploy.ts` | Деплой: проверки → миграции → `wrangler deploy` → секреты → webhook |
| `scripts/story-coverage.ts` | История → сценарии → файлы кода (`npm run -s stories`) |
| `scripts/date-corpus.ts` | Отчёт по корпусу дат (`npm run -s corpus:dates -- --failures`) |
| `scripts/eval-llm-dates.ts` | Живой замер: DeepSeek разрешает даты сам (A) или даёт структуру для `resolvePointOrRange` (B); корпус и `holdout-*` (платно, см. CLAUDE.md) |
| `scripts/eval-intents.ts`, `nlu-variants.ts` | Живой замер интентов (тратит квоты, см. CLAUDE.md) |
| `scripts/probe-{intents,stt,voice}.ts` | Ручные живые пробы провайдеров (сервис `deploy`) |
| `reports/` | Выводы замеров (в .gitignore) |
| `worker-configuration.d.ts` | Сгенерирован `npm run types` — не править руками, не читать целиком (≈600 КБ) |
