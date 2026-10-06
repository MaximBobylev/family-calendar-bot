// US-91: ответы на поручение кнопками — «Беру» (первый забирает «кто-то должен»), «Не могу» (автору — «Сделаю сам» /
// «Предложить другому»), «Сделано», отмена автором; в группе дома «Беру» нажимает любой взрослый (US-94).
// Список «мои дела», сдвиг поручений при переносе связанного события и отмена при его удалении.

import type { EventRef } from "../../calendar/model";
import { formatMoment, parseLocal, utcToLocal } from "../../dates/calendar";
import { extractDateSpans } from "../../dates/extract";
import { parseDateFragment } from "../../dates";
import {
  addAssignmentMessage,
  type Assignment,
  assignmentMessages,
  clearOfferAnswers,
  cancelAssignmentJobs,
  getAssignment,
  markOfferAnswer,
  OPEN_STATUSES,
  openAssignmentsFor,
  openAssignmentsForEvent,
  openAssignmentsForProviderEvent,
  scheduleAssignmentJobs,
  setAssignmentDue,
  transition,
} from "../../db/assignments";
import { setEventFamily } from "../../db/event-meta";
import { membershipOf } from "../../db/households";
import type { User } from "../../db/users";
import type { TgCallbackQuery } from "../../telegram/types";
import type { AppContext } from "../context";
import { dateLabel } from "../format";
import { t } from "../messages";
import { type Home, homeById, loadHome, memberName } from "./family";
import { planAssignmentJobs } from "./logic";
import { notifyMember, offerMarkup, refreshMessages, sendOffers, viewerOf } from "./notify";
import { assignCallback, declinedButtons, doneButtons, parseAssignCallback, whenOfAssignment } from "./view";

const params = (ctx: AppContext, a: Assignment, home: Home, v: { locale: string; home_tz: string }) => ({
  title: a.title,
  when: whenOfAssignment(a, ctx.clock.now(), v.home_tz, v.locale),
  name: memberName(home, a.assigneeUserId),
});

async function reschedule(ctx: AppContext, a: Assignment, tz: string): Promise<void> {
  await cancelAssignmentJobs(ctx.db, a.id);
  if (a.dueAt !== null) await scheduleAssignmentJobs(ctx.db, a.id, planAssignmentJobs({ dueAt: a.dueAt, hasTime: a.dueHasTime, now: ctx.clock.now(), tz }));
}

