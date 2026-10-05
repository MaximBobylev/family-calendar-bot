-- Планировщик через очередь (tech-debt #14): когда задачу отдали в очередь — чтобы вернуть зависшие;
-- последняя ошибка — для разбора.
ALTER TABLE scheduled_jobs ADD COLUMN queued_at INTEGER;
ALTER TABLE scheduled_jobs ADD COLUMN last_error TEXT;
CREATE INDEX scheduled_jobs_user_kind ON scheduled_jobs(user_id, kind, status);
