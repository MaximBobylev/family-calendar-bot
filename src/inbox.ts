// Inbox апдейтов Telegram (ADR-0005 п.1, п.6):
// webhook сохраняет апдейт (дедупликация по update_id) и ставит id в очередь; consumer обрабатывает.
// Обработка «забирает» строку атомарно (pending → processing), поэтому апдейт не выполнится дважды,
// даже если его возьмут одновременно очередь и /__test/drain.

import type { TgUpdate } from "./telegram/types";

export interface InboxMessage {
  updateId: number;
}

/** Сохраняет апдейт. Возвращает false, если он уже был (повторная доставка Telegram). */
export async function acceptUpdate(db: D1Database, update: TgUpdate, now: number): Promise<boolean> {
  const res = await db
    .prepare("INSERT OR IGNORE INTO inbox (update_id, received_at, payload_json, status) VALUES (?, ?, ?, 'pending')")
    .bind(update.update_id, now, JSON.stringify(update))
    .run();
  return res.meta.changes > 0;
}

/** Обработка, «зависшая» дольше этого (Worker оборвался), может быть забрана снова. */
const STALE_PROCESSING_MS = 2 * 60 * 1000;

/** Атомарно забирает апдейт в обработку. null — уже обработан или обрабатывается. */
export async function claimUpdate(db: D1Database, updateId: number, now: number): Promise<TgUpdate | null> {
  const row = await db
    .prepare(
      `UPDATE inbox SET status = 'processing', attempts = attempts + 1, processed_at = ?
       WHERE update_id = ? AND (status IN ('pending', 'failed') OR (status = 'processing' AND processed_at < ?))
       RETURNING payload_json`,
    )
    .bind(now, updateId, now - STALE_PROCESSING_MS)
    .first<{ payload_json: string }>();
  return row ? (JSON.parse(row.payload_json) as TgUpdate) : null;
}

export async function completeUpdate(db: D1Database, updateId: number, now: number, error?: string): Promise<void> {
  await db
    .prepare("UPDATE inbox SET status = ?, processed_at = ?, error = ? WHERE update_id = ?")
    .bind(error ? "failed" : "done", now, error ?? null, updateId)
    .run();
}

export async function pendingUpdateIds(db: D1Database): Promise<number[]> {
  const { results } = await db
    .prepare("SELECT update_id FROM inbox WHERE status = 'pending' ORDER BY update_id")
    .all<{ update_id: number }>();
  return results.map((r) => r.update_id);
}
