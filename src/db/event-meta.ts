// «Для кого» и «ответственный» хранятся у нас, а не в Google, — чтобы видели и участники без Google (US-92).
// Автора события (created_by_user_id) пишет households.ts:recordEventCreator.

import type { EventRef } from "../calendar/model";

export interface EventFamilyMeta {
  responsibleUserId: string | null;
  forDependentId: string | null;
}

/** undefined — не трогать, null — убрать. */
export async function setEventFamily(
  db: D1Database,
  ref: EventRef,
  meta: { responsibleUserId?: string | null; forDependentId?: string | null },
): Promise<void> {
  if (meta.responsibleUserId === undefined && meta.forDependentId === undefined) return;
  await db
    .prepare(
      `INSERT INTO event_meta (account_id, calendar_id, event_id, responsible_user_id, for_dependent_id)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (account_id, calendar_id, event_id) DO UPDATE SET
         responsible_user_id = CASE WHEN ?6 THEN excluded.responsible_user_id ELSE responsible_user_id END,
         for_dependent_id = CASE WHEN ?7 THEN excluded.for_dependent_id ELSE for_dependent_id END`,
    )
    .bind(
      ref.accountId,
      ref.calendarId,
      ref.providerEventId,
      meta.responsibleUserId ?? null,
      meta.forDependentId ?? null,
      meta.responsibleUserId !== undefined ? 1 : 0,
      meta.forDependentId !== undefined ? 1 : 0,
    )
    .run();
}

/** Экземпляры серии ищутся и по id серии — ответственный бывает за всю серию. Ключ — «calendarId|eventId». */
export async function familyMetaFor(db: D1Database, refs: { calendarId: string; ids: string[] }[]): Promise<Map<string, EventFamilyMeta>> {
  const out = new Map<string, EventFamilyMeta>();
  const pairs = refs.flatMap((r) => r.ids.map((id) => [r.calendarId, id] as const));
  // Лимит D1 — 100 параметров на запрос
  for (let i = 0; i < pairs.length; i += 45) {
    const chunk = pairs.slice(i, i + 45);
    const { results } = await db
      .prepare(
        `SELECT calendar_id, event_id, responsible_user_id, for_dependent_id
         FROM event_meta
         WHERE (responsible_user_id IS NOT NULL OR for_dependent_id IS NOT NULL)
           AND (${chunk.map(() => "(calendar_id = ? AND event_id = ?)").join(" OR ")})`,
      )
      .bind(...chunk.flat())
      .all<{ calendar_id: string; event_id: string; responsible_user_id: string | null; for_dependent_id: string | null }>();
    for (const r of results) out.set(`${r.calendar_id}|${r.event_id}`, { responsibleUserId: r.responsible_user_id, forDependentId: r.for_dependent_id });
  }
  return out;
}
