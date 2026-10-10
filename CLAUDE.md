# Calendar Assist Bot — инструкции для агентов

Семейный диспетчер в Telegram поверх Google Calendar: Cloudflare Workers (TypeScript) + D1 + Queues, LLM/STT через цепочки провайдеров, детерминированный парсер дат. Спецификация первична: сначала `docs/`, потом код. Этот файл читают Claude Code и другие агенты (`AGENTS.md` — ссылка на него).

## Где что

- Документация и её индекс — `docs/README.md`. Истории с AC — `docs/user-stories.md`, статус R0/R1 — `docs/roadmap.md`, интенты — `docs/intents.md`, даты — `docs/date-rules.md`, решения — `docs/adr/`, долг — `docs/tech-debt.md`, стиль — `docs/code-style.md`.
- **Карта кода** (файл → назначение, «где искать фичу») — `docs/architecture-map.md`. Шапка каждого файла `src/` — 1–3 строки о модуле.
- Связь история → сценарии → код: `docker compose run --rm test npm run -s stories` (`-- --missing` — только истории без сценариев).
- `worker-configuration.d.ts` (≈600 КБ, генерируется) целиком не читать.

## Команды (на хосте только Docker; всё — в контейнерах)

```sh
docker compose run --rm test                                  # все юнит-тесты (vitest, ~1 с)
docker compose run --rm test npx vitest run test/rrule.test.ts  # один файл; -t "имя" — один тест
docker compose run --rm test npm run -s check                 # typecheck (4 tsconfig) + biome ci — как перед деплоем
docker compose run --rm test npx biome check --write <файлы>  # формат + безопасные автофиксы ТОЛЬКО своих файлов
docker compose run --rm test npm run -s corpus:dates -- --failures  # расхождения золотого корпуса дат

# Приёмочные сценарии (бот как чёрный ящик + фейки, ~30 с на все)
docker compose up -d dev fakes                                # один раз; dev = wrangler dev, применяет миграции при старте
docker compose run --rm acceptance                            # все сценарии
docker compose run --rm -e SCENARIO=undo acceptance           # выборочно: US-61 | 10-undo | подстрока id; через запятую
docker compose run --rm test npm run -s acceptance -- --list US-30   # только список, без SUT
docker compose logs --tail=100 dev                            # логи бота (console.error из Worker)
```

- `wrangler dev` подхватывает правки `src/` сам. **`docker compose restart dev`** — после новой миграции, правки `wrangler.jsonc` или если поведение «застряло». **`docker compose restart fakes`** — после правки `acceptance/fakes/server.ts` (без автоперезагрузки).
- После `package.json`: `docker compose build && docker compose run --rm dev npm ci`. После `wrangler.jsonc`: `docker compose run --rm test npm run types`.
- Фильтр, который ничего не выбрал, — ошибка (exit 2), а не «0 / 0 passed».

## Готово = проверено

Прежде чем сказать «готово», прогнать и увидеть зелёным:
1. `docker compose run --rm test npm run -s check`
2. `docker compose run --rm test`
3. `docker compose run --rm acceptance` (после `restart dev`, если менялись миграции/конфиг)

Сообщая результат, приводить фактические числа (`N passed`), а не «должно работать». Что не удалось проверить — сказать явно.

## Безопасность — обязательно

- **`.env` не читать, не печатать, не менять** (боевые секреты). В контейнеры `dev`/`test`/`acceptance`/`fakes` он смонтирован пустым (`/dev/null`); секреты видит только сервис `deploy`. Шаблон и описание переменных — `.env.example` (его читать можно).
- **Деплой — только по явной просьбе владельца в этом разговоре**: `docker compose run --rm deploy` (typecheck, biome, тесты, миграции `--remote`, код, секреты, webhook). Никаких `wrangler deploy`/`--remote`/`wrangler secret` в обход.
- **Живые вызовы LLM/STT** (`scripts/probe-*.ts`, `scripts/eval-intents.ts`, всё через `--entrypoint npx deploy`) тратят квоты **прода**: Workers AI Free — 10 000 neurons/сутки на аккаунт (замер 2026-10-05 выбрал её, и бот до полуночи UTC не понимал команды), бесплатный OpenRouter — ~50 запросов/сутки. Только с разрешения владельца; сначала `--dry-run` (считает вызовы, ничего не вызывает), сверх 200 вызовов Workers AI скрипт требует `--spend-quota`.
- **Миграции** `migrations/NNNN_*.sql` после применения не редактируются (даже комментарии) — только новый файл со следующим номером; новую таблицу добавить в список очистки `src/testing/routes.ts` (TABLES).
- В репозиторий не попадают реальные фразы пользователей с именами (журнал админки → тест — только после анонимизации).
- `git push`, `reset --hard`, `clean`, переписывание истории — только по просьбе.

## Параллельные агенты в одном дереве

Здесь часто работают несколько агентов одновременно в одной рабочей копии и с одними контейнерами.
- Коммитить **только свои файлы, явными путями**: `git add путь1 путь2 && git commit -m …`; не `git add -A`/`.`, не `git stash`, не `checkout --`/`restore` чужих правок.
- Не форматировать весь проект (`npm run format`) — только свои файлы (`npx biome check --write <файлы>`).
- Приёмочные прогоны **по одному**: dev и fakes общие, каждый сценарий делает `/__test/reset` — параллельный прогон даст ложные падения. Чужой прогон идёт (`docker compose ps`) — подождать. Не делать `docker compose down` и `restart` без нужды.
- Красный тест в чужой области — сначала проверить `git status`/`git diff`: возможно, другой агент на полпути.

### Параллельно с приёмкой — отдельный git worktree на агента

