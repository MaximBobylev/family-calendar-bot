// Обработка забирает строку атомарно (pending → processing): апдейт не выполнится дважды, даже из очереди и waitUntil сразу (ADR-0005 п.1).
// Сделанное (текст голосового, «🎙 …», интент) хранится в строке, чтобы повтор после сбоя не повторял его (tech-debt #5).

import type { TgUpdate } from "./telegram/types";

export interface InboxMessage {
  updateId: number;
}

/** false — уже был: Telegram доставляет повторно. */
export async function acceptUpdate(db: D1Database, update: TgUpdate, now: number): Promise<boolean> {
  const res = await db
    .prepare("INSERT OR IGNORE INTO inbox (update_id, received_at, payload_json, status) VALUES (?, ?, ?, 'pending')")
    .bind(update.update_id, now, JSON.stringify(update))
    .run();
  return res.meta.changes > 0;
}

/**
 * Обработка, «зависшая» дольше этого (Worker оборвался), может быть забрана снова.
 * Меньше задержки страховки (60 с) и больше лимита waitUntil (30 с) — иначе страховка не подхватит обрыв.
 */
export const STALE_PROCESSING_MS = 45 * 1000;

export interface UpdateProgress {
  updateId: number;
  transcript: string | null;
  heardSent: boolean;
  /** text — по нему разобран интент: другой текст — LLM заново. */
  nlu: { text: string; intent: unknown } | null;
}

export type ClaimOutcome = { status: "claimed"; update: TgUpdate; progress: UpdateProgress } | { status: "done" } | { status: "busy" };

export async function claimUpdate(db: D1Database, updateId: number, now: number): Promise<ClaimOutcome> {
  const row = await db
    .prepare(
      `UPDATE inbox
       SET status = 'processing', attempts = attempts + 1, processed_at = ?
       WHERE update_id = ? AND (status IN ('pending', 'failed') OR (status = 'processing' AND processed_at < ?))
       RETURNING payload_json, transcript, stage, intent_json`,
    )
    .bind(now, updateId, now - STALE_PROCESSING_MS)
    .first<{ payload_json: string; transcript: string | null; stage: string | null; intent_json: string | null }>();
  if (row) {
    const progress: UpdateProgress = {
      updateId,
      transcript: row.transcript,
      heardSent: row.stage === "heard",
      nlu: row.intent_json ? (JSON.parse(row.intent_json) as UpdateProgress["nlu"]) : null,
    };
    return { status: "claimed", update: JSON.parse(row.payload_json) as TgUpdate, progress };
  }
  const current = await db.prepare("SELECT status FROM inbox WHERE update_id = ?").bind(updateId).first<{ status: string }>();
  return current?.status === "processing" ? { status: "busy" } : { status: "done" };
}

export async function isUnfinished(db: D1Database, updateId: number): Promise<boolean> {
  const row = await db.prepare("SELECT status FROM inbox WHERE update_id = ?").bind(updateId).first<{ status: string }>();
  return row?.status === "pending" || row?.status === "failed";
}

export async function saveTranscript(db: D1Database, updateId: number, transcript: string): Promise<void> {
  await db.prepare("UPDATE inbox SET transcript = ?, stage = 'transcribed' WHERE update_id = ?").bind(transcript, updateId).run();
}

export async function markHeardSent(db: D1Database, updateId: number): Promise<void> {
  await db.prepare("UPDATE inbox SET stage = 'heard' WHERE update_id = ?").bind(updateId).run();
}

export async function saveIntent(db: D1Database, updateId: number, nlu: { text: string; intent: unknown }): Promise<void> {
  await db.prepare("UPDATE inbox SET intent_json = ? WHERE update_id = ?").bind(JSON.stringify(nlu), updateId).run();
}

export async function completeUpdate(db: D1Database, updateId: number, now: number, error?: string): Promise<void> {
  await db
    .prepare(
      error
        ? "UPDATE inbox SET status = 'failed', processed_at = ?, error = ? WHERE update_id = ?"
        : "UPDATE inbox SET status = 'done', processed_at = ?, error = ?, transcript = NULL, stage = NULL, intent_json = NULL WHERE update_id = ?",
    )
    .bind(now, error ?? null, updateId)
    .run();
}

export async function pendingUpdateIds(db: D1Database, status: "pending" | "failed" = "pending"): Promise<number[]> {
  const { results } = await db.prepare("SELECT update_id FROM inbox WHERE status = ? ORDER BY update_id").bind(status).all<{ update_id: number }>();
  return results.map((r) => r.update_id);
}
