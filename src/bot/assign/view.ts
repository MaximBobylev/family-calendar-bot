// Вид поручений (US-91): подписи срока, тело карточки и сообщений, кнопки «Беру / Не могу / Сделано».
// callback_data поручений — «as:<id>:<действие>[:<аргумент>]»: не карточка pending_actions — нажимает исполнитель (или
// любой взрослый дома в группе), а не автор команды.

import type { Assignment } from "../../db/assignments";
import { utcToLocal } from "../../dates/calendar";
import type { InlineKeyboardButton } from "../../telegram/types";
import { dateLabel, hhmm } from "../format";
import { t } from "../messages";
import type { Home } from "./family";
import { memberName } from "./family";
import { planAssignmentJobs } from "./logic";

export type AssignAct = "take" | "decline" | "done" | "cancel" | "self" | "other" | "to" | "all";

export const assignCallback = (id: string, act: AssignAct, arg?: string) => `as:${id}:${act}${arg ? `:${arg}` : ""}`;

export function parseAssignCallback(data: string | undefined): { id: string; act: AssignAct; arg?: string } | null {
  const m = /^as:([0-9a-f]{16}):(take|decline|done|cancel|self|other|to|all)(?::([\w-]{1,40}))?$/.exec(data ?? "");
  return m ? { id: m[1]!, act: m[2] as AssignAct, ...(m[3] ? { arg: m[3] } : {}) } : null;
}

export const isAssignCallback = (data: string | undefined) => !!data?.startsWith("as:");

/** «сегодня в 17:00», «завтра», «сб, 10 октября в 10:00», «без срока». */
export function dueLabel(dueAt: number | null, hasTime: boolean, now: number, tz: string, locale: string): string {
  if (dueAt === null) return t("assignNoDue", locale);
  const local = utcToLocal(dueAt, tz);
  const today = utcToLocal(now, tz).day;
  const day =
    local.day === today ? t("assignDayToday", locale) : local.day === today + 1 ? t("assignDayTomorrow", locale) : dateLabel(local.day, today, locale);
  return hasTime ? t("assignAt", locale, { day, time: hhmm(local.minutes) }) : day;
}

/** Поля поручения, нужные для показа (и черновик карточки, и строка assignments). */
export type AssignView = Pick<Assignment, "title" | "assigneeUserId" | "createdBy" | "dueAt" | "dueHasTime" | "forDependentId" | "eventLabel" | "eventStartAt">;

export const whenOfAssignment = (a: AssignView, now: number, tz: string, locale: string) => dueLabel(a.dueAt, a.dueHasTime, now, tz, locale);

/** Строки деталей: кому, для кого, событие, автор (в деталях, не в заголовке — US-91 общие правила). */
/** Как показывать: кому, от кого; now и tz — пояс получателя для времени связанного события. */
export interface DetailOpts {
  to?: boolean;
  from?: boolean;
  now: number;
  tz: string;
}

/** «Плавание Вани, сб, 10 октября 12:00» — в поясе получателя, по текущему времени события (QA-03/04/05). */
function eventLine(a: AssignView, now: number, tz: string, locale: string): string | null {
  if (!a.eventLabel) return null;
  if (a.eventStartAt === null) return a.eventLabel;
  const start = utcToLocal(a.eventStartAt, tz);
  return `${a.eventLabel}, ${dateLabel(start.day, utcToLocal(now, tz).day, locale)} ${hhmm(start.minutes)}`;
}

export function detailLines(a: AssignView, home: Home, locale: string, o: DetailOpts): string[] {
  const lines: string[] = [];
  if (o.to) {
    if (a.assigneeUserId) lines.push(t("assignTo", locale, { name: memberName(home, a.assigneeUserId) }));
    else
      lines.push(
        t("assignToAll", locale, {
          list: home.members
            .filter((m) => m.userId !== a.createdBy)
            .map((m) => m.displayName)
            .join(", "),
        }),
      );
  }
  const kid = a.forDependentId ? home.dependents.find((d) => d.id === a.forDependentId) : undefined;
  if (kid) lines.push(t("assignForWhom", locale, { name: kid.name }));
  const event = eventLine(a, o.now, o.tz, locale);
  if (event) lines.push(t("assignEvent", locale, { event }));
  if (o.from) lines.push(t("assignFrom", locale, { name: memberName(home, a.createdBy) }));
  return lines;
}

/** «🔔 Напомню: за день, за 3 ч (если нет ответа), за час; если ответа так и не будет — скажу вам». */
export function remindersLine(a: AssignView, now: number, tz: string, locale: string): string | null {
  if (a.dueAt === null) return null;
  const plan = planAssignmentJobs({ dueAt: a.dueAt, hasTime: a.dueHasTime, now, tz, named: a.assigneeUserId !== null });
  const labels = plan.flatMap((p) =>
    p.what === "day"
      ? [t("assignRemindDay", locale)]
      : p.what === "ask"
        ? [t("assignRemindAsk", locale)]
        : p.what === "hour"
          ? [t("assignRemindHour", locale)]
          : p.what === "morning"
            ? [t("assignRemindMorning", locale)]
            : [],
  );
  const escalates = plan.some((p) => p.what === "escalate");
  if (!labels.length && !escalates) return null;
  return t("assignReminders", locale, { list: [labels.join(", "), escalates ? t("assignEscalateNote", locale) : ""].filter(Boolean).join("; ") });
}

/** Тело: «📌 Забрать Машу из школы — сегодня в 17:00» + детали. */
export function assignmentText(header: string, a: AssignView, home: Home, locale: string, o: DetailOpts): string {
  return [header, ...detailLines(a, home, locale, o)].join("\n");
}

export const offerButtons = (id: string, locale: string): InlineKeyboardButton[][] => [
  [
    { text: t("assignTakeButton", locale), callback_data: assignCallback(id, "take") },
    { text: t("assignDeclineButton", locale), callback_data: assignCallback(id, "decline") },
  ],
];

export const doneButtons = (id: string, locale: string): InlineKeyboardButton[][] => [
  [{ text: t("assignDoneButton", locale), callback_data: assignCallback(id, "done") }],
];

export const declinedButtons = (id: string, locale: string): InlineKeyboardButton[][] => [
  [
    { text: t("assignSelfButton", locale), callback_data: assignCallback(id, "self") },
    { text: t("assignOtherButton", locale), callback_data: assignCallback(id, "other") },
  ],
];
