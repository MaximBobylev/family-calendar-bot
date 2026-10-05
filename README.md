# Calendar Assist Bot

Семейный диспетчер в Telegram поверх Google Calendar. Документация и решения — [docs/](docs/README.md).

## Разработка

На хосте нужен только Docker; Node, wrangler и workerd — в контейнере.

```sh
docker compose build                              # один раз и после изменения package.json
docker compose run --rm test                      # тесты (vitest), включая золотой корпус дат
docker compose run --rm test npm run typecheck    # проверка типов
docker compose run --rm test npm run corpus:dates -- --failures   # отчёт по корпусу дат
docker compose run --rm acceptance                # приёмочные сценарии: бот как чёрный ящик + фейки Telegram/Google
docker compose up dev                             # wrangler dev (окружение dev, без Workers AI, с фейками) → http://localhost:8787
```

После изменения `package.json`: `docker compose build && docker compose run --rm dev npm ci`.
После изменения `wrangler.jsonc`: `docker compose run --rm test npm run types`.

Секреты и токены — в `.env` (не коммитится): `cp .env.example .env` и заполнить — там же описано, где взять каждое значение.

## Эксплуатация

- Деплой: `docker compose run --rm deploy` (проверки, миграции, код, секреты из `.env`, webhook). Боевые секреты видит только сервис `deploy`.
- Статистика: `https://<воркер>/admin` — логин/пароль `ADMIN_USER` / `ADMIN_PASSWORD` из `.env`.
- Проверка интентов на реальной модели: `docker compose run --rm deploy npx tsx scripts/probe-intents.ts "фраза" …`.

## Структура

| Путь | Что |
|---|---|
| `src/index.ts` | точка входа Worker'а: webhook → inbox (D1) → очередь; cron → планировщик |
| `src/bot/` | обработка апдейтов, тексты |
| `src/testing/` | тестовые маршруты `/__test/*` (только TEST_MODE, ADR-0006) |
| `migrations/` | схема D1 (ADR-0003) |
| `acceptance/` | фейки внешних API, раннер и YAML-сценарии (ADR-0006) |
| `src/dates/` | детерминированный парсер дат (ADR-0005 п.8) |
| `testdata/dates/` | золотой корпус дат — переносимая спецификация (ADR-0006) |
| `test/` | тесты |
| `docs/` | спецификация, ADR, исследования |
