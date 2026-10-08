-- Метрика качества дат (tech-debt #26, ревью парсера дат 2026-10-08, шаг 3): события, созданные из карточки, и правки даты
-- сразу после неё (date_fix). Только счётчики и коды — без текстов и названий.
CREATE TABLE date_metrics (
  id         TEXT PRIMARY KEY,
  user_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  event      TEXT NOT NULL,              -- created | fix
  source     TEXT NOT NULL,              -- message | forward | image | unknown
  fix_kind   TEXT,                       -- option_ours | option_llm | modify | recreate (только для fix)
  agreement  TEXT,                       -- исход date_check карточки: agree | differ | ours_only | llm_only | llm_invented | none
  disagreed  INTEGER NOT NULL DEFAULT 0  -- date_check разошёлся (differ | llm_invented)
);
CREATE INDEX date_metrics_time ON date_metrics(created_at);