Свой стенд без помех: отдельная папка → своё имя compose-проекта (по имени папки) → свои контейнеры, сеть, том `node_modules` и локальная D1 (`.wrangler/` внутри папки).
```sh
git worktree add ../cab-wt-<задача> -b wt/<задача>   # или Agent с isolation: "worktree"
cd ../cab-wt-<задача>
DEV_PORT=8788 docker compose up -d dev fakes          # свой порт хоста (у основной папки — 8787)
docker compose run --rm -T acceptance
docker compose down -v                                # по завершении: убрать стенд и тома
```
- Первый запуск в новой папке собирает образ и заполняет том `node_modules` (~1 мин).
- Память: стенд (dev + fakes) ≈ 300–500 МБ — не больше 2–3 стендов одновременно.
- `.env` есть только в основной папке: **деплой — только оттуда**, после слияния ветки worktree.

## Как добавлять фичу

1. **Спецификация**: AC в `docs/user-stories.md` (US-xx), при новом интенте — `docs/intents.md`, при датах — `docs/date-rules.md`; решение уровня архитектуры — ADR.
2. **Данные-тесты до кода**: сценарий `acceptance/scenarios/NN-*.yaml` с `story: US-xx` (неизвестный шаг роняет раннер — новые шаги описать в типе `Step` в `acceptance/runner.ts` и фейках); даты — кейсы в `testdata/dates/`, извлечение — `testdata/extract/`.
3. **Код** — по `docs/code-style.md` и `docs/architecture-map.md`.
4. **Проверка** — раздел «Готово = проверено».
5. **Документы**: статус в `docs/roadmap.md`, новые файлы — в `docs/architecture-map.md`, новый долг — в `docs/tech-debt.md`, новый документ — в индекс `docs/README.md`.

## Договорённости в коде

- **Комментария нет по умолчанию — он должен доказать право на существование** (не «верно и относится к делу», а «без него ошибутся»: неочевидное почему, внешнее ограничение, замер, ловушка). По-русски, коротко. Шапка файла — 1–2 строки `//` о главном принципе модуля. Подробно — `docs/code-style.md`.
- Время — только через внедряемые часы (`ctx.clock.now()`), никаких `Date.now()`/`new Date()` для «сейчас» в логике; внешние URL — только из `src/config.ts` (тесты подменяют их фейками, ADR-0006).
- SQL — prepared statements, в `src/db/*` (часть пока в других модулях — долг); ключевые слова прописными.
- Тексты бота — только `src/bot/messages/*.ts` (собираются в `src/bot/messages.ts`) (RU и EN). Даты вычисляет код, не LLM (ADR-0005 п.3).
- `test/` и `scripts/` компилируются с типами Node, без типов Workers (`*/tsconfig.json`): импортировать оттуда можно только чистые модули `src/` без `Env`/`D1Database` и т.п.; поведение с D1 и сетью проверяется приёмочными сценариями.
- `acceptance/` и `testdata/` не импортируют код приложения: они должны пережить переписывание на Go (ADR-0006).
- Biome: ширина 160, двойные кавычки; грамматика дат (`src/dates/{lexicon,point,recurrence,tokenize,duration}.ts`) свёрстана таблицами — форматтер для неё выключен, сохранять стиль руками.
- Сообщения коммитов — по-английски, одна строка сути (+ детали), в конце трейлер `Co-Authored-By:` агента.

## Отладка

- Локально: `docker compose logs dev`; бот — `http://localhost:8787`; фейки наружу не проброшены, состояние — изнутри: `docker compose exec -T fakes node -e "fetch('http://localhost:9100/__fake/telegram/calls').then(r=>r.text()).then(console.log)"` (остальные `/__fake/*` — шапка `acceptance/fakes/server.ts`).
- Прод: `/admin` (здоровье, замаскированный журнал распознанного US-13, расход) — логин из `.env`, значит, только владелец. Сбои сами приходят владельцу в Telegram (алерты раз в 5 мин, `src/ops/`, `docs/admin-console.md`); `GET /health` — D1 и возраст cron. Логи — одна строка JSON на событие (`src/log.ts`): `docker compose logs dev | grep '"event":"job"'`, в проде — `wrangler tail`. Алерты локально — `POST /__test/alerts`. Живые пробы провайдеров — `scripts/probe-intents.ts`, `probe-stt.ts`, `probe-voice.ts` (см. правило о квотах).
- Фраза из журнала → тест: кнопка «В тест» в админке даёт YAML-заготовку (`src/admin/yaml-snippet.ts`).

## Словарь (термины в коде)

| Термин | В коде |
|---|---|
| Карточка | сообщение с кнопками подтверждения; строка `pending_actions` (`kind`, `payload_json`, TTL), `src/db/conversations.ts` |
| Диалог / вопрос | ожидание ответа («во сколько?», ввод пояса) — `dialog_state.awaiting` |
| Inbox | таблица `inbox`: принятые апдейты Telegram, дедуп по `update_id` |
| Задача | `scheduled_jobs` (дайджест и др.), выполняется через очередь `INBOX` |
| Привязка | OAuth Google: `oauth_states` → `provider_accounts` → `calendars` |
| Алиас | другое имя календаря (`calendar_aliases`, US-06) |
| Серия | повторяющееся событие; «только эту / всю серию» = `scope` |
| Дайджест | утренняя сводка «Сегодня» (US-70, `src/jobs/digest.ts`) |
| Переслушивание | повторный разбор голосового мультимодальной моделью (`VOICE_CHAIN`) |
| Цепочка провайдеров | `LLM_CHAIN` / `STT_CHAIN` / `VOICE_CHAIN`: основной → запасные (ADR-0002) |
| Журнал | `usage_events`: вызовы LLM/STT с текстом (US-13), по нему же лимиты |
