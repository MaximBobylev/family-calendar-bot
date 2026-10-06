-- US-91 / US-92: поручения «Беру / Не могу» с напоминаниями и эскалацией (таблица assignments — с 0001).

-- Срок без времени («завтра купит торт»): due_at — полночь дня срока, напоминание утром ([решение 2026-10-06]).
ALTER TABLE assignments ADD COLUMN due_has_time INTEGER NOT NULL DEFAULT 1;
-- Для кого (ребёнок, dependents.id): «забрать Машу» — видно в карточке и списке дел.
ALTER TABLE assignments ADD COLUMN for_dependent_id TEXT;
-- Где поручили: групповой чат дома — туда же предложение «Беру» и эскалация (US-94). NULL — личный чат.
ALTER TABLE assignments ADD COLUMN origin_chat_id TEXT;
ALTER TABLE assignments ADD COLUMN updated_at INTEGER;
-- Связанное событие (event_*): его название и время на момент связи — для карточек без запроса к Google.
ALTER TABLE assignments ADD COLUMN event_label TEXT;

CREATE INDEX assignments_assignee ON assignments(assignee_user_id, status);
CREATE INDEX assignments_household ON assignments(household_id, status);
CREATE INDEX assignments_event ON assignments(event_id, event_calendar_id);

-- Сообщения о поручении с кнопками: предложения исполнителям («Беру / Не могу»), итог автору, пост в группе.
-- Взял один — у остальных кнопки убираются; отменено — всем «Отменено».
CREATE TABLE assignment_messages (
  assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  chat_id       TEXT NOT NULL,
  message_id    INTEGER NOT NULL,
  user_id       TEXT,                 -- кому (для offer); NULL — групповой чат
  role          TEXT NOT NULL,        -- offer | author | group
  answer        TEXT,                 -- declined — этот участник «Не могу» (для «кто-то должен»)
  PRIMARY KEY (assignment_id, chat_id, message_id)
);
