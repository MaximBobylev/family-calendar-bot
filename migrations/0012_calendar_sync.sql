-- Синхронизация Google (ADR-0005 §2), уведомления об изменениях (US-72), напоминания в Telegram (US-71).
--
-- calendar_sync — одна подписка на календарь провайдера, а не на аккаунт: общий календарь, подключённый у двух
--   взрослых, синхронизируется один раз (иначе дубли уведомлений). Ключ — id календаря у Google (глобальный).
--   Колонки sync_token/watch_* в calendars (0001) — на аккаунт; не используются, состояние здесь.
--   owner_calendar_id — чья строка calendars (значит, чей токен) читает календарь; удалили — выберется другая.
--   baseline_at — первая полная синхронизация сделана: до неё изменений «нет» (ничего не рассылаем).
--   lease_until — один синк календаря за раз (push и плановый не считают изменения дважды).
--   channel_* — канал events.watch: id, секрет (заголовок X-Goog-Channel-Token), resourceId (для channels.stop), срок.
CREATE TABLE calendar_sync (
  provider_calendar_id TEXT PRIMARY KEY,
  owner_calendar_id    TEXT REFERENCES calendars(id) ON DELETE SET NULL,
  sync_token           TEXT,
  baseline_at          INTEGER,
  last_sync_at         INTEGER,
  last_change_at       INTEGER,
  lease_until          INTEGER,
  channel_id           TEXT,
  channel_token        TEXT,
  channel_resource_id  TEXT,
  channel_expires_at   INTEGER
);
CREATE UNIQUE INDEX calendar_sync_channel ON calendar_sync(channel_id);

-- event_snapshots — последнее известное состояние события (экземпляра серии) календаря: по нему считается разница
--   «было → стало» (Google в инкрементальном ответе отдаёт только новое состояние) и ставятся напоминания (US-71).
--   Время — мс UTC; для событий на весь день — ещё и даты (start_date/end_date, end — исключающая, как у Google).
--   etag — эхо собственных правок бота: после записи бот сам кладёт сюда etag ответа Google, и push с тем же
--   etag изменений не даёт. Прошедшие события удаляются при синке (ретеншн — 2 дня после окончания).
CREATE TABLE event_snapshots (
  provider_calendar_id TEXT NOT NULL,
  event_id             TEXT NOT NULL,
  series_id            TEXT,
  status               TEXT NOT NULL,       -- confirmed | tentative | cancelled
  title                TEXT,
  location             TEXT,
  conference_url       TEXT,
  html_link            TEXT,
  organizer            TEXT,                -- имя/почта организатора, если не «я»
  all_day              INTEGER NOT NULL DEFAULT 0,
  start_ms             INTEGER,
  end_ms               INTEGER,
  start_date           TEXT,
  end_date             TEXT,
  declined             INTEGER NOT NULL DEFAULT 0,
  etag                 TEXT,
  synced_at            INTEGER NOT NULL,
  PRIMARY KEY (provider_calendar_id, event_id)
);
CREATE INDEX event_snapshots_start ON event_snapshots(provider_calendar_id, start_ms);

-- bot_writes — журнал записей бота в календарь (US-72): кто и из какого чата менял событие. По нему изменения
--   экземпляров серии, которые бот поменял целиком (запись — в мастер-событие), приписываются автору и не уходят
--   в исходный чат. Имя автора — из Telegram в момент действия. Ретеншн — 2 дня.
CREATE TABLE bot_writes (
  provider_calendar_id TEXT NOT NULL,
  event_id             TEXT NOT NULL,
  etag                 TEXT,
  chat_id              TEXT NOT NULL,
  author_user_id       TEXT,
  author_name          TEXT,
  at                   INTEGER NOT NULL
);
CREATE INDEX bot_writes_event ON bot_writes(provider_calendar_id, event_id, at);

-- change_notices — исходящие уведомления об изменениях (US-72), по строке на чат и изменение: outbox. Пишутся вместе
--   со снимками (повтор синка не шлёт дважды и не теряет), отправляются сразу или утром (тихие часы), пачкой —
--   одним сводным сообщением. Ретеншн — 2 дня после отправки.
CREATE TABLE change_notices (
  id           TEXT PRIMARY KEY,
  chat_id      TEXT NOT NULL,
  user_id      TEXT REFERENCES users(id) ON DELETE CASCADE,
  notice_json  TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  deliver_at   INTEGER NOT NULL,
  status       TEXT NOT NULL,          -- queued | sending | sent
  sent_at      INTEGER
);
CREATE INDEX change_notices_chat ON change_notices(chat_id, status, deliver_at);
