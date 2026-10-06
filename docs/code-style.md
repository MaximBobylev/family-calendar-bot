# Стиль кода

Коротко: форматирует и линтует **Biome**, остальное — договорённости ниже. Цель — код, который легко читать и править, без споров о пробелах в ревью.

## Инструменты

**Biome** (`biome.jsonc`) — форматтер и линтер в одном бинарнике, без плагинов и отдельных конфигов для TS. Почему не Prettier + typescript-eslint: два инструмента и цепочка плагинов вместо одного; typescript-eslint опирается на JS API компилятора, а у нас TypeScript 7 (нативный) — Biome разбирает TS сам и от версии `tsc` не зависит. Плюс быстро: весь проект — десятки миллисекунд.

| Команда | Что делает |
|---|---|
| `docker compose run --rm test npm run -s lint` | линтер |
| `docker compose run --rm test npm run -s format` | отформатировать (правит файлы) |
| `docker compose run --rm test npm run -s format:check` | проверить формат, ничего не меняя |
| `docker compose run --rm test npm run -s check` | typecheck + `biome ci` (линтер и формат) — то, что гоняется перед деплоем |
| `docker compose run --rm test npx biome check --write src/bot/settings/screens.ts` | формат + безопасные автоисправления для конкретных файлов |

`scripts/deploy.ts` перед выкладкой запускает typecheck, `biome ci` и тесты.

### Настройки

- Ширина строки **160**: длинные строки здесь привычны, при 80–120 формат переписал бы полкода.
- Двойные кавычки, точки с запятой, висячие запятые, скобки у аргумента стрелки — как уже было в коде.
- Правила линтера — пресет `recommended`, кроме `noNonNullAssertion`: при `noUncheckedIndexedAccess` `!` после проверки длины или регулярки — норма (уйдёт вместе с union-типом события, см. tech-debt «Низкий»).
- `noAssignInExpressions` выключено только в `src/dates/tokenize.ts`: лестница `if ((m = re.exec(raw)))` — намеренная идиома.
- **Форматтер выключен** для грамматики дат: `src/dates/{lexicon,point,recurrence,tokenize,duration}.ts`. Они свёрстаны таблицами (одна строка — одно правило или группа слов); форматтер разложил бы словари по слову на строку (+700 строк без пользы). Линтер для них включён. Новые словари и правила там — в том же табличном стиле вручную.
- Не форматируются YAML-тесты (`acceptance/scenarios`, `testdata`), Markdown и `migrations/*.sql`.

### Временные исключения

Нет: исключения, введённые на время параллельных правок, сняты коммитом c746222 («Format the remaining files with Biome»). Biome проверяет весь `src/`, `scripts/`, `test/`, `acceptance/`. `npm run -s check` выводит `biome ci` без цвета (`--colors=off`) — вывод читают и агенты.

## SQL

SQL — строкой в `db.prepare(...)`, только prepared statements.

- Ключевые слова — ПРОПИСНЫМИ (`SELECT`, `LEFT JOIN`, `ON CONFLICT ... DO UPDATE SET`), функции SQLite — строчными (`count`, `coalesce`, `json_extract`, `json_each`).
- Короткий запрос (одна таблица, без JOIN/подзапроса, помещается в строку) — одной строкой в `"..."`.
- Остальное — шаблонная строка, **одна клауза на строку**, продолжения выровнены под первую букву запроса:

  ```ts
  .prepare(
    `SELECT c.account_id
     FROM calendars c
     JOIN provider_accounts a ON a.id = c.account_id
     WHERE c.id = ? AND a.user_id = ? AND c.writable = 1`,
  )
  ```

  `UPDATE t` / `SET ...` / `WHERE ...` / `RETURNING ...`; `INSERT INTO t (...)` / `VALUES (...)` / `ON CONFLICT ...`; `OR` в длинном `WHERE` — с новой строки под условием. Короткий подзапрос можно оставить в строке своей клаузы.
- Параметры: `?` по умолчанию; `?1`, `?2` — когда значение используется в запросе больше одного раза (или в группе запросов с общим фрагментом, как в `deleteUserData`). В одном запросе не смешивать.
- В шаблон подставляются только константы кода (`IN (${kinds.map(() => "?")})`, список таблиц для тестового reset), никогда — данные.
- Миграции (`migrations/*.sql`) после применения в проде **не редактируются** ни ради формата, ни ради комментариев: только новая миграция.

