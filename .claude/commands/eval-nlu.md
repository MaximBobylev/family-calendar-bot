---
description: Живой замер разбора интентов — сначала оценка квоты, запуск только с разрешения
argument-hint: "[аргументы scripts/eval-intents.ts, напр. --variants E --models or:… --n 1 --cats modify]"
---
Замер `scripts/eval-intents.ts` с аргументами: `$ARGUMENTS`. Живые вызовы тратят квоты **прода** (CLAUDE.md, «Безопасность»): Workers AI Free — 10 000 neurons/сутки на аккаунт, бесплатный OpenRouter — ~50 запросов/сутки; исчерпание = бот не понимает команды до сброса.

1. Оценка без вызовов (ключи не нужны): `docker compose run --rm test npx tsx scripts/eval-intents.ts $ARGUMENTS --dry-run`.
2. Покажи владельцу число вызовов и расход по провайдерам; предложи меньший набор (`--ids`, `--cats`, `--limit`, `--n 1`), если расход заметный. По возможности — модели не с прод-аккаунта.
3. **Жди явного разрешения.** Затем: `docker compose run --rm --entrypoint npx deploy tsx scripts/eval-intents.ts $ARGUMENTS --out reports/nlu-eval/<имя>.json` (сверх 200 вызовов Workers AI скрипт потребует `--spend-quota` — добавлять только если владелец согласился именно на такой расход).
4. Сводку — в ответ; выводы, которые меняют решения, — в `docs/research/llm-intents-eval.md`. Пересчитать сохранённые прогоны без вызовов: `--report reports/nlu-eval/a.json`.
