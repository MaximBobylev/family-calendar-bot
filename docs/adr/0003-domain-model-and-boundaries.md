# ADR-0003. Доменная модель и границы модулей

- Статус: **предложено** (2026-10-03), по итогам анализа stretch goals ([stretch-goals.md](../stretch-goals.md))

## Контекст

В MVP — один канал (Telegram), один провайдер (Google), один аккаунт на пользователя. Но вероятные следующие шаги (второй Google-аккаунт, Outlook/CalDAV, бот в семейном чате, Mini App, событие из фото/пересланного сообщения, платные тарифы) ломают модель, в которой всё привязано к `telegram_user_id` и напрямую вызывает Google API. Исправлять это позже = миграция ключей во всех таблицах.

## Решение

Закладываем **форму данных и интерфейсы**, реализуем только то, что нужно MVP.

### Сущности

```
User (внутренний user_id)                                  // может быть БЕЗ ProviderAccount — роль «участник» (диспетчер)
 ├─ ChannelIdentity (channel=telegram, external_id) 1..N
 ├─ ProviderAccount (provider=google, credentials, granted_scopes, email) 0..N   // в UI MVP — 1
 │    └─ Calendar (provider_calendar_id, aliases[], is_default, writable)
 ├─ Settings (JSON с версией схемы)
 ├─ Entitlement (plan, source, valid_until, limits)        // ADR-0004
 ├─ UsageEvent (stt/llm, provider, model, audio_ms, tokens, cost)
 ├─ FeatureUsage (feature, first_used_at, count)           // US-64, лимиты free
 └─ Timezone: home_tz + trip {tz, until?}                  // US-07

Household (owner_user_id, name)                            // «дом» — семья (диспетчер, семейный тариф)
 ├─ Member (user_id, role: owner | adult | participant, display_name)
 ├─ Dependent (name, aliases[])                            // ребёнок / «для кого», без аккаунта
 └─ SharedCalendarRef (accountId, calendarId)              // общие календари дома

Conversation (channel, chat_id, kind: private | group, household_id?)
 └─ DialogState (по ключу conversation × user): последний список, черновик, pending actions, undo-журнал

EventMeta (EventRef, created_by_user_id, responsible_member_id?, for_dependent_id?, prepare_notes?)
                                                           // наши данные о событии; источник правды о времени — календарь

Assignment (EventRef?, title, assignee_member_id, created_by, due_at,
            status: pending | accepted | declined | done | expired, escalation_policy)
                                                           // «напомни мужу забрать Машу» — может быть и без события в календаре

ScheduledJob (kind, user_id | member_id, fire_at, payload) // дайджесты, напоминания, эскалации
```

**Задел под «Семейный диспетчер»** (решение 2026-10-03: ядро продукта — диспетчер, в R0 не реализуется, но схема данных и интерфейсы учитывают его сразу):
- `User` без `ProviderAccount` — валидное состояние (участник получает события и напоминания только через Telegram).
- `Household` / `Member` / `Dependent` существуют в схеме с R0; в R0 создаётся дом из одного-двух взрослых с OAuth, без UI управления.
- Метаданные события (`EventMeta`) хранятся у нас, а не только в `extendedProperties` Google: участники без доступа к календарю тоже должны видеть «ответственного». Дублирование в `extendedProperties.private` — опционально.
- Получатель уведомления в `ScheduledJob` и `Reply` — **участник/адрес доставки**, а не владелец календаря.
- `Conversation.kind = group` и привязка к дому — с R0 в схеме; групповые чаты обрабатываются с R1.

- `EventRef = { accountId, calendarId, providerEventId }` — непрозрачная ссылка, используется в контексте, undo, планировщике.
- Доменная модель `Event` не зависит от Google: `title`, `start/end` (с IANA-поясом), `allDay`, `location {text, lat?, lon?}`, `attendees[]`, `organizerIsSelf`, `reminders`, `recurrence` (структура, не RRULE), `conference?`, `etag`.

### Границы модулей

```
ChannelAdapter (Telegram) ──► InboundMessage {text | audio | image | forwarded | callback}
        │
        ▼
InputNormalizer (audio → SpeechToText; позже image → vision, forwarded → текст+метаданные)
        │
        ▼
IntentParser (LLM, реестр интентов со схемами) ──► Command
        │
        ▼
Authorization (entitlement + квоты) ─► CommandExecutor ─► CalendarProvider (Google)
        │
        ▼
Reply {i18n-ключ, параметры, actions[]} ──► ChannelAdapter рендерит кнопки
```

- `CalendarProvider`: `listCalendars`, `listEvents`, `getEvent`, `createEvent`, `patchEvent`, `deleteEvent`, `moveEvent`, `instances`, флаги `capabilities`. Реализация — только Google.
- `SpeechToText`, `IntentParser` — из ADR-0002; провайдер выбирается функцией от `(user, config)` (задел под BYO key).
- Callback-данные и pending actions хранятся на сервере, в Telegram уходит только короткий id.
- Все тексты — через i18n-каталог (ICU plural), даты — `Intl`.
- **Часы внедряются** (никаких прямых `Date.now()`), **все внешние URL — из конфига** — требование переносимых тестов (ADR-0006).
- Undo-журнал хранит **список** обратных операций.

## Не делаем заранее (YAGNI)

Реализации других провайдеров и каналов, household/роли, локальную копию календаря, контакты, event-bus и вебхуки наружу, аналитику.

## Последствия

- Оценка: ~3–4 дня сверх MVP, в основном — дисциплина интерфейсов.
- Фейковый `CalendarProvider` упрощает тесты.
- ADR-0001 п.2 обновлён: данные привязаны к внутреннему `user_id`.
