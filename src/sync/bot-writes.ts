// US-72: запись бота в календарь → сразу уведомление в другие чаты календаря (не в исходный), с автором;
// снимок события обновляется etag'ом ответа Google — push от Google про эту же правку изменений не даст (эхо).
// Запись в серию целиком (мастер-событие) — только в журнал bot_writes: экземпляры придут синком и будут приписаны автору.

import type { AppContext } from "../bot/context";
import type { WriteListener } from "../calendar/google-provider";
import { membershipOf } from "../db/households";
import { insertBotWrite } from "../db/sync";
import type { User } from "../db/users";
import { applyEntries } from "./engine";
import { snapshotOf } from "./logic";

/** «Иван Петров (@ivan)» → «Иван Петров»: в уведомлении — имя, без @username. */
export const authorNameOf = (tgName: string | undefined) => tgName?.replace(/\s*\(@[^)]*\)\s*$/, "").trim() || undefined;

export function botWriteListener(ctx: AppContext, user: User, chatId: number): WriteListener {
  return async (w) => {
    const pcid = w.calendar.providerCalendarId;
    // Имя в доме (US-90: «Аня», «Дима»), иначе — из Telegram (tech-debt #22)
    const member = await membershipOf(ctx.db, user.id).catch(() => null);
    const authorName = member?.displayName || authorNameOf(user.tgName);
    const journal = insertBotWrite(ctx.db, pcid, {
      eventId: w.eventId,
      etag: w.event?.etag ?? null,
      chatId: String(chatId),
      authorUserId: user.id,
      authorName: authorName ?? null,
      at: ctx.clock.now(),
    });
    if (w.event?.recurrence) {
      await journal.run();
      return;
    }
    await applyEntries(
      ctx,
      pcid,
      [
        {
          eventId: w.eventId,
          after: w.event ? snapshotOf(w.event) : null,
          ...(w.op === "create" ? { hint: "created" as const } : w.op === "update" && w.timeChanged ? { hint: "moved" as const } : {}),
          origin: { chatId: String(chatId), ...(authorName ? { authorName } : {}) },
        },
      ],
      { notify: true, extra: [journal] },
    );
  };
}
