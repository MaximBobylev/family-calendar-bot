# Calendar Assist Bot — документация

**Семейный диспетчер в Telegram:** перешлите сообщение или скажите голосом — бот занесёт событие в общий Google Календарь, напомнит, кому нужно, и проследит, что дело взяли.

Ядро — общий календарь и передача дел внутри семьи; управление личным календарём голосом и текстом — базовая функция (R0). Обоснование — [research/pivot-options.md](research/pivot-options.md).
Хостинг — Cloudflare Workers (TypeScript), распознавание речи и интентов — Cloudflare Workers AI (с fallback на внешних провайдеров), даты — детерминированный парсер.

> Статус: **спецификация R0 готова** (2026-10-04). Кода нет. Следующий шаг — тестовые данные (золотой корпус дат, NLU-корпус) и каркас проекта.

## Структура

| Файл | Что внутри |
|---|---|
| [roadmap.md](roadmap.md) | Разбивка на релизы: что в MVP, что позже |
| [user-stories.md](user-stories.md) | Пользовательские сценарии с критериями приёмки |
| [intents.md](intents.md) | Каталог интентов: что бот умеет, какие параметры извлекает |
| [date-rules.md](date-rules.md) | Правила разбора дат и времени, неоднозначные случаи |
| [stretch-goals.md](stretch-goals.md) | Будущие фичи и их влияние на архитектуру |
| [tracks/channels-calendar.md](tracks/channels-calendar.md) | Отдельный трек: календарь каналов для организаторов (отложен) |
| [family-plan.md](family-plan.md) | Семейный тариф: что считаем и ограничиваем |
| [monetization-brainstorm.md](monetization-brainstorm.md) | Варианты монетизации (брейншторм) |
| [research/commercial-viability.md](research/commercial-viability.md) | Сводка независимых оценок коммерческого потенциала |
| [research/pivot-options.md](research/pivot-options.md) | Как подкрутить идею: сводка 4 независимых оценок |
| [research/hosting-economics.md](research/hosting-economics.md) | Экономика хостинга: Cloudflare vs VPS + Go, AI-провайдеры |
| [research/monetization-market.md](research/monetization-market.md) | Обзор рынка: модели монетизации и цены |
| [research/monetization-evaluation.md](research/monetization-evaluation.md) | Независимая оценка вариантов монетизации |
| [open-questions.md](open-questions.md) | Открытые вопросы и решённое |
| [adr/0001](adr/0001-audience-and-google-oauth.md) | Аудитория и Google OAuth |
| [adr/0002](adr/0002-ai-providers.md) | Провайдеры STT / LLM |
| [adr/0003](adr/0003-domain-model-and-boundaries.md) | Доменная модель и границы модулей |
| [adr/0004](adr/0004-monetization.md) | Монетизация и платный доступ (предложение) |
| [adr/0005](adr/0005-runtime-and-processing.md) | Cloudflare Workers + TS, inbox, push-синхронизация, детерминированный разбор дат |
| [adr/0006](adr/0006-portable-acceptance-tests.md) | Переносимые приёмочные тесты (данные + чёрный ящик) |

## Глоссарий

- **Интент** — тип действия, который пользователь хочет выполнить (создать событие, показать расписание…).
- **Слоты** — параметры интента (дата, время, длительность, название…).
- **Карточка / подтверждение** — сообщение бота с кнопками перед выполнением действия.
- **Привязка** — OAuth-доступ бота к Google-аккаунту пользователя.
- **Алиас** — пользовательское имя календаря («общий», «work»).
- **Entitlement** — право пользователя на функции по его тарифу.

## Общий поток обработки сообщения

```
Telegram update
   │
   ▼
Доступ (allowlist / entitlement) ──нет──► отказ / «доступно в подписке»
   │
   ▼
Голос ──► STT (Whisper) ──┐
Текст ────────────────────┴─► LLM: интент + слоты ──► валидация (схема, date-rules)
                                                         │
                ┌────────────────────┬───────────────────┼────────────────────┐
                ▼                    ▼                   ▼                    ▼
          Чтение (сразу)   Изменение: карточка   Изменение: доверит.   Не хватает данных /
                │          → кнопка → выполнить  режим → выполнить     неоднозначно →
                │                    │           + «↩ Отменить»        уточнение / варианты
                └────────────────────┴───────────────────┘
                                     │
                                     ▼
                       CalendarProvider (Google Calendar API)
                                     │
                                     ▼
                         Ответ в Telegram (шаблон i18n)
```
