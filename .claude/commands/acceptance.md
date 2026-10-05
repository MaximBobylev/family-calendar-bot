---
description: Приёмочные сценарии — все или выборочно (US-xx, файл NN-name, подстрока id)
argument-hint: "[US-61 | 10-undo | подстрока-id, …]"
---
Прогони приёмочные сценарии с фильтром: `$ARGUMENTS` (пусто — все).

1. `docker compose ps` — чужой прогон `acceptance` идёт? Подожди: dev и fakes общие, параллельные прогоны мешают друг другу.
2. `docker compose up -d dev fakes` (после правки миграций/фейков — `docker compose restart dev fakes`).
3. Фильтр пуст — `docker compose run --rm acceptance`; иначе — `docker compose run --rm -e SCENARIO="$ARGUMENTS" acceptance`.
   Не уверен, что фильтр что-то выберет, — сначала `docker compose run --rm test npm run -s acceptance -- --list $ARGUMENTS`.

Доложи «N / M passed»; для упавших — id, файл и сообщение раннера. При падении посмотри `docker compose logs --tail=100 dev`.
