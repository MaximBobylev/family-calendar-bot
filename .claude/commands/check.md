---
description: Полная проверка перед «готово» — check, юнит-тесты, все приёмочные сценарии
---
Прогони полную проверку проекта (CLAUDE.md, «Готово = проверено») и доложи фактические числа.

1. `docker compose run --rm test npm run -s check` — typecheck + biome ci.
2. `docker compose run --rm test` — юнит-тесты.
3. `docker compose ps` — если идёт чужой прогон `acceptance`, подожди его. Затем `docker compose up -d dev fakes`; если в этой работе менялись миграции, `wrangler.jsonc` или фейки — `docker compose restart dev fakes`.
4. `docker compose run --rm acceptance`.

Итог одной таблицей: шаг → результат (N passed / ошибки). Для каждого падения — файл и первая строка ошибки; не чини молча, сначала сообщи. Не деплой.