/** Нажатие кнопки поручения «as:…» — в личном чате и в группе дома. Нажимает сам участник (не от имени автора). */
export async function handleAssignCallback(ctx: AppContext, user: User, cq: TgCallbackQuery): Promise<void> {
  const parsed = parseAssignCallback(cq.data);
  const a = parsed ? await getAssignment(ctx.db, parsed.id) : null;
  const membership = a ? await membershipOf(ctx.db, user.id) : null;
  const home = a && membership?.household.id === a.householdId ? await homeById(ctx.db, a.householdId) : null;
  if (!parsed || !a || !home) {
    await ctx.telegram.answerCallbackQuery(cq.id, t(a ? "groupMembersOnlyButton" : "assignNotActual", user.locale));
    return;
  }
  const now = ctx.clock.now();
  const pressed = cq.message ? { chatId: String(cq.message.chat.id), messageId: cq.message.message_id } : undefined;
  const answer = (key?: Parameters<typeof t>[0], p: Record<string, string> = {}) =>
    ctx.telegram.answerCallbackQuery(cq.id, key ? t(key, user.locale, p) : undefined);
  const editPressed = (text: string, rows: { text: string; callback_data?: string }[][] = []) =>
    pressed ? ctx.telegram.editMessageText(pressed.chatId, pressed.messageId, text, { inline_keyboard: rows }) : Promise.resolve();
  const isAuthor = a.createdBy === user.id;

  switch (parsed.act) {
    case "take": {
      if (a.assigneeUserId && a.assigneeUserId !== user.id) {
        return void (await answer(a.status === "accepted" ? "assignAlreadyTaken" : "assignNotYours", { name: memberName(home, a.assigneeUserId) }));
      }
      const taken = await transition(ctx.db, a.id, { from: ["pending"], to: "accepted", assignee: user.id, requireAssignee: user.id, now });
      if (!taken) {
        // Гонка «кто-то должен»: другой успел раньше
        const cur = await getAssignment(ctx.db, a.id);
        if (cur?.status === "accepted" && cur.assigneeUserId !== user.id)
          return void (await answer("assignAlreadyTaken", { name: memberName(home, cur.assigneeUserId) }));
        return void (await answer(cur?.status === "accepted" ? "alreadyDone" : "assignNotActual"));
      }
      await answer();
      if (taken.event) await setEventFamily(ctx.db, taken.event, { responsibleUserId: user.id });
      await refreshMessages(ctx, taken, home);
      if (!isAuthor) await notifyMember(ctx, a.createdBy, (v) => t("assignTakenBy", v.locale, params(ctx, taken, home, v)));
      return;
    }
    case "decline": {
      if (a.assigneeUserId === user.id && OPEN_STATUSES.includes(a.status)) {
        const declined = await transition(ctx.db, a.id, { from: OPEN_STATUSES, to: "declined", requireAssignee: user.id, now });
        if (!declined) return void (await answer("assignNotActual"));
        await answer();
        await cancelAssignmentJobs(ctx.db, a.id);
        await refreshMessages(ctx, declined, home);
        await notifyMember(
          ctx,
          a.createdBy,
          (v) => t("assignDeclinedBy", v.locale, params(ctx, declined, home, v)),
          (v) => declinedButtons(a.id, v.locale),
        );
        return;
      }
      if (a.assigneeUserId === null && a.status === "pending") {
        // «Кто-то должен»: один не может — остальные ещё могут; не смог никто — сказать автору
        await markOfferAnswer(ctx.db, a.id, user.id, "declined");
        await answer();
        const offers = (await assignmentMessages(ctx.db, a.id)).filter((m) => m.role === "offer");
        for (const m of offers.filter((x) => x.userId === user.id)) {
          const view = offerMarkup(ctx, a, home, user.id, await viewerOf(ctx, user.id), "declined");
          await ctx.telegram.editMessageText(m.chatId, m.messageId, view.text, view.markup);
        }
        if (offers.every((m) => m.answer === "declined" || m.userId === user.id)) {
          const nobody = await transition(ctx.db, a.id, { from: ["pending"], to: "declined", now });
          if (nobody) {
            await cancelAssignmentJobs(ctx.db, a.id);
            await refreshMessages(ctx, nobody, home);
            await notifyMember(
              ctx,
              a.createdBy,
              (v) => t("assignNobody", v.locale, params(ctx, nobody, home, v)),
              (v) => declinedButtons(a.id, v.locale),
            );
          }
        }
        return;
      }
      return void (await answer(a.assigneeUserId && a.assigneeUserId !== user.id ? "assignNotYours" : "assignNotActual"));
    }
    case "done": {
      if (a.assigneeUserId !== user.id) return void (await answer("assignNotYours"));
      const done = await transition(ctx.db, a.id, { from: [...OPEN_STATUSES, "expired"], to: "done", requireAssignee: user.id, now });
      if (!done) return void (await answer(a.status === "done" ? "alreadyDone" : "assignNotActual"));
      await answer();
      await cancelAssignmentJobs(ctx.db, a.id);
      await refreshMessages(ctx, done, home);
      if (!isAuthor) await notifyMember(ctx, a.createdBy, (v) => t("assignDoneBy", v.locale, params(ctx, done, home, v)));
      return;
    }
    case "cancel": {
      if (!isAuthor) return void (await answer("assignAuthorOnly"));
      const cancelled = await transition(ctx.db, a.id, { from: [...OPEN_STATUSES, "declined"], to: "cancelled", now });
      if (!cancelled) return void (await answer("assignNotActual"));
      await answer();
      await cancelAssignmentJobs(ctx.db, a.id);
      await refreshMessages(ctx, cancelled, home);
      // Исполнителю — отдельным сообщением «Отменено» (US-91), чтобы не держал дело в голове
      if (cancelled.assigneeUserId && cancelled.assigneeUserId !== user.id) {
        await notifyMember(ctx, cancelled.assigneeUserId, (v) => t("assignCancelledAssignee", v.locale, params(ctx, cancelled, home, v)));
      }
      return;
    }
    case "self": {
      if (!isAuthor) return void (await answer("assignAuthorOnly"));
      const mine = await transition(ctx.db, a.id, { from: ["declined", "pending"], to: "accepted", assignee: user.id, now });
      if (!mine) return void (await answer("assignNotActual"));
      await answer();
      await reschedule(ctx, mine, user.home_tz);
      if (mine.event) await setEventFamily(ctx.db, mine.event, { responsibleUserId: user.id });
      await refreshMessages(ctx, mine, home, pressed);
      await editPressed(t("assignOnYou", user.locale, params(ctx, mine, home, user)), doneButtons(a.id, user.locale));
      if (pressed) await addAssignmentMessage(ctx.db, a.id, { chatId: pressed.chatId, messageId: pressed.messageId, userId: user.id, role: "offer" });
      return;
    }
    case "other": {
      if (!isAuthor) return void (await answer("assignAuthorOnly"));
      if (a.status !== "declined" && a.status !== "pending") return void (await answer("assignNotActual"));
      await answer();
      const others = home.members.filter((m) => m.userId !== user.id && m.userId !== a.assigneeUserId);
      await editPressed(t("assignPickOther", user.locale, { title: a.title }), [
        ...others.map((m) => [{ text: m.displayName || "—", callback_data: assignCallback(a.id, "to", m.userId) }]),
        [{ text: t("assignAllButton", user.locale), callback_data: assignCallback(a.id, "all") }],
      ]);
      return;
    }
    case "to":
    case "all": {
      if (!isAuthor) return void (await answer("assignAuthorOnly"));
      const target = parsed.act === "to" ? home.members.find((m) => m.userId === parsed.arg && m.userId !== user.id)?.userId : null;
      if (parsed.act === "to" && !target) return void (await answer("assignNotActual"));
      const again = await transition(ctx.db, a.id, { from: ["declined", "pending"], to: "pending", assignee: target ?? null, now });
      if (!again) return void (await answer("assignNotActual"));
      await answer();
      await clearOfferAnswers(ctx.db, a.id);
      await reschedule(ctx, again, user.home_tz);
      if (again.event) await setEventFamily(ctx.db, again.event, { responsibleUserId: target ?? null });
      await editPressed(t(target ? "assignSent" : "assignSentAll", user.locale));
      await refreshMessages(ctx, again, home, pressed);
      await sendOffers(ctx, again, home);
      return;
    }
  }
}

