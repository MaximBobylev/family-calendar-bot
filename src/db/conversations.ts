// Разговоры, состояние диалога и карточки с кнопками (ADR-0003, US-05, US-60).

import type { DateFixWatch } from "../bot/date-fix-logic";
import { type CardVerdict, cardVerdict } from "./card-status";

export const CARD_TTL_MS = 15 * 60 * 1000;

export async function ensureConversation(db: D1Database, chatId: number | string, kind: "private" | "group"): Promise<string> {
  const id = `telegram:${chatId}`;
  await db.prepare("INSERT OR IGNORE INTO conversations (id, channel, chat_id, kind) VALUES (?, 'telegram', ?, ?)").bind(id, String(chatId), kind).run();
  return id;
}

// --- Состояние диалога -------------------------------------------------------

export interface StoredRef {
  accountId: string;
  calendarId: string;
  providerEventId: string;
}

export interface DialogState {
  /** Черновик, ожидающий недостающий слот (US-12): ответ пользователя дополняет его. */
  awaiting?:
    | { kind: "create_time"; draft: unknown; expiresAt: number }
    /** Ввод пояса или других названий календаря из /settings (US-04, US-06). */
    | { kind: "settings_tz"; expiresAt: number }
    | { kind: "settings_digest_time"; expiresAt: number }
    | { kind: "settings_alias"; calendarId: string; expiresAt: number }
    /** Вопросы дома (ревью R1 #3, #7): «Как вас называть?» (userId — кого называет владелец), имя ребёнка, название дома. */
    | { kind: "home_name"; userId?: string; expiresAt: number }
    | { kind: "home_kid"; expiresAt: number }
    | { kind: "home_create"; expiresAt: number }
    /** «До какого числа поездка?» (US-07): ответ датой дополняет поездку. */
    | { kind: "trip_until"; expiresAt: number };
  /** Последний показанный список — для «перенеси вторую» (US-60). */
  lastList?: { refs: StoredRef[]; at: number };
  /** Последнее созданное/изменённое событие — для «её», «эту встречу» (US-60). */
  lastEvent?: { ref: StoredRef; at: number };
  /** Последнее голосовое — переслушать мультимодальной моделью, если текстовый путь ошибся (multimodal-voice, вариант D). */
  lastVoice?: { fileId: string; transcript: string; at: number; durationSec: number; reheard?: boolean };
  /** Последнее действие для «отмени последнее» (US-61): карточка отмены или причина, почему нельзя. */
  lastUndo?: { actionId?: string; at: number; notUndoable?: "delete" | "decline" };
  /** Последняя карточка создания — поймать правку её даты сразу после (метрика date_fix, tech-debt #26). */
  dateFix?: DateFixWatch;
}

/** Окно контекста = окно отмены (US-60). */
export const CONTEXT_TTL_MS = 15 * 60 * 1000;
/** Сколько ждём ответа на вопрос бота (`awaiting`: «во сколько?», ввод настроек). */
export const AWAIT_TTL_MS = 15 * 60 * 1000;

export async function getDialogState(db: D1Database, conversationId: string, userId: string): Promise<DialogState> {
  const row = await db
    .prepare("SELECT state_json FROM dialog_state WHERE conversation_id = ? AND user_id = ?")
    .bind(conversationId, userId)
    .first<{ state_json: string }>();
  return row ? (JSON.parse(row.state_json) as DialogState) : {};
}

