// US-91: задачи поручения в планировщике — напоминания исполнителю (за день, за час; без времени — утром в день срока),
// эскалация автору и в групповой чат дома, если за 2 часа до срока никто не ответил, и «истекло» в конце дня — без упрёков.
// Что делать, решается по текущему состоянию поручения: взяли, отменили, перенесли — устаревшая задача ничего не шлёт.

import { assignCallback, offerButtons, doneButtons, whenOfAssignment } from "../bot/assign/view";
import { homeById, memberName } from "../bot/assign/family";
import { notifyMember, refreshMessages, viewerOf } from "../bot/assign/notify";
import type { AppContext } from "../bot/context";
import { t } from "../bot/messages";
import type { AssignJobWhat } from "../bot/assign/logic";
import { addAssignmentMessage, getAssignment, OPEN_STATUSES, transition } from "../db/assignments";
import { householdGroupChats } from "../db/households";
import type { DueJob } from "../scheduler";

export { ASSIGN_JOB } from "../db/assignments";

/** Опоздавшее напоминание (сбой дольше часа) не шлём — оно уже не к месту. */
const MAX_LATE_MS = 60 * 60 * 1000;

export async function runAssignJob(ctx: AppContext, job: DueJob): Promise<void> {
  const { assignmentId, what } = JSON.parse(job.payload_json) as { assignmentId: string; what: AssignJobWhat };
  const a = await getAssignment(ctx.db, assignmentId);
  if (!a || !OPEN_STATUSES.includes(a.status)) return;
  const home = await homeById(ctx.db, a.householdId);
  if (!home) return;
  const now = ctx.clock.now();
  const late = now - job.fire_at > MAX_LATE_MS;

  switch (what) {
    case "day":
    case "hour":
    case "morning": {
      // «Кто-то должен» без исполнителя — напоминать некому, это забота эскалации
      if (!a.assigneeUserId || late) return;
      const sent = await notifyMember(
        ctx,
        a.assigneeUserId,
        (v) => t("assignReminder", v.locale, { title: a.title, when: whenOfAssignment(a, now, v.home_tz, v.locale) }),
        (v) => (a.status === "pending" ? offerButtons(a.id, v.locale) : doneButtons(a.id, v.locale)),
      );
      const chat = sent ? (await viewerOf(ctx, a.assigneeUserId)).chatId : null;
      if (sent && chat) await addAssignmentMessage(ctx.db, a.id, { chatId: chat, messageId: sent.message_id, userId: a.assigneeUserId, role: "offer" });
      return;
    }
    case "escalate": {
      if (a.status !== "pending" || late) return;
      const text = (locale: string, tz: string) => {
        const p = { title: a.title, when: whenOfAssignment(a, now, tz, locale), name: memberName(home, a.assigneeUserId) };
        return t(a.assigneeUserId ? "assignEscalation" : "assignEscalationSomeone", locale, p);
      };
      await notifyMember(ctx, a.createdBy, (v) => text(v.locale, v.home_tz));
      // Семейный чат дома (US-94): там «Беру» может нажать любой взрослый — для «кто-то должен»
      const author = await viewerOf(ctx, a.createdBy);
      for (const chat of await householdGroupChats(ctx.db, a.householdId)) {
        const rows = a.assigneeUserId ? [] : [[{ text: t("assignTakeButton", author.locale), callback_data: assignCallback(a.id, "take") }]];
        const sent = await ctx.telegram.sendMessage(chat, text(author.locale, author.home_tz), { inline_keyboard: rows });
        await addAssignmentMessage(ctx.db, a.id, { chatId: chat, messageId: sent.message_id, userId: null, role: "group" });
      }
      return;
    }
    case "expire": {
      const expired = await transition(ctx.db, a.id, { from: OPEN_STATUSES, to: "expired", now });
      if (expired) await refreshMessages(ctx, expired, home);
      return;
    }
  }
}
