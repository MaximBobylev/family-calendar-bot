// Разговоры, состояние диалога и карточки с кнопками (ADR-0003, US-05, US-60).

export const CARD_TTL_MS = 15 * 60 * 1000;

export async function ensureConversation(db: D1Database, chatId: number | string, kind: "private" | "group"): Promise<string> {
  const id = `telegram:${chatId}`;
  await db
    .prepare("INSERT OR IGNORE INTO conversations (id, channel, chat_id, kind) VALUES (?, 'telegram', ?, ?)")
    .bind(id, String(chatId), kind)
    .run();
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
  awaiting?: { kind: "create_time"; draft: unknown; expiresAt: number };
  /** Последний показанный список — для «перенеси вторую» (US-60). */
  lastList?: { refs: StoredRef[]; at: number };
  /** Последнее созданное/изменённое событие — для «её», «эту встречу» (US-60). */
  lastEvent?: { ref: StoredRef; at: number };
}

/** Окно контекста = окно отмены (US-60). */
export const CONTEXT_TTL_MS = 15 * 60 * 1000;

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
      `INSERT INTO dialog_state (conversation_id, user_id, state_json, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (conversation_id, user_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
    )
    .bind(conversationId, userId, JSON.stringify(state), now)
    .run();
}

/** Обновить часть состояния, не затирая остальное. */
export async function mergeDialogState(db: D1Database, conversationId: string, userId: string, patch: Partial<DialogState>, now: number): Promise<void> {
  const state = await getDialogState(db, conversationId, userId);
  const next: DialogState = { ...state, ...patch };
  for (const k of Object.keys(next) as (keyof DialogState)[]) if (next[k] === undefined) delete next[k];
  await setDialogState(db, conversationId, userId, next, now);
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

type ClaimResult<P> =
  | { ok: true; action: PendingAction<P> }
  | { ok: false; reason: "done" | "cancelled" | "expired" | "unknown"; action?: PendingAction<P> };

function rowToAction<P>(r: { id: string; conversation_id: string; user_id: string; kind: string; payload_json: string; message_id: string | null }): PendingAction<P> {
  return { id: r.id, conversationId: r.conversation_id, userId: r.user_id, kind: r.kind, payload: JSON.parse(r.payload_json) as P, messageId: r.message_id };
}

/** Атомарно «закрывает» карточку для выполнения: повторное нажатие получит reason=done (US-05). */
export async function claimPendingAction<P>(db: D1Database, id: string, userId: string, now: number): Promise<ClaimResult<P>> {
  const row = await db
    .prepare(
      `UPDATE pending_actions SET status = 'done'
       WHERE id = ? AND user_id = ? AND status = 'open' AND expires_at > ?
       RETURNING id, conversation_id, user_id, kind, payload_json, message_id`,
    )
    .bind(id, userId, now)
    .first<{ id: string; conversation_id: string; user_id: string; kind: string; payload_json: string; message_id: string | null }>();
  if (row) return { ok: true, action: rowToAction<P>(row) };

  const existing = await db
    .prepare("SELECT id, conversation_id, user_id, kind, payload_json, message_id, status, expires_at FROM pending_actions WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .first<{ id: string; conversation_id: string; user_id: string; kind: string; payload_json: string; message_id: string | null; status: string; expires_at: number }>();
  if (!existing) return { ok: false, reason: "unknown" };
  const action = rowToAction<P>(existing);
  if (existing.status === "open") return { ok: false, reason: "expired", action };
  return { ok: false, reason: existing.status === "cancelled" ? "cancelled" : "done", action };
}

export async function cancelPendingAction(db: D1Database, id: string): Promise<void> {
  await db.prepare("UPDATE pending_actions SET status = 'cancelled' WHERE id = ? AND status = 'open'").bind(id).run();
}

/** Новая команда аннулирует открытые карточки этого разговора (US-05). Возвращает их, чтобы отредактировать сообщения. */
export async function cancelOpenCards(db: D1Database, conversationId: string, userId: string, kinds: string[]): Promise<PendingAction[]> {
  if (kinds.length === 0) return [];
  const { results } = await db
    .prepare(
      `UPDATE pending_actions SET status = 'cancelled'
       WHERE conversation_id = ? AND user_id = ? AND status = 'open' AND kind IN (${kinds.map(() => "?").join(",")})
       RETURNING id, conversation_id, user_id, kind, payload_json, message_id`,
    )
    .bind(conversationId, userId, ...kinds)
    .all<{ id: string; conversation_id: string; user_id: string; kind: string; payload_json: string; message_id: string | null }>();
  return results.map((r) => rowToAction(r));
}

/** Открытое ожидание ответа на конкретное сообщение бота (ForceReply). */
export async function findOpenByMessage<P>(db: D1Database, conversationId: string, userId: string, kind: string, messageId: number, now: number): Promise<PendingAction<P> | null> {
  const row = await db
    .prepare(
      `SELECT id, conversation_id, user_id, kind, payload_json, message_id FROM pending_actions
       WHERE conversation_id = ? AND user_id = ? AND kind = ? AND message_id = ? AND status = 'open' AND expires_at > ?`,
    )
    .bind(conversationId, userId, kind, String(messageId), now)
    .first<{ id: string; conversation_id: string; user_id: string; kind: string; payload_json: string; message_id: string | null }>();
  return row ? rowToAction<P>(row) : null;
}
