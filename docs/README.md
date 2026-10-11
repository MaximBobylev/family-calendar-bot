# Calendar Assist Bot — документация

**Семейный диспетчер в Telegram:** перешлите сообщение или скажите голосом — бот занесёт событие в общий Google Календарь, напомнит, кому нужно, и проследит, что дело взяли.

Ядро — общий календарь и передача дел внутри семьи; управление личным календарём голосом и текстом — базовая функция (R0). Обоснование — [research/pivot-options.md](research/pivot-options.md).
Хостинг — Cloudflare Workers (TypeScript), распознавание речи и интентов — Cloudflare Workers AI (с fallback на внешних провайдеров), даты — детерминированный парсер.

> Статус (2026-10-05): **R0 реализован и в проде** (функционально ≈ 90%, пробелы — [roadmap.md](roadmap.md), «Аудит R0»); начат R1 (US-72). Карта кода — [architecture-map.md](architecture-map.md), правила для агентов — [../CLAUDE.md](../CLAUDE.md).

## Структура

| Файл | Что внутри |
|---|---|
| [architecture-map.md](architecture-map.md) | Карта кода: модуль → назначение, где искать фичу, точки входа |
| [ai-first.md](ai-first.md) | Аудит готовности репозитория к разработке агентами: оценка, что сделано, что осталось |
| [code-style.md](code-style.md) | Стиль кода: Biome, SQL, комментарии, раскладка файлов |
| [tech-debt.md](tech-debt.md) | Ревью (архитектура, безопасность, надёжность) и технический долг |
| [roadmap.md](roadmap.md) | Разбивка на релизы: что в MVP, что позже |
| [user-stories.md](user-stories.md) | Пользовательские сценарии с критериями приёмки |
| [intents.md](intents.md) | Каталог интентов: что бот умеет, какие параметры извлекает |
| [date-rules.md](date-rules.md) | Правила разбора дат и времени, неоднозначные случаи |
| [stretch-goals.md](stretch-goals.md) | Будущие фичи и их влияние на архитектуру |
| [research/google-push.md](research/google-push.md) | Push и синхронизация Google Calendar: требования к адресу канала, срок, syncToken/410, эхо — и как сделано (ADR-0005 §2, US-72) |
| [research/voice-recording-script.md](research/voice-recording-script.md) | Что и как наговорить для замера мультимодального разбора голоса (20 голосовых на человека) |
| [research/voice-synth-eval.md](research/voice-synth-eval.md) | Замер на синтетическом шумном наборе (edge-tts + ffmpeg): Whisper + Nemotron против Gemini 3.5 Flash-Lite одним вызовом |
| [research/qa-r1-family.md](research/qa-r1-family.md) | Исследовательское QA R1 «семейный диспетчер» (2026-10-06): находки по серьёзности; воспроизведения исправлены и перенесены в `acceptance/scenarios/40-r1-family-qa.yaml` |
| [tracks/multimodal-voice.md](tracks/multimodal-voice.md) | Трек: голосовая команда одним мультимодальным вызовом (Gemini и др.) — оценка, дизайн, план замера |
| [tracks/telegram-login.md](tracks/telegram-login.md) | Трек: проверка Telegram-аккаунта при подключении Google (login_url, PKCE, привязка к браузеру) — до публичной беты |
| [tracks/channels-calendar.md](tracks/channels-calendar.md) | Отдельный трек: календарь каналов для организаторов (отложен) |
| [family-plan.md](family-plan.md) | Семейный тариф: что считаем и ограничиваем |
| [monetization-brainstorm.md](monetization-brainstorm.md) | Варианты монетизации (брейншторм) |
| [admin-console.md](admin-console.md) | Админка: функции по этапам, приватность и доступ, алерты, «из ошибки — в тест» (предложение) |
| [research/commercial-viability.md](research/commercial-viability.md) | Сводка независимых оценок коммерческого потенциала |
| [research/pivot-options.md](research/pivot-options.md) | Как подкрутить идею: сводка 4 независимых оценок |
| [research/product-review-r1.md](research/product-review-r1.md) | Продуктовое ревью R1 перед показом семье: пути пользователя, проблемы, справка и онбординг, метрики пробного запуска |
| [research/date-parser-baseline.md](research/date-parser-baseline.md) | Замер chrono-node на золотом корпусе дат — почему свой парсер (ADR-0005 п.8) |
| [research/llm-intents-eval.md](research/llm-intents-eval.md) | Замер разбора интентов: варианты промпта × модели Workers AI, решение и оставшиеся ошибки (2026-10-05) |
| [research/free-models-eval.md](research/free-models-eval.md) | Бесплатные модели OpenRouter (Dots3-Note, Inkling, Nemotron Nano Omni): текст, голос, фото → событие; синтетический набор картинок (2026-10-08) |
| [research/date-parser-architecture-review.md](research/date-parser-architecture-review.md) | Архитектурное ревью парсера дат: молча неверные даты, сверка с LLM, шаги (ждёт решения) |
| [research/llm-date-resolution-eval.md](research/llm-date-resolution-eval.md) | Может ли DeepSeek разрешать даты без грамматики (шаг 4 ревью): A «LLM разрешает» 85%, B «LLM структурирует, резолвит наш код» 96% на корпусе; отложенный набор вне корпуса; рекомендация (2026-10-08) |
| [research/multi-event-scenarios.md](research/multi-event-scenarios.md) | Несколько событий в одном сообщении (US-62, R2): 11 пользовательских сценариев с фразами и ожидаемым поведением — для UX и будущих приёмочных сценариев |
| [research/multi-event-eval.md](research/multi-event-eval.md) | Несколько событий в одном сообщении (US-62): замер Nemotron / Qwen3 на 15 фразах (теряют события: 33–46 % верно, с правилом в промпте у Qwen 71 %) против своего делителя (24 / 24) — основание ADR-0008 |
| [research/multi-event-plan.md](research/multi-event-plan.md) | План реализации US-62 для разработчика: делитель, payload карточки, переключатели, идемпотентность, отмена пачки, тексты, сценарии `47-*`; срез S1 (базовый случай владельца) и полный S2 |
| [research/qa-r1-nlu.md](research/qa-r1-nlu.md) | QA разбора фраз R1 (2026-10-06): 110 фраз (поручения, ответственный, «мои дела», поиск) на Nemotron / Gemini / Gemma с правилами — точность, классы ошибок, исправления по приоритету |
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
| [adr/0007](adr/0007-one-bot-localization.md) | Один бот + локализация через Bot API; боты по языкам — при выходе на отдельный рынок (R3) |
| [adr/0008](adr/0008-multi-event-split.md) | Несколько событий в одном сообщении: делит наш код по датам, LLM даёт названия; одна карточка-список, id события = карточка + строка, отмена пачки одной записью |

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
