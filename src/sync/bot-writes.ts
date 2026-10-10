// Снимок обновляется etag'ом ответа Google — push про эту же правку придёт эхом без изменений. Запись в серию целиком —
// только в журнал bot_writes: экземпляры придут синком и будут приписаны автору по журналу.

import type { AppContext } from "../bot/context";
import type { WriteListener } from "../calendar/google-provider";
import { membershipOf } from "../db/households";
import { insertBotWrite } from "../db/sync";
import type { User } from "../db/users";
import { applyEntries } from "./engine";
import { snapshotOf } from "./logic";

// «Иван Петров (@ivan)» → «Иван Петров»
export const authorNameOf = (tgName: string | undefined) => tgName?.replace(/\s*\(@[^)]*\)\s*$/, "").trim() || undefined;

export function botWriteListener(ctx: AppContext, user: User, chatId: number): WriteListener {
  return async (w) => {
    const pcid = w.calendar.providerCalendarId;
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
          origin: { chatId: String(chatId), authorUserId: user.id, ...(authorName ? { authorName } : {}) },
        },
      ],
      { notify: true, extra: [journal] },
    );
  };
}
