-- Админка, первая итерация (docs/admin-console.md).
--
-- admin_audit — журнал действий операторов: каждый «Показать» в журнале распознанного и (позже) каждое изменение.
--   Только INSERT из кода админки (src/admin/queries.ts), без UPDATE/DELETE. Хранение: бессрочно — cleanup её
--   не трогает (пересмотреть до беты: в дизайне — 1 год). target_user_id — внутренний id без внешнего ключа:
--   запись переживает удаление пользователя (/disconnect), PII в ней нет.
--   operator — пока имя пользователя HTTP Basic; с Cloudflare Access — id из таблицы operators.
CREATE TABLE admin_audit (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  at             INTEGER NOT NULL,
  operator       TEXT NOT NULL,
  action         TEXT NOT NULL,        -- view_reveal | …
  target_user_id TEXT,
  reason         TEXT,
  details_json   TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX admin_audit_at ON admin_audit(at);

-- ops_state — служебные метки эксплуатации: last_tick_at / last_hourly_at (cron), кеш getWebhookInfo.
-- Ключ-значение, перезаписывается; пользовательских данных нет.
CREATE TABLE ops_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
