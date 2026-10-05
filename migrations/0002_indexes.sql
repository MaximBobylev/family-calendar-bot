-- Индексы под реальные запросы (ревью 2026-10-05): отмена открытых карточек на каждую команду,
-- поиск вопроса о названии, очистка по времени.
CREATE INDEX pending_actions_open ON pending_actions(conversation_id, user_id, status, kind);
CREATE INDEX pending_actions_expires ON pending_actions(expires_at);
CREATE INDEX oauth_states_expires ON oauth_states(expires_at);
CREATE INDEX usage_events_created ON usage_events(created_at);