export async function setDialogState(db: D1Database, conversationId: string, userId: string, state: DialogState, now: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO dialog_state (conversation_id, user_id, state_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (conversation_id, user_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
    )
    .bind(conversationId, userId, JSON.stringify(state), now)
    .run();
}

/** Попыток compare-and-swap в mergeDialogState, прежде чем записать «последний побеждает» (как было до tech-debt #18). */
const MERGE_ATTEMPTS = 3;

/**
 * Обновить часть состояния, не затирая остальное. Апдейты одного пользователя обрабатываются параллельно (waitUntil
 * на каждый webhook), поэтому read-modify-write защищён оптимистично (tech-debt #18): запись проходит, только если
 * state_json не изменился с чтения (или строки ещё нет); иначе — перечитать и применить patch заново.
 */
export async function mergeDialogState(db: D1Database, conversationId: string, userId: string, patch: Partial<DialogState>, now: number): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const row = await db
      .prepare("SELECT state_json FROM dialog_state WHERE conversation_id = ? AND user_id = ?")
      .bind(conversationId, userId)
      .first<{ state_json: string }>();
    const next: DialogState = { ...(row ? (JSON.parse(row.state_json) as DialogState) : {}), ...patch };
    for (const k of Object.keys(next) as (keyof DialogState)[]) if (next[k] === undefined) delete next[k];
    if (attempt === MERGE_ATTEMPTS) {
      console.warn("dialog_state: concurrent updates, last write wins", conversationId);
      await setDialogState(db, conversationId, userId, next, now);
      return;
    }
    const json = JSON.stringify(next);
    const res = row
      ? await db
          .prepare("UPDATE dialog_state SET state_json = ?, updated_at = ? WHERE conversation_id = ? AND user_id = ? AND state_json = ?")
          .bind(json, now, conversationId, userId, row.state_json)
          .run()
      : await db
          .prepare(
            `INSERT INTO dialog_state (conversation_id, user_id, state_json, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT (conversation_id, user_id) DO NOTHING`,
          )
          .bind(conversationId, userId, json, now)
          .run();
    if (res.meta.changes > 0) return;
  }
}

// --- Карточки (pending actions) ------------------------------------------------

export interface PendingAction<P = unknown> {
  id: string;
  conversationId: string;
  userId: string;
  kind: string;
  payload: P;
  messageId: string | null;
}

