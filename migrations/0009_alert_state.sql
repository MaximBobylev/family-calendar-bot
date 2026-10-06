-- Алерты владельцу в Telegram (docs/admin-console.md, итерация 2; tech-debt #7).
--
-- alert_state — состояние правила алерта (ключи — src/ops/alert-rules.ts: webhook, inbox_stuck, inbox_failed, jobs,
--   digest_failed, ai_errors) для дедупликации: сообщение при начале, напоминание не чаще раза в 3 ч, «восстановлено»
--   при окончании. Строка пишется только после успешной отправки. Пользовательских данных нет; cleanup не трогает.
-- Номер 0009 (а не 0008) — чтобы не столкнуться с параллельной веткой; порядок применения от этого не зависит.
CREATE TABLE alert_state (
  key          TEXT PRIMARY KEY,
  status       TEXT NOT NULL,          -- firing | ok
  since        INTEGER NOT NULL,       -- начало текущего статуса, мс UTC
  last_sent_at INTEGER                 -- последнее сообщение по ключу
);
