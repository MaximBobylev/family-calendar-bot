-- Здоровье синхронизации для админки и алерта sync_stale (docs/admin-console.md, итерация 3). Только служебные поля:
--   last_outcome  — исход последней попытки синка: ok | unavailable (доступ отозван, календарь удалён) | error (повтор задачей);
--   last_error_at / last_error — когда и класс последней ошибки (errorClass: имя и префикс, без текста ответа Google);
--   last_resync_at — последняя полная пересинхронизация после 410 (syncToken истёк).
ALTER TABLE calendar_sync ADD COLUMN last_outcome TEXT;
ALTER TABLE calendar_sync ADD COLUMN last_error_at INTEGER;
ALTER TABLE calendar_sync ADD COLUMN last_error TEXT;
ALTER TABLE calendar_sync ADD COLUMN last_resync_at INTEGER;
