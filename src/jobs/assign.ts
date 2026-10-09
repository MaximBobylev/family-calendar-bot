// US-91: задачи поручения в планировщике — напоминания исполнителю (за день, «ответьте, пожалуйста» за 3 ч, за час; без
// времени — утром в день срока), эскалация (именное — только автору лично; «кто-то должен» — автору и нейтрально в групповой
// чат дома с «Беру»), если никто не ответил, и «истекло» в конце дня — без упрёков. Расписание — planAssignmentJobs.
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
    case "ask":
    case "hour":
    case "morning": {
      // «Кто-то должен» без исполнителя — напоминать некому, это забота эскалации. Исполнитель ушёл из дома — молчим (QA-06)
      if (!a.assigneeUserId || late || !home.members.some((m) => m.userId === a.assigneeUserId)) return;
      // «Ответьте, пожалуйста» — только пока не ответили
      if (what === "ask" && a.status !== "pending") return;
      const sent = await notifyMember(
        ctx,
        a.assigneeUserId,
        (v) => t(what === "ask" ? "assignAsk" : "assignReminder", v.locale, { title: a.title, when: whenOfAssignment(a, now, v.tz, v.locale) }),
        (v) => (a.status === "pending" ? offerButtons(a.id, v.locale) : doneButtons(a.id, v.locale)),
      );
      const chat = sent ? (await viewerOf(ctx, a.assigneeUserId)).chatId : null;
      if (sent && chat) await addAssignmentMessage(ctx.db, a.id, { chatId: chat, messageId: sent.message_id, userId: a.assigneeUserId, role: "offer" });
      return;
    }
    case "escalate": {
      if (a.status !== "pending" || late) return;
      const p = (locale: string, tz: string) => ({ title: a.title, when: whenOfAssignment(a, now, tz, locale), name: memberName(home, a.assigneeUserId) });
      // Именное поручение — только автору, лично: публично в семейном чате это укор (эпик 9, ревью R1 #5)
      await notifyMember(ctx, a.createdBy, (v) => t(a.assigneeUserId ? "assignEscalation" : "assignEscalationSomeone", v.locale, p(v.locale, v.tz)));
      if (a.assigneeUserId) return;
      // «Кто-то должен» — нейтрально предложить в семейном чате дома (US-94): «Беру» может нажать любой взрослый
      const author = await viewerOf(ctx, a.createdBy);
      for (const chat of await householdGroupChats(ctx.db, a.householdId)) {
        const rows = [[{ text: t("assignTakeButton", author.locale), callback_data: assignCallback(a.id, "take") }]];
        const sent = await ctx.telegram.sendMessage(chat, t("assignNeedSomeone", author.locale, p(author.locale, author.tz)), { inline_keyboard: rows });
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
