# US-62: план реализации «несколько событий в одном сообщении»

- Статус: план техлида (2026-10-11) для одного разработчика. Решение и альтернативы — [ADR-0008](../adr/0008-multi-event-split.md); замер — [multi-event-eval.md](multi-event-eval.md); продукт и UX — [US-62](../user-stories.md#us-62-несколько-действий-в-одном-сообщении), [multi-event-scenarios.md](multi-event-scenarios.md) (сценарии 1–12, макеты М1–М11, «Решения по UX-разбору»).
- Порядок работы — как в `CLAUDE.md`: корпус делителя и сценарии → код → проверка → документы.

## 0. Срезы

**S1 — минимальный срез, закрывает базовый случай владельца** (своё / пересланное голосовое или текст: две встречи, два дня рождения, расписание из пересланного):
1. Делитель `multi-split.ts` + корпус `testdata/split/cases.yaml` (раздел 2).
2. Сопоставление с ответом LLM, названия, разбор дат по кускам, общий день, день рождения → ежегодное (разделы 3–4).
3. Карточка `multi`: строки, переключатели ✅/⬜, общая кнопка «🔁 Каждый год», «Создать все / выбранные (K)», «Отмена» (разделы 5–6).
4. Создание с идемпотентными id, частичный сбой → «Повторить (N)», итог на месте, «↩ Отменить все (K)» и «отмени последнее» (разделы 7, 9).
5. Пересланное: «📅 Создать события из этого» → то же сообщение становится списком (раздел 10).
6. Лимиты 5 / 10, защита «номер при открытой карточке» (раздел 11).
7. Упрощения S1: неясное событие (нет дня/времени, варианты, прошлое) — строка «❓ … — скажите его отдельным сообщением» без переключателя, не создаётся; кусок-не-создание («удали…», «покажи…») — всё сообщение по-старому, «Давайте по одной»; ⚠️ «похоже, уже есть» и ⏰ пересечения — не показываем.

Если и это велико — из S1 можно вынуть переключатели строк (оставить `y`, «Создать все», «Отмена»): механизм записи payload без захвата всё равно нужен для `y`.

**S2 — полный объём R2**: ❓ с переключателем ❓ ⇄ ⬜ и вопросами после создания по одному (раздел 8); ⚠️ похожее (выключено) и ⏰ пересечения (раздел 6.3); ⏭ «Не сделано» и карточка одного события со строкой ⏭ (М9); общий календарь «всё в семейный» и ответственный «на оба / везде»; ежегодное правило для карточки одного события (US-31); учёт `multi_create`; правило деления в промпте (после регрессионного замера, раздел 12).

**P2 — не делать в R2**: правка словами (М10), «да / создавай» голосом как главная кнопка, отделение LLM-only дела без даты и маркера («…, а потом обед»), «каждую неделю» для пересланного расписания, фото с несколькими событиями, выравнивание `.ics` с этой карточкой.

## 1. Поток

```
текст / транскрипт ─▶ nlu-step (1 вызов LLM, как сейчас) ─▶ routeIntent
   routeIntent: pieces = splitMessage(text)            ← до assignOverride / effectiveIntent
     ≥2 кусков-созданий, нет поручения, LLM ∈ {create_event, multiple, unsupported} ─▶ startMulti
     иначе ─▶ прежний путь (одно событие / «по одной» / …)
пересланное ─▶ proposeForwarded: splitMessage(foreign) ≥2 ─▶ кнопка «📅 Создать события из этого»
   нажатие ─▶ eventFromForwarded ─▶ titleFromLlm (1 вызов) ─▶ ≥2 ─▶ startMulti(source: forward, refNow)
startMulti ─▶ items (разбор дат по кускам) ─▶ pending_actions kind "multi" ─▶ карточка
   t<i> / y ─▶ запись payload без захвата (CAS) ─▶ editMessageText
   c / r    ─▶ claimCard ─▶ confirmMulti: createEvent ×K (id = <карточка><i>) ─▶ итог на месте + «↩ Отменить все»
              есть сбои ─▶ карточка снова open, «🔁 Повторить (N)»
   x        ─▶ «Отменено»
```

## 2. Делитель — `src/bot/multi-split.ts` (новый, чистый)

В `src/bot`, а не в `src/nlu`: для пересланного нужны `mergeLayoutLines`, `withoutOpeningHours`, `CHAT_TIMESTAMP` из `ingest-logic.ts`.

```ts
export interface Piece {
  /** Текст куска как сказан — для названия, llmDateCheck и familyHints. */
  text: string;
  point?: string;            // extractDateSpans(text).point
  pointParts?: string[];
  recurrence?: string;       // extractRecurrenceSpan(text).span
  duration?: string;
  unsure?: true;
  unknownZone?: string;
  /** "other" — свой или унаследованный глагол изменения / удаления / показа: не создаём. */
  action: "create" | "other";
  /** «и ещё созвон с Олегом» — дело без даты (❓). */
  undated?: true;
  /** «в пятницу и в субботу в 10 футбол»: название и время — у куска с этим индексом. */
  borrowFrom?: number;
  /** Черновое название без LLM. */
  title?: string;
}
export function splitMessage(text: string, now: string, tz: string, opts?: { foreign?: boolean }): Piece[];
```

Алгоритм (прототип из замера — 24 / 24 по числу дел; правила — норматив, корпус — истина):
1. `foreign`: сначала `mergeLayoutLines`, построчно `withoutOpeningHours`, строки-`CHAT_TIMESTAMP` и `BARE_DAY_SPAN` выбросить, весь текст ≤ 1500 символов (`MAX_TEXT`).
2. Защитить серию со «и» внутри: `extractRecurrenceSpan(text)` даёт span с « и » / « and » — заменить их маркером до резки, вернуть после.
3. Резать на сырые куски по: перевод строки; `;`; конец предложения (`SENTENCE_END` из `ingest-logic`); `,`; тире ` — ` / ` – `, если за ним время или день («Пн 17:00 — танцы, …» режется по запятым, тире внутри строки «время — название» не граница: граница только если тире стоит после названия перед новой датой); союзы-слова `и`, `а`, `потом`, `затем`, `плюс`, `а потом`, `а ещё`, `and`, `then`, `plus`. Не граница: `или` / `or` (варианты одной даты, date-rules), `с … до …`, `по`.
4. Маркер дела без даты: кусок начинается с `ещё / еще / также / а ещё / also` → `undated`, маркер из текста убрать.
5. Разобрать каждый сырой кусок: `extractRecurrenceSpan`, иначе `extractDateSpans(…, "point")`; есть ли название — `cleanTitle` после вырезания дат, ведущих глаголов (`CREATE_VERB` из `assign/logic.ts` — вынести в общий модуль), вводных («не забудь(те)», «напоминаем», «запиши», `LEADS` из `ingest-logic`) и одиночных союзов/предлогов.
6. Склейка (слева направо):
   - без даты и без маркера → к предыдущему куску (первый — к следующему): «отводит папа», «ул. Ленина, 5», «с Петей» из «с Петей и Машей», «всё в семейный календарь» (S2: распознать как общий календарь, см. 4.5);
   - только время без названия, а у предыдущего нет времени → к предыдущему («Футбол в субботу, в 10 утра»);
   - только день без названия и без времени, следующий — с названием и временем, между ними «и» или запятая → `borrowFrom = i + 1` (перечисление, два события);
   - без названия и не перечисление → к предыдущему (уточнение, а не новое дело: «…, а в субботу если получится» → не делим).
7. Глагол куска: `DELETE_VERBS`, `MODIFY_VERBS`, `isDetailChange` (`nlu/modify-hints.ts`, `detail-hints.ts`), показ / поиск («покажи», «что у меня», «когда у меня», «show», «what's») → `other`. Кусок без своего глагола после `other` наследует `other` («перенеси обед на 14 и созвон на 15»). Явный глагол создания — `create`.
8. Черновое название: из п.5 + эллипсис — остаток вида «у Маши» / «с Машей» / «Маши» при названии предыдущего «День рождения Пети» / «Созвон с Петей» → заменить в нём имя («День рождения Маши», «Созвон с Машей»); «у Пети день рождения» → «День рождения Пети». Это запасной путь: замер показал, что Nemotron часто возвращает только первое событие, и второе в базовом случае владельца назовёт именно эвристика.

Корпус `testdata/split/cases.yaml` (переносимые данные, ADR-0006), формат как `testdata/extract/cases.yaml`:
```yaml
defaults: { now: "2026-10-07T10:00", tz: Europe/Moscow }
cases:
  - text: "Не забудь, у Пети день рождения 12 ноября, а у Маши — 3 декабря"
    expect:
      - { point: "12 ноября", title: "День рождения Пети" }
      - { point: "3 декабря", title: "День рождения Маши" }
  - text: "В пятницу и в субботу в 10 футбол"
    expect: [{ point: "В пятницу", borrow: 1 }, { point: "в субботу в 10", title: "Футбол" }]
  - { text: "Тренировка каждый вторник и четверг в 19", expect: [{ recurrence: "каждый вторник и четверг в 19", title: "Тренировка" }] }
  - text: "Поставь обед с Аней в среду в 13 и удали планёрку в четверг"
    expect: [{ point: "в среду в 13", title: "Обед с Аней" }, { action: other }]
  # foreign: true — разбор пересланного
```
Минимум 40 кейсов: все 24 из замера; эллипсис названий; адреса и уточнения через запятую; «или»; «с 10 до 12»; перечисление дней; «ещё»; наследование глагола; поручение внутри («напомни мужу … и …» — сюда не доходит, но кейс для защиты); пересланное расписание по строкам и с часами работы; EN. Тест — `test/multi-split.test.ts`.

## 3. Сопоставление с ответом LLM и названия — `src/bot/multi-logic.ts` (новый, чистый)

```ts
export function alignCalls(pieces: Piece[], calls: CreateEventIntent[]): (CreateEventIntent | undefined)[];
```
- `calls` — `create_event` из `multiple.parts` по порядку или `[intent]` для одиночного `create_event`; `unsupported` → `[]`.
- Монотонно и жадно: для куска-создания `i` ищем первый ещё не взятый вызов `k ≥ j`, у которого `titleScore(call.title, piece.text) ≥ 0.5` (`calendar/match.ts`) или все слова `call.start` есть в тексте куска и среди них есть слово его даты. Нашли — пара, `j = k + 1`.
- Перечисление (`borrowFrom`) берёт название у куска-источника. Лишние вызовы игнорируются — делитель главнее (ADR-0008 п.1).
- Название строки: `cleanTitle(call.title, датовые куски)` → иначе черновое `piece.title` → иначе `defaultTitle`. `titleGiven` — только если название есть (вопрос «Как назвать?» после создания пачки не задаём: S1/S2 — строка без названия получает `defaultTitle`, как у `.ics`).

## 4. Разбор дат по кускам — `buildItems` в `multi-logic.ts`

Для каждого куска-создания по порядку (порядок — как сказано, не по времени):
1. `familyHints(ctx, userId, piece.text)` (I/O — делает `multi-event.ts` до вызова чистой части) — ответственный и «для кого» только этого куска; `famText` без «отводит папа».
2. **Общий день** (ADR-0008 п.6): кусок `i > 0` со временем без дня → `withConversationDay(point, prevDay, today)`, где `prevDay` — день уже разрешённой строки `i − 1` (готовое событие или ❓ с известным днём). У строки 0 — день разговора US-60, как в `routeIntent` сейчас. Кусок `undated` после строки с днём получает этот день (`startText = "DD.MM.YYYY"`) → вопрос будет только о времени (сценарий 4). Строка `i − 1` — серия → общего дня нет.
3. Второе мнение LLM: `llmDateCheck(famText, point, { start, when } пары, now, tz, llmFirst)` — как у одного события; при общем дне / дне разговора / незнакомом поясе — без LLM (как сейчас). `llmFirst = true` для пересланного (как `proposeFromForeign`). Лог `date_check` с `multi: true`.
4. `CreateDraft` из пары и куска: `startText` / `altStartText` / `altWhen`, `recurrenceText`, `title`, `durationText` (кусок, иначе LLM), `allDay` (LLM, `looksAllDay(piece.text)`, день рождения), `calendar` (пара; S2 — общий календарь), `family`, `description` (пересланное — `sourceDescription`, одна цитата на все строки).
5. **Общий календарь (S2)**: кусок без даты, приклеенный по п.6 делителя, вида «(всё|все|оба|обе|both|all)? (в|во|to)? <календарь>» и разрешимый `findCalendarByName` → календарь всех строк без своего; все пары LLM с одним календарём — тоже общий.
6. `resolveCalendar` для каждой строки; любой `notFound` / `readOnly` → ответ как у одного события (`calendarErrorText`), ничего не создаём.
7. `resolveDraft(draft, refNow ?? now, tz, cal, locale, durationMin)` → строка:
   - `options` с одним вариантом → готовая (`option`);
   - `options` с несколькими (неоднозначно, «в 9» в 10:00; расхождение с LLM) → ❓ `pick` с вариантами (≤ 4);
   - `ask` (`askWhen` / `askTime` / `inPast` / `askZoneTime`) или `reply` → ❓ с вопросом и черновиком;
   - пересланное с `refNow`, все варианты в прошлом → ❓ `inPast` (как `startCreate`).
8. **День рождения** (ADR-0008 п.8): `BIRTHDAY = /день рождени|(?<!\p{L})др(?!\p{L})|годовщин|юбиле|birthday|anniversary/iu` (вынести рядом с `ALL_DAY_PATTERNS` в `dates/extract.ts`) по названию или куску, готовое событие на весь день с одной датой → `birthday: true`. Серию не кладём в `option`: её добавляет общий флаг `yearly` при создании (`toRRule({ freq: "yearly" }, start, tz, true)`, текст — `describeRecurrence`).
9. **Дубль внутри сообщения**: одинаковые нормализованное название и `startDay`/`start` → одна строка.
10. **Лимиты**: строк-созданий (готовых и ❓) своё > 5 → `multiTooManyOwn`, пересланное > 10 → `multiTooManyForward`, ничего не создаём. Ровно одна строка → обычная карточка одного события (`startCreate` с её черновиком). Ни одной готовой (все ❓) → S2: сразу вопросы (раздел 8) с `multiAllUnclear`; S1: «по одной».

## 5. Данные карточки

```ts
export const MULTI_CARD = "multi";

export interface MultiCardPayload {
  chatId: number;
  items: MultiItem[];               // как сказано, ≤ 10
  /** Есть строки birthday: true — «🔁 Каждый год: да» (по умолчанию). */
  yearly?: boolean;
  /** Пересланное: «📝 Из пересланного сообщения от …»; "" — без имени. */
  forwardedFrom?: string;
  /** S2: ⏭ куски-не-создания, как сказаны (≤ 200 символов). */
  skipped?: string[];
  viaAlias?: boolean;
  /** Последняя запись отмены — заменяется после «Повторить». */
  undoId?: string;
}

export interface MultiItem {
  title: string;
  /** Переключатель; у ❓ "on" — спросить после создания. */
  sel: "on" | "off";
  option?: CreateOption;            // готовое событие
  ask?: { question: "askWhen" | "askTime" | "inPast" | "askZoneTime" | "pick"; draft: CreateDraft; options?: CreateOption[] };
  birthday?: true;
  dup?: { title: string; when: string };   // S2: ⚠️, по умолчанию sel = "off"
  overlap?: string[];                      // S2: ⏰
  family?: EventFamily;
  done?: { ref: EventRef; link?: string; etag?: string } | { failed: true };
}
```
- Размер: 10 строк ≈ 7–8 КБ JSON — в `payload_json` без проблем. Миграций нет.
- `callback_data`: `pa:<id 16 hex>:<выбор>`; выбор `t0`…`t9` (переключатель строки), `y` (каждый год), `c` (создать), `r` (повторить), `x` (отмена) — ≤ 22 байт; `parseCallbackData` уже принимает `\w+`. Тест: 10 строк → все `callback_data` ≤ 64 байт.
- Состояние по умолчанию: готовые — `on`; ⚠️ — `off`; ❓ — `on` (S1: ❓ без переключателя и не в payload-выборе).

## 6. Карточка, переключатели, главная кнопка

### 6.1. Текст — `src/bot/multi-view.ts` (новый, чистый)
По макетам М1–М3, М7, М11: заголовок `multiHeader`; `📝 …` для пересланного; `🗓 <календарь>` под заголовком, если у всех строк один и календарей с записью больше одного, иначе у каждой строки; строка — `✅|⬜|❓ N. <b>Название</b>` + «когда» (день полностью всегда — даже если совпадает с предыдущим, `whenOf` / `dateLabel`; серия — `🔁 …`; ДР при `yearly` — «, 🔁 каждый год»), `· 👤 Отводит: …` (`familyCardLines` в одну строку), `🗓 …` при разных календарях, `⏰ …`, `⚠️ …` (два текста: выключено / включено), у ❓ — пояснение по типу вопроса, у `off` ❓ — «не создаю». Пустая строка между событиями. S2: абзац `⏭ …` внизу. `creatorNote` (дом) и `homeTzNote` — как у одного события, один раз.

### 6.2. Кнопки
- По ряду на строку: `✅ 1 · Стоматолог` / `⬜ 1 · …` / `❓ 5 · …`, название обрезать до 20 символов с «…».
- `🔁 Каждый год: да / нет` — ряд, если есть строки `birthday`.
- Последний ряд: главная + `cancelButton`. Главная: все готовые `on` → `multiCreateAll {n}`; часть → `multiCreateSelected {k}` (❓ не считаются); готовых `on` нет, но есть ❓ `on` → `multiAskNext`; ничего → `multiCreateSelected {0}` (нажатие — всплывающее `multiSelectOne`, без захвата).

### 6.3. ⚠️ и ⏰ (S2)
Один `provider.listEvents` от первого до последнего дня карточки (+1 день; если разброс > 62 дней — по вызову на день строки, их ≤ 10). ⏰ — как `findOverlaps` (вынести из `create-event.ts` в общий помощник, принимать готовый список событий). ⚠️ — событие того же дня в том же календаре, `titleScore(новое, существующее) ≥ 0.5`, со временем — не дальше 3 часов (правило `findEventToLink`, US-91); подпись «Хор», ср 17:00.

### 6.4. Переключатели без захвата — `src/db/conversations.ts`
```ts
export async function getOpenCard<P>(db, id, userId, now): Promise<PendingAction<P> | null>;   // status='open' AND expires_at > now
export async function updateOpenCardPayload(db, id, userId, now, prevJson: string, nextJson: string): Promise<boolean>;
//   UPDATE pending_actions SET payload_json = ? WHERE id = ? AND user_id = ? AND status = 'open' AND expires_at > ? AND payload_json = ?
export async function reopenCard(db, id, payloadJson: string, now: number): Promise<void>;
//   executing → open, новый payload, expires_at = now + CARD_TTL_MS (только из executing)
export async function setCardPayload(db, id, payloadJson: string): Promise<void>;   // итог при executing
export async function hasOpenCard(db, conversationId, userId, kind, now): Promise<boolean>;
```
`callbacks.ts`: до `claimCard`, для выборов `t\d`, `y`, `c` — `getOpenCard`; если `kind === MULTI_CARD` → `pressMulti` (в `multi-event.ts`): `t`/`y` — изменить payload чистым редьюсером `toggle(payload, choice)` (`multi-logic.ts`), `updateOpenCardPayload` (до 3 попыток с перечитыванием, как `mergeDialogState`), `editMessageText` с новым текстом и клавиатурой («message is not modified» уже глотает `bestEffort` в `telegram/api.ts`); `answerCallbackQuery` пустой. `c` при пустом выборе — всплывающее `multiSelectOne`. Иначе — обычный путь `claimCard`. В группе дома `group.ts` уже подменяет нажавшего автором карточки — тот же `user.id` подходит и сюда.

## 7. Создание — `confirmMulti` в `src/bot/multi-event.ts`

Через `CALENDAR_CARDS` в `callbacks.ts`; `MULTI_CARD` — в `RETRYABLE` (повтор безопасен: свои id). Выбор `c` и `r` одинаковы: создать все строки `sel = on` с `option` и без `done.ref`.
1. По порядку, последовательно: `provider.createEvent({ idempotencyKey: \`${action.id}${i}\`, …поля option, recurrence: birthday && yearly ? [yearlyRule] : option.series, reminders: remindersFor(user, allDay) })` (`remindersFor` вынести из `create-event.ts`/`ingest.ts` — сейчас две копии). id карточки — 16 hex, `i` — одна цифра: id события `cab<16 hex><i>` в алфавите base32hex.
2. После успеха строки: `noteCreator(ctx, ref, action.userId)`, `saveEventFamily`, `notifyResponsible` — как `confirmCreate`; `done = { ref, link, etag }`.
3. Сбой строки: `ProviderUnavailable` (5xx, 429, rateLimit-403, таймаут — `calendar/google-errors.ts`) → `done = { failed: true }`, дальше по списку; два сбоя подряд → остальные сразу `failed` без вызовов (Google лежит; бережём лимит 50 подзапросов на вызов Worker). `AuthRevoked` / `PermissionDenied` / прочее — бросить: `withCalendar` ответит как сейчас, карточка `failed`.
4. Итог (раздел 7.1), затем:
   - есть созданные → `recordUndo` с `create_many` по **всем** созданным строкам (и прошлых попыток) → `undoId` в payload, кнопка `multiUndoAll {k}`, `attachUndoMessage`;
   - есть сбои → `reopenCard` (карточка снова `open`, кнопка `multiRetry {n}`); `finishCard` после этого ничего не меняет (он только из `executing`);
   - сбоев нет → `setCardPayload` с результатом, обычный `finishCard(done)`.
5. Контекст US-60: `lastList` — ссылки созданных по порядку итога («перенеси второе» — про вторую строку итога, М4), `lastEvent` — последняя созданная, `lastDay` — её день.
6. Учёт: `create` (+ `recurring`, если создана серия; `alias`), S2: `multi_create` при ≥ 2 созданных (тип `Feature` в `db/features.ts`, таблица — свободный текст, миграция не нужна).
7. S2: после итога без сбоев — вопросы по ❓ `on` (раздел 8). При сбоях вопросы — после успешного «Повторить».

Повторное нажатие «Создать» — `claimCard` («уже выполняю» / «уже сделано»); умерший посреди цикла обработчик — повтор по tech-debt #6, те же id → 409 → успех (`insertEvent` достаёт существующее событие).

### 7.1. Итог — та же карточка, отредактированная на месте (М4, М5)
- Всё создано: `created` («✅ Создано»), `🗓` как в карточке, строки `N. <a href=link>Название</a> — когда · 👤 …` (номера заново по порядку созданных), `multiSkippedDup` для выключенных ⚠️, `multiAskLater` для ❓ `on`, ⏭ (S2), `↩ Отменить все (K)`. Превью ссылок уже выключено у `sendMessage` / `editMessageText` с `html: true`.
- Частично: `multiCreatedPartial {ok} {n}`, строки `✅ <a>…</a>` / `❌ Название — когда — multiFailedLine`, `[🔁 Повторить (N)] [↩ Отменить все (K)]`.
- Ничего: `multiNothingCreated` + `[🔁 Повторить (N)] [Отмена]`.

## 8. Вопросы по ❓ после создания (S2)

- `askQueue(ctx, user, chatId, conversationId, queue: MultiItem[], opts: { replyTo?: number; prefix?: "more" | "allUnclear" })` в `multi-event.ts`: берёт первую.
  - `pick` → карточка одного события с вариантами (`createPendingAction` `CREATE_CARD` + `createCard`), заголовок `multiPickHeader {title}`; нажатие варианта сразу создаёт (как сейчас).
  - иначе → `awaiting: { kind: "create_time", draft, next }` и вопрос `multiAskTime {title} {day}` / `multiAskWhen {title}` / `multiInPast {title} {when}`.
- `DialogState.awaiting.create_time` и `CreateCardPayload` получают `next?: MultiItem[]`; `dialog.ts` передаёт `next` в `startCreate` → в payload карточки; `confirmCreate` и отмена (`x`) карточки с `next` → `askQueue(next, { prefix: "more" })` («Ещё одно: …»). Ответ «не время» — новая команда, очередь пропадает (теряется только неясное — решение US-62).
- Вопрос — отдельным последним сообщением ответом на итог: `telegram/api.ts sendMessage` — опция `replyTo` (`reply_parameters`).
- `startCreate` — опция `askText`, чтобы вопрос о времени был с названием и днём строки, а не общий `askTime`.

## 9. Отмена пачки — `src/bot/undo.ts`

- `UndoRecord |= { kind: "create_many"; items: { ref: EventRef; etag?: string; title: string }[] }`.
- `performUndo`: по каждому `deleteEvent(ref, { notify: false, etag })`; `EventConflict` → в список «не удалил»; `EventGone` → считаем удалённым. Итог — правка сообщения итога: `undoneMany {n}` + по строке `undoKeptChanged {title}`; ничего не удалено и все изменены → `undoChangedAfter`. `dateFixOnUndoCreate` — только для `create`.
- «Отмени последнее» (`undoLast`) работает без изменений — запись одна. Кнопка старого итога после «Повторить» исчезает вместе с клавиатурой; старая запись отмены ответит `undoOnlyLast`, если её всё же нажать из истории.
- Число склоняется: нужен `plural(n, locale, forms)` (в `format.ts`; сейчас склонений нет).

## 10. Пересланное

- `forwarded.ts proposeForwarded`: `splitMessage(stored, nowLocal, tz, { foreign: true })`, кусков-созданий с датой ≥ 2 → `forwardLooksEvents {text}` и кнопка `forwardEventsButton` (тот же выбор `ev`); иначе как сейчас. LLM до нажатия не зовём.
- `ingest.ts`: `titleFromLlm` возвращает все `create_event` (из `multiple.parts` тоже), текст в LLM — до 1500 символов вместо 500, когда делитель нашёл ≥ 2 (расписание на 7–10 строк не влезает в 500); журнал — только извлечённые поля: `events: [{ title, start }]`. `proposeFromForeign`: ≥ 2 → `startMulti({ source: "forward", refNow, forwardedFrom, description })`, иначе прежний путь. Относительные даты — от даты пересланного (`refNow`) для каждой строки.
- Нажатие «📅 Создать события из этого» → то же сообщение становится списком (`editMessageText` вместо нового `sendMessage`): `startMulti` получает `messageId` карточки пересланного и правит его (новая карточка `multi` привязывается к этому `message_id`). Сейчас `confirmForwarded` правит сообщение в `forwardEventStarted` и шлёт новую карточку — для списка поменять на правку.
- Пересланное: удаления/изменения никогда не исполняются — куски `other` просто не попадают в карточку (без ⏭).
- Фото (US-66) — без изменений.

## 11. Номер при открытой карточке списка (сценарий 12)

`dialog.ts runCommand`, до `cancelCards`: `ORDINAL_LEAD.test(text) && hasOpenCard(db, conversationId, user.id, MULTI_CARD, now)` → `multiOrdinalHint`, карточку не трогаем, команду не исполняем. Карточки нет — разбор как обычно. `MULTI_CARD` добавить в список `cancelCards` (новая команда аннулирует карточку, US-05).

`ORDINAL_LEAD` (в `multi-logic.ts`, юнит-тест на «да / нет»): начало фразы (после необязательных «а / и / ну») — `перв…`, `втор…` (не «вторник»), `трет…`, `четвёрт…/четверт…` (не «четверг»), `пят(ое|ый|ая|ую|ого|ой)` (не «пятница»), `шест…`, `седьм…`, `восьм…`, `девят(ое|…)`, `десят(ое|…)`; `\d{1,2}` с `-е / -й / -ое / . / )`; `номер|пункт|№ N`; EN `first…tenth`, `2nd`, `number N`. Не срабатывает, если дальше месяц или «числа» («третьего ноября у Пети ДР» — новая команда).

## 12. Правило деления в промпте (S2, необязательно)

Вариант `M` / `MW` (`scripts/nlu-variants.ts`) поднимает у Qwen долю верных пар 46 → 71 %, у Nemotron почти без эффекта. В прод (`PROMPT_HEAD` в `nlu/intents.ts`) — только после прогона всего `testdata/nlu/intents.yaml` на `E` против `M` и `W` против `MW` без регрессий (≈ 150 вызовов Workers AI и ≈ 60 OpenRouter — в день, когда квоту не делим с QA). Без этого шага всё работает: число дел и даты — от делителя.

## 13. Тексты — `src/bot/messages/multi.ts` (новый, RU и EN)

Смысл — из макетов; EN — М11. Ключи: `multiHeader`, `multiFromForward {name}` (или переиспользовать `ingestFromForwardBy` с `📝`), `multiCreateAll {n}`, `multiCreateSelected {n}`, `multiAskNext`, `multiSelectOne`, `multiLineAskWhen`, `multiLineAskTime`, `multiLineInPast`, `multiLinePick`, `multiLineSayApart` (S1: «скажите его отдельным сообщением»), `multiLineOff`, `multiDupOff {title} {when}`, `multiDupOn {title} {when}`, `multiOverlap {list}`, `multiEveryYear`, `multiYearlyOn`, `multiYearlyOff`, `multiSkipped {text}`, `multiCreatedPartial {ok} {n}`, `multiFailedLine`, `multiNothingCreated`, `multiRetry {n}`, `multiUndoAll {n}`, `multiSkippedDup {title}`, `multiAskLater {title}`, `multiTooManyOwn {n}`, `multiTooManyForward {n}`, `multiOrdinalHint`, `multiAskTime {title} {day}`, `multiAskWhen {title}`, `multiInPast {title} {when}`, `multiPickHeader {title}`, `multiAskMore`, `multiAllUnclear {n}`, `forwardLooksEvents {text}`, `forwardEventsButton`, `undoneMany {n}`, `undoKeptChanged {title}`. Подключить в `src/bot/messages.ts`.

## 14. Файлы

Новые (добавить в `docs/architecture-map.md`):

| Файл | Что |
|---|---|
| `src/bot/multi-split.ts` | делитель сообщения на куски-дела (чистый) |
| `src/bot/multi-logic.ts` | пары с LLM, черновики строк, общий день, ДР, лимиты, редьюсер переключателей, `ORDINAL_LEAD` (чистый) |
| `src/bot/multi-view.ts` | текст и кнопки карточки, итог, текст отмены (чистый) |
| `src/bot/multi-event.ts` | `startMulti`, `pressMulti`, `confirmMulti`, `askQueue` (I/O) |
| `src/bot/messages/multi.ts` | тексты RU/EN |
| `testdata/split/cases.yaml` | корпус делителя |
| `test/multi-split.test.ts`, `test/multi-logic.test.ts`, `test/multi-view.test.ts` | юнит-тесты |
| `acceptance/scenarios/47-multi-event*.yaml` | приёмка (раздел 15) |

Изменяемые: `src/bot/route-intent.ts` (делитель до поправок, вызов `startMulti`), `src/bot/dialog.ts` (`ORDINAL_LEAD`, `cancelCards`, `next` у `create_time`), `src/bot/callbacks.ts` (`MULTI_CARD`, нажатия без захвата, `RETRYABLE`), `src/db/conversations.ts` (функции из 6.4, `next` в `DialogState`), `src/bot/undo.ts`, `src/bot/forwarded.ts`, `src/bot/ingest.ts`, `src/bot/create-event.ts` (`remindersFor`, `findOverlaps` по готовому списку, `askText`, `next`), `src/bot/create-logic.ts` (ДР → ежегодное для одного события, S2), `src/dates/extract.ts` (`BIRTHDAY`), `src/bot/assign/logic.ts` (вынести `CREATE_VERB`), `src/telegram/api.ts` (`replyTo`), `src/bot/format.ts` (`plural`), `src/db/features.ts` (`multi_create`), `src/bot/messages.ts`; `acceptance/runner.ts` и `acceptance/fakes/server.ts` (шаг `google_insert_fails`).

**Миграций нет.** Новых таблиц нет — список очистки `src/testing/routes.ts` не трогаем.

## 15. Приёмочные сценарии (`story: US-62`; «сейчас» — пн 12 октября 2026, 10:00 МСК, как в сценариях продакта)

LLM-фикстуры задают ответы как у моделей прода, **включая потерю событий** (`{tool: create_event}` вместо двух) — сценарий обязан пройти и так (ADR-0008).

`47-multi-event.yaml` — своё сообщение (S1, кроме помеченных):
- `multi-own-two-events` — сц. 1 / М1 текстом: карточка, «Создать все (2)», итог с двумя ссылками и «↩ Отменить все (2)», два события в Google с ожидаемыми временами.
- `multi-own-voice` — сц. 1 голосом (STT-фикстура): «🎙 …» и та же карточка.
- `multi-llm-lost-second` — LLM вернула одно событие из двух: в карточке два, второе с эвристическим названием.
- `multi-shared-day` — сц. 3: оба в пятницу; контроль «В 10 встреча с Петей и в пятницу созвон в 15».
- `multi-not-split` — сц. 10: «Встреча с Петей и Машей…», «Обед в среду с 13 до 14», «Созвон в среду или в четверг в 15», «Тренировка каждый вторник и четверг в 19» → обычные карточки; «В пятницу и в субботу в 10 футбол» → список из двух.
- `multi-toggle` — снять `✅ 2` → «Создать выбранные (1)», создано одно; снять все → «Отметьте хотя бы одно событие» всплывающим (`expect_callback_answer`).
- `multi-limit-own` — 6 дел → «… до 5. Продиктуйте частями», ничего не создано.
- `multi-english` — сц. 11 / М11.
- `multi-ordinal-guard` — сц. 12: «второе — в 13» при открытой карточке → подсказка, карточка жива и создаёт по нажатию; после закрытия — обычный разбор.
- `multi-mixed-delete` — сц. 6: S1 — «по одной», ничего не удалено; S2 — карточка одного события со строкой ⏭ (М9), планёрка не удалена ни при каком нажатии.
- `multi-unclear` (S2) — сц. 4: ❓ строка, «Создать выбранные (1)», итог со строкой ❓, затем вопрос «Во сколько поставить «Созвон с Олегом» (вт, 13 октября)?» ответом на итог, «в 16» → карточка одного события. Вариант: ❓ → ⬜, вопроса нет.
- `multi-all-unclear` (S2) — «В сообщении 2 события, начнём с первого.»
- `multi-duplicate` (S2) — сц. 5: ⚠️ строка выключена; «Создать выбранные (2)»; включить → создаётся и хор.
- `multi-calendar-responsible` (S2) — сц. 7: «🗓 Семья» один раз, «👤 Отводит: Иван» только у первой; Иван получает «🚗 Отводите вы…».

`47-multi-event-forwarded.yaml`:
- `multi-forwarded-birthdays` — сц. 2 / М7: пересланное голосовое (STT) с датой пересылки; кнопка «📅 Создать события из этого» без числа; LLM не вызвана до нажатия (`expect_llm_requests: 0`); нажатие → то же сообщение (`editMessageText`) — список, «📝 Из пересланного сообщения от Аня», «🔁 каждый год» у обоих; «🔁 Каждый год: да» → «нет», строки без повтора; «Создать все (2)» → два события на весь день с RRULE (или без него — второй прогон), в описании цитата.
- `multi-forwarded-schedule` — сц. 8: 7 строк «Пн 17:00 — танцы, …» → один список из 7, «Создать все (7)»; 12 строк → «Слишком много событий в одном сообщении (12)…».
- `multi-forwarded-ignore-delete` — пересланное «… в среду в 17 хор, удалите старое расписание» → в карточке только хор и другие создания.
- `multi-forwarded-no-press` — без нажатия ничего не создано.

`47-multi-event-faults.yaml`:
- `multi-partial-failure-retry` — сц. 9 / М5: новый шаг `google_insert_fails: { summary_contains: "Анализы", status: 503, times: 5 }` → «Создано 2 из 3», «🔁 Повторить (1)», «↩ Отменить все (2)»; после снятия сбоя «Повторить» → «✅ Создано», в Google ровно 3 события (`expect_google_events count: 3`), «↩ Отменить все (3)».
- `multi-double-press` — «Создать все» дважды (`press … again: true`) → события по одному разу.
- `multi-undo-all` — «↩ Отменить все (3)» → три удаления; вариант «отмени последнее» текстом.
- `multi-undo-changed` — одно событие изменили в Google (`google_touch`) → «↩ Отменил: удалил 2 события. Не удалил «Родительское собрание» — его уже изменили».
- `multi-google-down` — `provider_outage google-write 503` → «Google не отвечает — ничего не создал», `[🔁 Повторить (3)] [Отмена]`.

Новый шаг описать в типе `Step` (`acceptance/runner.ts`) и в шапке `acceptance/fakes/server.ts`; `times` — больше числа ретраев клиента Google (`net/retry.ts`).

## 16. Юнит-тесты и данные

- `testdata/split/cases.yaml` + `test/multi-split.test.ts` — раздел 2 (≥ 40 кейсов, включая 15 фраз замера и 9 контрольных).
- `test/multi-logic.test.ts`: `alignCalls` (пара по названию, по `start`, потеря вызова, лишний вызов, перечисление); общий день (`i > 0`, первая — день разговора, после серии — нет); ДР → `birthday` (со временем — нет); дубль в сообщении; лимиты 5 / 10 и «одна строка → обычная карточка»; состояние по умолчанию (⚠️ выключено); подпись главной кнопки во всех состояниях; редьюсер `t<i>` / `y`; `ORDINAL_LEAD` («второе — в 13», «2-е на субботу», «first one at 5» — да; «вторник в 10», «пятница футбол», «четверг», «2 ноября футбол», «третьего ноября ДР» — нет); `callback_data` ≤ 64 байт на 10 строках; payload на 10 строк < 16 КБ.
- `test/multi-view.test.ts`: тексты М1, М2/М3, М4, М5, М7, М11 и отмены — проверки подстрок, как `test/create-view*.test.ts`.
- `testdata/nlu/intents.yaml` — раздел `multi_create` / `multi_single` (уже добавлен, замер).

## 17. Документы после реализации

`docs/user-stories.md` (US-62, US-31 — «Сделано»), `docs/roadmap.md`, `docs/architecture-map.md` (новые модули), `docs/intents.md` (`multiple` → путь списка), `docs/date-rules.md` (общий день внутри сообщения, ДР → ежегодное), `docs/tech-debt.md` (если что-то осталось, например P2 из раздела 0).

## 18. Риски

| Риск | Что держит |
|---|---|
| Ложное деление на запятых (адреса, уточнения, «12 ноября, весь день») | склейка кусков без даты; корпус `testdata/split/`; деление только по своей дате или маркеру |
| Потеря дела без даты и без маркера («…, а потом обед») | осознанно P2; видно в карточке (строки нет) — пользователь скажет отдельно |
| Плохие эвристические названия, когда LLM потеряла событие | эллипсис и «у X день рождения» в делителе; кейсы в корпусе; в карточке название видно до создания |
| Лимит 50 подзапросов Worker при 10 событиях с ретраями | после двух сбоев подряд — остальные `failed` без вызовов; «Повторить» |
| Гонка двух быстрых нажатий переключателей | CAS по `payload_json` с перечитыванием; «message is not modified» уже глотается |
| Изменение `routeIntent` до поправок задевает старые пути | многособытийный путь только при ≥ 2 кусках-созданиях и без поручения; весь прежний набор `acceptance` и `testdata/nlu` должен остаться зелёным |
| `effectiveIntent` / `assignOverride` на всём тексте («удали» во втором куске, «отводит папа» + `multiple`) | делитель раньше них (ADR-0008 п.2) |