// --- «Мои дела» --------------------------------------------------------------------------

/** Период из «что на мне завтра» — дни [from, to]; нет периода — null. */
function periodOf(text: string, now: number, tz: string): { from: number; to: number } | null {
  const range = extractDateSpans(text, formatMoment(utcToLocal(now, tz)), tz, "range").range;
  if (!range) return null;
  const v = parseDateFragment({ text: range, kind: "range", now: formatMoment(utcToLocal(now, tz)), tz });
  const day = (s: string) => parseLocal(`${s.slice(0, 10)}T00:00`).day;
  if ("date" in v) {
    const d = day(typeof v.date === "string" ? v.date : v.date.date);
    return { from: d, to: d };
  }
  if ("datetime" in v) return { from: day(v.datetime), to: day(v.datetime) };
  if ("range" in v) {
    const to = parseLocal(v.range.to.includes("T") ? v.range.to : `${v.range.to}T00:00`);
    return { from: day(v.range.from), to: v.range.to.includes("T") && to.minutes === 0 ? to.day - 1 : to.day };
  }
  return null;
}

/** «Мои дела», «что на мне завтра» (US-91): открытые поручения участнику и «кто-то должен», которые можно взять. */
export async function listAssignments(ctx: AppContext, user: User, chatId: number, text: string): Promise<void> {
  const home = await loadHome(ctx.db, user.id);
  const locale = user.locale;
  if (!home) return void (await ctx.telegram.sendMessage(chatId, t("assignNotInHome", locale)));
  const now = ctx.clock.now();
  const tz = user.home_tz;
  const period = periodOf(text, now, tz);
  const inPeriod = (a: Assignment) => {
    if (!period) return true;
    if (a.dueAt === null) return false;
    const d = utcToLocal(a.dueAt, tz).day;
    return d >= period.from && d <= period.to;
  };
  const all = (await openAssignmentsFor(ctx.db, user.id, home.household.id)).filter(inPeriod);
  const line = (a: Assignment) => {
    const waiting = a.status === "pending" && a.assigneeUserId ? ` · ${t("assignListWaiting", locale)}` : "";
    const kid = a.forDependentId ? home.dependents.find((d) => d.id === a.forDependentId) : undefined;
    return `• ${whenOfAssignment(a, now, tz, locale)} — ${a.title}${kid && !a.title.includes(kid.name) ? ` (${kid.name})` : ""}${waiting}`;
  };
  const mine = all.filter((a) => a.assigneeUserId === user.id);
  const open = all.filter((a) => a.assigneeUserId === null);
  const today = utcToLocal(now, tz).day;
  const periodLabel = period
    ? period.from === today
      ? t("assignDayToday", locale)
      : period.from === today + 1 && period.to === period.from
        ? t("assignDayTomorrow", locale)
        : period.from === period.to
          ? dateLabel(period.from, today, locale)
          : `${dateLabel(period.from, today, locale)} — ${dateLabel(period.to, today, locale)}`
    : "";
  if (mine.length === 0 && open.length === 0) {
    await ctx.telegram.sendMessage(chatId, period ? t("assignListEmptyPeriod", locale, { period: periodLabel }) : t("assignListEmpty", locale));
    return;
  }
  const parts = [
    ...(mine.length
      ? [[period ? t("assignListTitlePeriod", locale, { period: periodLabel }) : t("assignListTitle", locale), ...mine.map(line)].join("\n")]
      : []),
    ...(open.length ? [[t("assignListOpen", locale), ...open.map(line)].join("\n")] : []),
  ];
  // Кнопки «Беру» — у ждущих ответа (свои и «кто-то должен»), не больше 5 (длинные клавиатуры неудобны)
  const actionable = [...mine.filter((a) => a.status === "pending"), ...open].slice(0, 5);
  const rows = actionable.map((a) => [{ text: `${t("assignTakeButton", locale)}: ${a.title}`.slice(0, 60), callback_data: assignCallback(a.id, "take") }]);
  await ctx.telegram.sendMessage(chatId, parts.join("\n\n"), { inline_keyboard: rows });
}

