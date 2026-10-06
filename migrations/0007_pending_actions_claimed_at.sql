-- tech-debt #6: статус «executing» у карточек. claimed_at — когда нажатие забрало карточку на выполнение;
-- по нему повторное нажатие отличает «ещё выполняется» от «обработчик умер посреди действия».
-- Статусы pending_actions: open | executing | done | failed | cancelled (машина состояний — src/db/card-status.ts).
ALTER TABLE pending_actions ADD COLUMN claimed_at INTEGER;
