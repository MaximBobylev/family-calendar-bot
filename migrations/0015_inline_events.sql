-- US-95: inline-карточка «📅 Добавить себе». Событие карточки хранится по токену (callback_data, deep link, /ics/<токен>):
-- в callback_data Telegram помещается только 64 байта. Токен детерминирован (HMAC от автора и события) — повторные
-- inline-запросы с тем же текстом не плодят строк. Автор — по Telegram id: inline может прислать и ещё не
-- зарегистрированный пользователь из allowlist.
CREATE TABLE inline_events (
  token TEXT PRIMARY KEY,
  created_by_tg TEXT NOT NULL,
  -- InlineEvent (src/bot/inline/logic.ts): название, время (UTC или даты «весь день»), пояс автора, место, язык карточки
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_inline_events_expires ON inline_events (expires_at);

-- Кто нажал «Добавить себе» под отправленной карточкой — счётчик «Добавили: N» (один человек — один раз на сообщение)
CREATE TABLE inline_adds (
  inline_message_id TEXT NOT NULL,
  telegram_id TEXT NOT NULL,
  token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (inline_message_id, telegram_id)
);
CREATE INDEX idx_inline_adds_created ON inline_adds (created_at);