export async function createPendingAction(
  db: D1Database,
  a: { conversationId: string; userId: string; kind: string; payload: unknown; now: number; ttlMs?: number },
): Promise<string> {
  const id = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  await db
    .prepare(
      `INSERT INTO pending_actions (id, conversation_id, user_id, kind, payload_json, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
    )
    .bind(id, a.conversationId, a.userId, a.kind, JSON.stringify(a.payload), a.now, a.now + (a.ttlMs ?? CARD_TTL_MS))
    .run();
  return id;
}

export async function attachMessage(db: D1Database, id: string, messageId: number): Promise<void> {
  await db.prepare("UPDATE pending_actions SET message_id = ? WHERE id = ?").bind(String(messageId), id).run();
}

type ClaimResult<P> = { ok: true; action: PendingAction<P> } | { ok: false; reason: "done" | "cancelled" | "expired" | "unknown"; action?: PendingAction<P> };

function rowToAction<P>(r: {
  id: string;
  conversation_id: string;
  user_id: string;
  kind: string;
  payload_json: string;
  message_id: string | null;
}): PendingAction<P> {
  return { id: r.id, conversationId: r.conversation_id, userId: r.user_id, kind: r.kind, payload: JSON.parse(r.payload_json) as P, messageId: r.message_id };
}

/**
 * Атомарно «закрывает» карточку сразу в done — для коротких действий из текста («отмени последнее», ответ на вопрос
 * о названии). Нажатия кнопок идут через claimCard (статус executing, tech-debt #6).
 */
export async function claimPendingAction<P>(db: D1Database, id: string, userId: string, now: number): Promise<ClaimResult<P>> {
  const row = await db
    .prepare(
      `UPDATE pending_actions
       SET status = 'done'
       WHERE id = ? AND user_id = ? AND status = 'open' AND expires_at > ?
       RETURNING id, conversation_id, user_id, kind, payload_json, message_id`,
    )
    .bind(id, userId, now)
    .first<{ id: string; conversation_id: string; user_id: string; kind: string; payload_json: string; message_id: string | null }>();
  if (row) return { ok: true, action: rowToAction<P>(row) };

  const existing = await db
    .prepare(
      `SELECT id, conversation_id, user_id, kind, payload_json, message_id, status, expires_at
       FROM pending_actions
       WHERE id = ? AND user_id = ?`,
    )
    .bind(id, userId)
    .first<{
      id: string;
      conversation_id: string;
      user_id: string;
      kind: string;
      payload_json: string;
      message_id: string | null;
      status: string;
      expires_at: number;
    }>();
  if (!existing) return { ok: false, reason: "unknown" };
  const action = rowToAction<P>(existing);
  if (existing.status === "open" || existing.status === "failed") return { ok: false, reason: "expired", action };
  return { ok: false, reason: existing.status === "cancelled" ? "cancelled" : "done", action };
}

type ActionRow = { id: string; conversation_id: string; user_id: string; kind: string; payload_json: string; message_id: string | null };

export type CardClaim<P> = { ok: true; action: PendingAction<P>; retry: boolean } | { ok: false; verdict: Exclude<CardVerdict, "retry"> };

/**
 * Нажатие кнопки: забрать карточку на выполнение (open → executing) или, если прошлый обработчик умер посреди
 * действия, — забрать заново для идемпотентного kind (tech-debt #6, машина состояний — card-status.ts).
 * После действия — finishCard. Горячий путь — один UPDATE.
 */
export async function claimCard<P>(db: D1Database, id: string, userId: string, now: number, retryable: (kind: string) => boolean): Promise<CardClaim<P>> {
  const claimed = await db
    .prepare(
      `UPDATE pending_actions
       SET status = 'executing', claimed_at = ?3
       WHERE id = ?1 AND user_id = ?2 AND status = 'open' AND expires_at > ?3
       RETURNING id, conversation_id, user_id, kind, payload_json, message_id`,
    )
    .bind(id, userId, now)
    .first<ActionRow>();
  if (claimed) return { ok: true, action: rowToAction<P>(claimed), retry: false };

  const row = await db
    .prepare("SELECT kind, status, claimed_at, expires_at FROM pending_actions WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .first<{ kind: string; status: string; claimed_at: number | null; expires_at: number }>();
  const verdict = cardVerdict(row && { status: row.status, claimedAt: row.claimed_at, expiresAt: row.expires_at }, now, !!row && retryable(row.kind));
  if (verdict !== "retry" && verdict !== "abandoned") return { ok: false, verdict };

  // Брошенная карточка: забрать заново (или пометить failed) только если её не забрал параллельный повтор
  const prev = row!.claimed_at ?? 0;
  if (verdict === "abandoned") {
    await db.prepare("UPDATE pending_actions SET status = 'failed' WHERE id = ? AND status = 'executing' AND coalesce(claimed_at, 0) = ?").bind(id, prev).run();
    return { ok: false, verdict };
  }
  const reclaimed = await db
    .prepare(
      `UPDATE pending_actions
       SET claimed_at = ?3
       WHERE id = ?1 AND user_id = ?2 AND status = 'executing' AND coalesce(claimed_at, 0) = ?4
       RETURNING id, conversation_id, user_id, kind, payload_json, message_id`,
    )
    .bind(id, userId, now, prev)
    .first<ActionRow>();
  return reclaimed ? { ok: true, action: rowToAction<P>(reclaimed), retry: true } : { ok: false, verdict: "inProgress" };
}

/** Итог выполнения карточки: done — действие завершено (или честно отказано), failed — не выполнено из-за сбоя. */
export async function finishCard(db: D1Database, id: string, status: "done" | "failed"): Promise<void> {
  await db.prepare("UPDATE pending_actions SET status = ? WHERE id = ? AND status = 'executing'").bind(status, id).run();
}

/** Новая команда аннулирует открытые карточки этого разговора (US-05). Возвращает их, чтобы отредактировать сообщения. */
export async function cancelOpenCards(db: D1Database, conversationId: string, userId: string, kinds: string[]): Promise<PendingAction[]> {
  if (kinds.length === 0) return [];
  const { results } = await db
    .prepare(
      `UPDATE pending_actions
       SET status = 'cancelled'
       WHERE conversation_id = ? AND user_id = ? AND status = 'open' AND kind IN (${kinds.map(() => "?").join(",")})
       RETURNING id, conversation_id, user_id, kind, payload_json, message_id`,
    )
    .bind(conversationId, userId, ...kinds)
    .all<{ id: string; conversation_id: string; user_id: string; kind: string; payload_json: string; message_id: string | null }>();
  return results.map((r) => rowToAction(r));
}

/** Открытое ожидание ответа на конкретное сообщение бота (ForceReply). */
export async function findOpenByMessage<P>(
  db: D1Database,
  conversationId: string,
  userId: string,
  kind: string,
  messageId: number,
  now: number,
): Promise<PendingAction<P> | null> {
  const row = await db
    .prepare(
      `SELECT id, conversation_id, user_id, kind, payload_json, message_id
       FROM pending_actions
       WHERE conversation_id = ? AND user_id = ? AND kind = ? AND message_id = ? AND status = 'open' AND expires_at > ?`,
    )
    .bind(conversationId, userId, kind, String(messageId), now)
    .first<{ id: string; conversation_id: string; user_id: string; kind: string; payload_json: string; message_id: string | null }>();
  return row ? rowToAction<P>(row) : null;
}
