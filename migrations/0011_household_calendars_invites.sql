-- US-90 / US-94: общие календари дома и одноразовые приглашения (households, household_members, dependents — с 0001).

-- Общие календари дома (ADR-0003: SharedCalendarRef): календари владельца, которые видят и меняют участники.
-- Календарь исчез при переподключении — исчезает и отсюда.
CREATE TABLE household_calendars (
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  calendar_id  TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  PRIMARY KEY (household_id, calendar_id)
);

-- Приглашение по ссылке t.me/<bot>?start=home_<code>: одноразовое, с TTL; aliases_json — имя и другие имена,
-- заданные владельцем при приглашении («Дима, муж, папа»).
CREATE TABLE household_invites (
  code         TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  created_by   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  used_at      INTEGER,
  used_by      TEXT
);
CREATE INDEX household_invites_household ON household_invites(household_id);
CREATE INDEX conversations_household ON conversations(household_id);
