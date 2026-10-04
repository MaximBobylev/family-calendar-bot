-- Схема по ADR-0003. Время — INTEGER (мс от эпохи, UTC). JSON — TEXT.
-- Таблицы диспетчера (households, assignments, event_meta …) в R0 пустые, но ключи заложены сразу.

-- Пользователи и идентичности ------------------------------------------------

CREATE TABLE users (
  id               TEXT PRIMARY KEY,
  created_at       INTEGER NOT NULL,
  locale           TEXT NOT NULL DEFAULT 'ru',
  home_tz          TEXT NOT NULL DEFAULT 'UTC',
  trip_tz          TEXT,
  trip_until       INTEGER,
  settings_json    TEXT NOT NULL DEFAULT '{}',
  settings_version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE channel_identities (
  channel     TEXT NOT NULL,          -- 'telegram'
  external_id TEXT NOT NULL,          -- telegram user id
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (channel, external_id)
);
CREATE INDEX channel_identities_user ON channel_identities(user_id);

-- Аккаунты провайдеров и календари --------------------------------------------

CREATE TABLE provider_accounts (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider         TEXT NOT NULL,     -- 'google'
  email            TEXT,
  email_hash       TEXT,              -- защита от повторного триала (ADR-0004)
  credentials_enc  TEXT NOT NULL,     -- зашифрованный refresh token
  granted_scopes   TEXT NOT NULL DEFAULT '',
  created_at       INTEGER NOT NULL
);
CREATE INDEX provider_accounts_user ON provider_accounts(user_id);

CREATE TABLE calendars (
  id                   TEXT PRIMARY KEY,
  account_id           TEXT NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
  provider_calendar_id TEXT NOT NULL,
  title                TEXT NOT NULL,
  time_zone            TEXT,
  writable             INTEGER NOT NULL DEFAULT 0,
  is_default           INTEGER NOT NULL DEFAULT 0,
  sync_token           TEXT,
  watch_channel_id     TEXT,
  watch_resource_id    TEXT,
  watch_expires_at     INTEGER,
  UNIQUE (account_id, provider_calendar_id)
);

CREATE TABLE calendar_aliases (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  alias       TEXT NOT NULL,
  calendar_id TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, alias)
);

CREATE TABLE oauth_states (
  state      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);

-- Дом / диспетчер (R1, схема — сейчас) ---------------------------------------

CREATE TABLE households (
  id            TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  name          TEXT,
  created_at    INTEGER NOT NULL
);

CREATE TABLE household_members (
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         TEXT NOT NULL,          -- 'owner' | 'adult' | 'participant'
  display_name TEXT,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  joined_at    INTEGER NOT NULL,
  PRIMARY KEY (household_id, user_id)
);
CREATE UNIQUE INDEX household_members_one_home ON household_members(user_id);

CREATE TABLE dependents (
  id           TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE event_meta (
  account_id          TEXT NOT NULL,
  calendar_id         TEXT NOT NULL,
  event_id            TEXT NOT NULL,
  created_by_user_id  TEXT,
  responsible_user_id TEXT,
  for_dependent_id    TEXT,
  prepare_notes       TEXT,
  PRIMARY KEY (account_id, calendar_id, event_id)
);

CREATE TABLE assignments (
  id                TEXT PRIMARY KEY,
  household_id      TEXT REFERENCES households(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  assignee_user_id  TEXT,              -- NULL = «кто-то должен»
  created_by        TEXT NOT NULL,
  due_at            INTEGER,
  status            TEXT NOT NULL,     -- pending | accepted | declined | done | expired | cancelled
  event_account_id  TEXT,
  event_calendar_id TEXT,
  event_id          TEXT,
  created_at        INTEGER NOT NULL
);

-- Диалог ------------------------------------------------------------------------

CREATE TABLE conversations (
  id           TEXT PRIMARY KEY,
  channel      TEXT NOT NULL,
  chat_id      TEXT NOT NULL,
  kind         TEXT NOT NULL,          -- 'private' | 'group'
  household_id TEXT REFERENCES households(id),
  UNIQUE (channel, chat_id)
);

CREATE TABLE dialog_state (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state_json      TEXT NOT NULL DEFAULT '{}',
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, user_id)
);

-- Карточки подтверждения: в callback_data уходит только id (US-05)
CREATE TABLE pending_actions (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  status          TEXT NOT NULL,       -- open | done | cancelled | expired
  message_id      TEXT,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL
);

-- Inbox и планировщик (ADR-0005) ------------------------------------------------

CREATE TABLE inbox (
  update_id    INTEGER PRIMARY KEY,    -- дедупликация повторной доставки Telegram
  received_at  INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  status       TEXT NOT NULL,          -- pending | processing | done | failed
  attempts     INTEGER NOT NULL DEFAULT 0,
  processed_at INTEGER,
  error        TEXT
);
CREATE INDEX inbox_status ON inbox(status, received_at);

CREATE TABLE scheduled_jobs (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,          -- digest | reminder | escalation | watch_renewal | …
  user_id      TEXT REFERENCES users(id) ON DELETE CASCADE,
  fire_at      INTEGER NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL,          -- pending | queued | done | failed | cancelled
  attempts     INTEGER NOT NULL DEFAULT 0,
  dedupe_key   TEXT UNIQUE
);
CREATE INDEX scheduled_jobs_due ON scheduled_jobs(status, fire_at);

-- Монетизация и учёт (ADR-0004) -------------------------------------------------

CREATE TABLE entitlements (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan        TEXT NOT NULL,           -- comp | trial | personal | family …
  source      TEXT NOT NULL,           -- comp | trial | stars | redeem | family
  starts_at   INTEGER NOT NULL,
  expires_at  INTEGER,                 -- NULL = бессрочно
  limits_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX entitlements_user ON entitlements(user_id);

-- Учёт использования + журнал распознанного (US-13)
CREATE TABLE usage_events (
  id             TEXT PRIMARY KEY,
  user_id        TEXT REFERENCES users(id) ON DELETE CASCADE,
  created_at     INTEGER NOT NULL,
  kind           TEXT NOT NULL,        -- stt | llm
  provider       TEXT NOT NULL,
  model          TEXT NOT NULL,
  audio_ms       INTEGER,
  tokens_in      INTEGER,
  tokens_out     INTEGER,
  cost_micro_usd INTEGER,
  text           TEXT,
  result_json    TEXT,
  outcome        TEXT
);
CREATE INDEX usage_events_user_time ON usage_events(user_id, created_at);

CREATE TABLE feature_usage (
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feature       TEXT NOT NULL,
  first_used_at INTEGER NOT NULL,
  count         INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, feature)
);

-- Только для TEST_MODE: управляемые часы (ADR-0006)
CREATE TABLE test_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
