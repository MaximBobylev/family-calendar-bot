// События inline-карточек по токену и счётчик «Добавили себе» (US-95).

import type { InlineEvent } from "../bot/inline/logic";

/** Токен детерминирован: повторный inline-запрос с тем же событием лишь продлевает срок. */
export async function saveInlineEvent(
  db: D1Database,
  a: { token: string; createdByTg: number; event: InlineEvent; now: number; expiresAt: number },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO inline_events (token, created_by_tg, payload_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (token) DO UPDATE SET expires_at = MAX(expires_at, excluded.expires_at)`,
    )
    .bind(a.token, String(a.createdByTg), JSON.stringify(a.event), a.now, a.expiresAt)
    .run();
}

export async function loadInlineEvent(db: D1Database, token: string, now: number): Promise<InlineEvent | null> {
  const row = await db.prepare("SELECT payload_json FROM inline_events WHERE token = ? AND expires_at > ?").bind(token, now).first<{ payload_json: string }>();
  return row ? (JSON.parse(row.payload_json) as InlineEvent) : null;
}

/** Каждый нажавший считается один раз. */
export async function recordInlineAdd(
  db: D1Database,
  a: { inlineMessageId: string; telegramId: number; token: string; now: number },
): Promise<{ count: number; isNew: boolean }> {
  const [insert, count] = await db.batch<{ n: number }>([
    db
      .prepare("INSERT OR IGNORE INTO inline_adds (inline_message_id, telegram_id, token, created_at) VALUES (?, ?, ?, ?)")
      .bind(a.inlineMessageId, String(a.telegramId), a.token, a.now),
    db.prepare("SELECT COUNT(*) AS n FROM inline_adds WHERE inline_message_id = ?").bind(a.inlineMessageId),
  ]);
  return { count: count?.results[0]?.n ?? 0, isNew: (insert?.meta.changes ?? 0) > 0 };
}