## Комментарии и имена

- Комментарии — по-русски, коротко: *зачем*, а не *что*. Ссылки на истории (`US-30`), ADR и пункты tech-debt (`tech-debt #19`) — в комментариях там, где решение из них следует.
- `/** ... */` — у экспортируемых функций/типов и констант с неочевидным смыслом; `//` — внутри кода.
- Шапка файла — 1–3 строки `//`: что за модуль и его главный принцип.
- Магические числа — константами с единицей в имени: `CARD_TTL_MS`, `RETRY_BASE_MS`, `DAY_MIN`, `MAX_ALIAS_LEN`. Время — в миллисекундах (`*_MS`) или минутах (`*_MIN`), явно.
- Вложенный тернарник — не больше одного уровня; дальше — таблица-объект (`LIMIT_MESSAGES[kind][window]`), `switch` или промежуточная переменная.
- Длинное выражение в шаблонной строке — вынести части в переменные с именем (`otherDay`).
- Закомментированный код и неиспользуемые экспорты не держим: история есть в git.

## Раскладка файлов

- `src/bot/*` — сценарии и рендер ответов, `src/db/*` — доступ к D1, `src/calendar/*` — модель и адаптер провайдера, `src/google/*` — HTTP к Google, `src/dates/*` — чистый разбор дат (портируемый, ADR-0006), `src/jobs/*` + `src/scheduler.ts` — фоновые задачи.
- Тесты чистой логики — `test/*.test.ts`; поведение бота — YAML-сценарии `acceptance/scenarios` (ADR-0006).

## Что стоит сделать, но не сделано в проходе читаемости

Это структурные изменения, не косметика, — отдельными задачами:

1. ✅ *сделано 2026-10-05* — **`src/bot/handle-update.ts` разделён** (690 → 61 строка): `input/{message,voice,limit}.ts` → `dialog.ts` → `nlu-step.ts` → `route-intent.ts`; `callbacks.ts`, `voice-rehear.ts`, `with-calendar.ts`, `with-typing.ts`. Не сделано: `to-command` как чистая функция с YAML-кейсами (сейчас `routeIntent` сразу вызывает обработчики). *tech-debt #9.*
2. ◐ *2026-10-05* — **Логика отдельно от рендера**: `create-event.ts` (434 → 172 строки) → `create-logic.ts` (resolveDraft, серии, календарь; юнит-тесты `test/create-logic.test.ts`) + `create-view.ts`; `modify-event.ts` (377 → 200) → `modify-logic.ts` (computeChange) + `modify-view.ts`; `settings.ts` (409) → `settings/{screens,callbacks,input,common,labels}.ts`; словарь `messages.ts` (407 → 32) → `messages/*.ts` по областям. Не сделано: `findCandidates` в `find-event.ts`; юнит-тесты `computeChange` (тип запроса живёт в `find-event.ts`, который тянет типы Workers). *tech-debt #10.*
3. **Реестр карточек** `kind → {guard, handler}` с версией payload вместо `JSON.parse as` и `action as Parameters<typeof confirmX>[3]`. ◐ Первый шаг: таблица `CALENDAR_CARDS` (kind → обработчик) в `bot/callbacks.ts`; касты и проверки payload остались. *tech-debt #15.*
4. **Сырой SQL только в `src/db/*`**: сейчас запросы есть в `scheduler.ts`, `inbox.ts`, `jobs/digest.ts`, `calendar/google-provider.ts`, `bot/settings/common.ts`, `bot/read-events.ts` (названия календарей из `handle-update.ts` перенесены в `db/accounts.ts:calendarNamesOf`). *tech-debt «Низкий», архитектура #20.*
5. **Общие константы времени** (`MINUTE_MS`, `HOUR_MS`, `DAY_MS`, `DAY_MIN`): сейчас локальные копии в `dates/calendar.ts`, `scheduler.ts`, `limits.ts`, `bot/find-event.ts`, `bot/settings/labels.ts`. Нужен модуль без зависимостей (`src/time.ts`), импортируемый и из `src/dates` (он портируемый — только константы).
6. **`CalendarEvent` как union `Timed | AllDay`** — уберёт большинство `!` и позволит включить `noNonNullAssertion`. *tech-debt «Низкий».*
7. **Ширина строки**: после пунктов 1–3 можно опустить до 120–140 — длинные строки в основном в сценариях `bot/*`.
