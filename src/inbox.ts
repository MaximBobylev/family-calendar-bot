// Inbox апдейтов Telegram (ADR-0005 п.1, п.6):
// webhook сохраняет апдейт (дедупликация по update_id) и ставит id в очередь; consumer обрабатывает.
// Обработка «забирает» строку атомарно (pending → processing), поэтому апдейт не выполнится дважды,
// даже если его возьмут одновременно очередь и /__test/drain.
// Повтор после сбоя не повторяет сделанное (tech-debt #5): распознанный текст голосового, факт отправки «🎙 …» и
// разобранный интент хранятся в строке inbox (UpdateProgress) и используются при следующей попытке.

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

/**
 * Обработка, «зависшая» дольше этого (Worker оборвался), может быть забрана снова.
 * Меньше задержки страховки (60 с) и больше лимита waitUntil (30 с) — иначе страховка не подхватит обрыв.
 */
export const STALE_PROCESSING_MS = 45 * 1000;

/** Что уже сделано прошлыми попытками обработки этого апдейта (tech-debt #5). Первая попытка — всё пусто. */
export interface UpdateProgress {
  updateId: number;
  /** Распознанный (и исправленный) текст голосового — STT заново не вызываем. */
  transcript: string | null;
  /** «🎙 …» уже отправлено — не повторяем. */
  heardSent: boolean;
  /** Интент от LLM и текст, по которому он разобран, — LLM заново не вызываем. */
  nlu: { text: string; intent: unknown } | null;
}

export type ClaimOutcome = { status: "claimed"; update: TgUpdate; progress: UpdateProgress } | { status: "done" } | { status: "busy" };

/** Атомарно забирает апдейт в обработку: claimed / done (уже обработан) / busy (обрабатывается сейчас). */
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

/** Апдейт сохранён, но не доведён (повторная доставка Telegram после сбоя) — его стоит запустить снова. */
export async function isUnfinished(db: D1Database, updateId: number): Promise<boolean> {
  const row = await db.prepare("SELECT status FROM inbox WHERE update_id = ?").bind(updateId).first<{ status: string }>();
  return row?.status === "pending" || row?.status === "failed";
}

/** Голосовое распознано (stage 'transcribed'): при повторе STT не нужен. */
export async function saveTranscript(db: D1Database, updateId: number, transcript: string): Promise<void> {
  await db.prepare("UPDATE inbox SET transcript = ?, stage = 'transcribed' WHERE update_id = ?").bind(transcript, updateId).run();
}

/** «🎙 …» отправлено (stage 'heard'): при повторе не отправлять снова. */
export async function markHeardSent(db: D1Database, updateId: number): Promise<void> {
  await db.prepare("UPDATE inbox SET stage = 'heard' WHERE update_id = ?").bind(updateId).run();
}

/** Интент от LLM разобран: при повторе с тем же текстом LLM не нужна. */
export async function saveIntent(db: D1Database, updateId: number, nlu: { text: string; intent: unknown }): Promise<void> {
  await db.prepare("UPDATE inbox SET intent_json = ? WHERE update_id = ?").bind(JSON.stringify(nlu), updateId).run();
}

/** Итог обработки. Обработан — промежуточные шаги (текст голосового, интент) больше не нужны: стираем. */
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