// --- Перенос связанного события -----------------------------------------------------------------

/**
 * Событие перенесли на deltaMs (через бота — modify-event.ts; в Google мимо бота — синхронизация, sync/engine.ts):
 * срок поручений сдвигается, напоминания — заново, исполнителю — «Время изменилось». actorUserId — кто перенёс
 * (ему не сообщаем); null — неизвестно (изменение в Google напрямую).
 */
export async function shiftAssignmentsForEvent(ctx: AppContext, ref: EventRef, deltaMs: number, actorUserId: string | null): Promise<void> {
  if (deltaMs === 0) return;
  await shiftAssignments(ctx, await openAssignmentsForEvent(ctx.db, ref), deltaMs, actorUserId);
}

/** Перенос, найденный синхронизацией (US-72): событие календаря провайдера, без ссылки на календарь автора. */
export async function shiftAssignmentsForProviderEvent(
  ctx: AppContext,
  pcid: string,
  eventId: string,
  deltaMs: number,
  actorUserId: string | null,
): Promise<void> {
  if (deltaMs === 0) return;
  await shiftAssignments(ctx, await openAssignmentsForProviderEvent(ctx.db, pcid, eventId), deltaMs, actorUserId);
}

async function shiftAssignments(ctx: AppContext, linked: Assignment[], deltaMs: number, actorUserId: string | null): Promise<void> {
  const now = ctx.clock.now();
  for (const a of linked) {
    if (a.dueAt === null) continue;
    const moved: Assignment = { ...a, dueAt: a.dueAt + deltaMs };
    await setAssignmentDue(ctx.db, a.id, moved.dueAt!, now);
    const home = await homeById(ctx.db, a.householdId);
    if (!home) continue;
    const tz = (await viewerOf(ctx, a.assigneeUserId ?? a.createdBy)).home_tz;
    await reschedule(ctx, moved, tz);
    await refreshMessages(ctx, moved, home);
    if (a.assigneeUserId && a.assigneeUserId !== actorUserId) {
      await notifyMember(ctx, a.assigneeUserId, (v) => t("assignMoved", v.locale, params(ctx, moved, home, v)));
    }
  }
}

/**
 * Связанное событие удалено (через бота — delete-event.ts; в Google — синхронизация): открытые поручения отменяются,
 * исполнителю — «Отменено» (кроме того, кто удалил). Отмена удаления не возвращает поручение (удаление не отменяется, US-61).
 */
export async function cancelAssignmentsForEvent(ctx: AppContext, ref: EventRef, actorUserId: string | null): Promise<void> {
  await cancelAssignments(ctx, await openAssignmentsForEvent(ctx.db, ref), actorUserId);
}

export async function cancelAssignmentsForProviderEvent(ctx: AppContext, pcid: string, eventId: string, actorUserId: string | null): Promise<void> {
  await cancelAssignments(ctx, await openAssignmentsForProviderEvent(ctx.db, pcid, eventId), actorUserId);
}

async function cancelAssignments(ctx: AppContext, linked: Assignment[], actorUserId: string | null): Promise<void> {
  for (const a of linked) {
    const cancelled = await transition(ctx.db, a.id, { from: [...OPEN_STATUSES, "declined"], to: "cancelled", now: ctx.clock.now() });
    if (!cancelled) continue;
    await cancelAssignmentJobs(ctx.db, a.id);
    const home = await homeById(ctx.db, a.householdId);
    if (!home) continue;
    await refreshMessages(ctx, cancelled, home);
    if (cancelled.assigneeUserId && cancelled.assigneeUserId !== actorUserId) {
      await notifyMember(ctx, cancelled.assigneeUserId, (v) => t("assignCancelledAssignee", v.locale, params(ctx, cancelled, home, v)));
    }
  }
}
