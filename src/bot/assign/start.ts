// US-91: поручение — карточка автору (что, кому, когда, напоминания, событие) и после «Поручить» — предложение
// исполнителю (или всем взрослым для «кто-то должен») с кнопками «Беру / Не могу», задачи напоминаний и эскалации.
// Связь с событием: подходящее событие в календаре в день срока — само; нет — «Поручить + в календарь».

import { GoogleCalendarProvider } from "../../calendar/google-provider";
import { titleScore } from "../../calendar/match";
import type { CalendarEvent, CalendarProvider, EventRef } from "../../calendar/model";
import { formatMoment, localToUtc, parseLocal, utcToLocal } from "../../dates/calendar";
import { extractDateSpans } from "../../dates/extract";
import { parseDateFragment } from "../../dates";
import { hasGoogleAccount } from "../../db/accounts";
import { addAssignmentMessage, insertAssignment, scheduleAssignmentJobs } from "../../db/assignments";
import { attachMessage, createPendingAction, type PendingAction } from "../../db/conversations";
import { setEventFamily } from "../../db/event-meta";
import { addMemberAlias, householdCalendarIds, householdDefaultCalendar } from "../../db/households";
import { recordFeature } from "../../db/features";
import { DEFAULT_DURATION_MIN } from "../../db/settings";
import type { User } from "../../db/users";
import type { AssignTaskIntent, Intent } from "../../nlu/intents";
import type { AppContext } from "../context";
import { dateLabel } from "../format";
import { noteCreator } from "../household/scope";
import { callbackData } from "../keyboards";
import { t } from "../messages";
import { withCalendar } from "../with-calendar";
import { type Home, loadHome } from "./family";
import { findMentioned, matchNamed, parseAssignPhrase, planAssignmentJobs, roleAlias, taskTitle } from "./logic";
import { sendOffers, statusMarkup } from "./notify";
import { type AssignView, assignmentText, dueLabel, remindersLine } from "./view";

export const ASSIGN_CARD = "assign";

interface AssignDraft extends AssignView {
  event?: EventRef;
  /** Нет подходящего события, срок со временем — можно создать событие в этом календаре. */
  newEvent?: { calendarId: string; calendarTitle: string };
}

export interface AssignCardPayload {
  chatId: number;
  draft: AssignDraft;
}

/** Срок из фразы: момент (со временем) или день; «в прошлом» — отдельно. */
function resolveDue(whenText: string | undefined, now: number, tz: string): { dueAt: number; hasTime: boolean } | "past" | null {
  if (!whenText) return null;
  const parsed = parseDateFragment({ text: whenText, kind: "point", now: formatMoment(utcToLocal(now, tz)), tz });
  if ("error" in parsed) return parsed.error === "in_past" ? "past" : null;
  const v = "ambiguous" in parsed ? parsed.ambiguous[0]! : parsed;
  if ("datetime" in v) return { dueAt: localToUtc(parseLocal(v.datetime), tz), hasTime: true };
  if ("interval" in v) return { dueAt: localToUtc(parseLocal(v.interval.start), tz), hasTime: true };
  const day = "date" in v ? (typeof v.date === "string" ? v.date : v.date.date) : "range" in v ? v.range.from.slice(0, 10) : null;
  return day ? { dueAt: localToUtc(parseLocal(`${day}T00:00`), tz), hasTime: false } : null;
}

/** Провайдер календаря без сообщений об ошибках: поиск события для связи — необязательная часть карточки. */
async function quietProvider(ctx: AppContext, user: User): Promise<CalendarProvider | null> {
  const scope = ctx.calendarScope;
  if (scope && scope.calendarIds.length === 0) return null;
  if (!scope && !(await hasGoogleAccount(ctx.db, user.id))) return null;
  return new GoogleCalendarProvider(ctx.config, ctx.db, scope?.ownerUserId ?? user.id, ctx.clock, scope?.calendarIds, undefined, scope?.defaultCalendarId);
}

/**
 * Событие в день срока, к которому относится поручение: «отвезти Ваню на плавание» ~ «Плавание Вани»
 * (половина слов совпадает; со временем — не дальше 3 часов от срока).
 */
async function findEventToLink(
  provider: CalendarProvider,
  d: { title: string; dueAt: number; hasTime: boolean },
  tz: string,
  sharedIds: string[],
  homeDefault: string | null,
): Promise<{ event?: CalendarEvent; newEvent?: AssignDraft["newEvent"] }> {
  const day = utcToLocal(d.dueAt, tz).day;
  const { events } = await provider.listEvents(localToUtc({ day, minutes: 0 }, tz), localToUtc({ day: day + 1, minutes: 0 }, tz), tz);
  const near = (e: CalendarEvent) => !d.hasTime || (!!e.start && Math.abs(localToUtc(e.start, tz) - d.dueAt) <= 3 * 60 * 60 * 1000);
  const best = events
    .filter((e) => near(e))
    .map((e) => ({ e, score: titleScore(d.title, e.title) }))
    .filter((x) => x.score >= 0.5)
    .sort((a, b) => b.score - a.score)[0];
  if (best) return { event: best.e };
  if (!d.hasTime) return {};
  // Новое событие — в основной общий календарь дома (его видят все участники; личный календарь владельца — нет,
  // ревью R1 блокер 2), иначе — в календарь по умолчанию
  const writable = (await provider.calendars()).filter((c) => c.writable);
  const shared = writable.filter((c) => sharedIds.includes(c.id));
  const cal = shared.find((c) => c.id === homeDefault) ?? shared[0] ?? writable.find((c) => c.isDefault) ?? writable[0];
  return cal ? { newEvent: { calendarId: cal.id, calendarTitle: cal.title } } : {};
}

/** Связанное событие: со временем — название и момент начала (подпись — при показе, QA-03/04/05); весь день — готовая подпись. */
const eventLink = (e: CalendarEvent, tz: string, today: number, locale: string): { eventLabel: string; eventStartAt: number | null } =>
  e.start
    ? { eventLabel: e.title, eventStartAt: localToUtc(e.start, tz) }
    : { eventLabel: `${e.title}, ${dateLabel(e.startDay, today, locale)}`, eventStartAt: null };

/**
 * Поправка «это поручение» по тексту применима: LLM сама сказала assign_task, или в доме есть такой участник
 * («пусть Аня …») / дом есть («кто-то должен …»). Иначе «Пусть будет встреча в 15» — обычная команда.
 */
export async function assignmentApplies(ctx: AppContext, userId: string, override: Intent, llm: Intent): Promise<boolean> {
  if (override.name !== "assign_task" || llm.name === "assign_task") return true;
  const home = await loadHome(ctx.db, userId);
  if (!home) return false;
  return override.someone === true || (!!override.assignee && matchNamed(override.assignee, home.members).length > 0);
}

/** Выбор исполнителя, когда «{who}» не нашёлся (ревью R1 #3): кнопки участников; роль («муж») запоминается выбранному. */
export const ASSIGN_WHO_CARD = "assign_who";

export interface AssignWhoPayload {
  chatId: number;
  text: string;
  intent: AssignTaskIntent;
  /** Кандидаты по порядку кнопок m0, m1, … */
  members: string[];
  /** Другое имя, которое запомнить выбранному («муж»). */
  alias?: string;
}

async function askWho(
  ctx: AppContext,
  user: User,
  a: { chatId: number; conversationId: string; text: string; intent: AssignTaskIntent; who: string; home: Home; others: Home["members"] },
): Promise<void> {
  const locale = user.locale;
  const kid = matchNamed(a.who, a.home.dependents)[0];
  const alias = kid ? undefined : roleAlias(a.who);
  const id = await createPendingAction(ctx.db, {
    conversationId: a.conversationId,
    userId: user.id,
    kind: ASSIGN_WHO_CARD,
    payload: {
      chatId: a.chatId,
      text: a.text,
      intent: a.intent,
      members: a.others.map((m) => m.userId),
      ...(alias ? { alias } : {}),
    } satisfies AssignWhoPayload,
    now: ctx.clock.now(),
  });
  const text = kid
    ? t("assignWhoIsKid", locale, { name: kid.name })
    : t("assignWhoNotFound", locale, {
        who: a.who,
        list: a.others.map((m) => m.displayName).join(", "),
        remember: alias ? t("assignWhoRemember", locale, { alias }) : "",
      });
  const sent = await ctx.telegram.sendMessage(a.chatId, text, {
    inline_keyboard: [
      ...a.others.map((m, i) => [{ text: m.displayName || "—", callback_data: callbackData(id, `m${i}`) }]),
      [{ text: t("cancelButton", locale), callback_data: callbackData(id, "x") }],
    ],
  });
  await attachMessage(ctx.db, id, sent.message_id);
}

/** Нажали участника на «Кому поручить?»: запомнить роль и продолжить поручение с ним. */
export async function confirmWho(ctx: AppContext, user: User, action: PendingAction<AssignWhoPayload>, choice: string): Promise<void> {
  const p = action.payload;
  const locale = user.locale;
  const pick = /^m(\d+)$/.exec(choice);
  const userId = pick ? p.members[Number(pick[1])] : undefined;
  const home = userId ? await loadHome(ctx.db, user.id) : null;
  const member = home?.members.find((m) => m.userId === userId);
  if (!home || !member) {
    if (action.messageId) await ctx.telegram.editMessageText(p.chatId, action.messageId, t("cancelled", locale));
    return;
  }
  if (p.alias) {
    await addMemberAlias(ctx.db, home.household.id, member.userId, p.alias);
    if (action.messageId)
      await ctx.telegram.editMessageText(p.chatId, action.messageId, t("homeAliasLearned", locale, { alias: p.alias, name: member.displayName }));
  } else if (action.messageId) await ctx.telegram.editMessageText(p.chatId, action.messageId, `👤 ${member.displayName}`);
  await startAssign(ctx, user, p.chatId, action.conversationId, p.text, p.intent, member.userId);
}

/** «Напомни мужу забрать Машу из школы в 17» → карточка автору. forcedAssignee — выбран кнопкой (askWho). */
export async function startAssign(
  ctx: AppContext,
  user: User,
  chatId: number,
  conversationId: string,
  text: string,
  intent: AssignTaskIntent,
  forcedAssignee?: string,
): Promise<void> {
  const locale = user.locale;
  const tz = user.home_tz;
  const now = ctx.clock.now();
  const say = (s: string) => ctx.telegram.sendMessage(chatId, s);
  const home = await loadHome(ctx.db, user.id);
  if (!home) return void (await say(t("assignNotInHome", locale)));
  const others = home.members.filter((m) => m.userId !== user.id);
  if (others.length === 0) return void (await say(t("assignNoOthers", locale)));

  // Кому: по тексту (детерминированно), иначе — как поняла LLM; имена — по другим именам участников с падежами
  const phrase = parseAssignPhrase(text);
  const who = phrase && "assignee" in phrase ? phrase.assignee : intent.someone ? undefined : intent.assignee;
  let assigneeUserId: string | null = null;
  if (forcedAssignee) assigneeUserId = forcedAssignee;
  else if (who) {
    const found = matchNamed(who, home.members);
    if (found.length === 0) return void (await askWho(ctx, user, { chatId, conversationId, text, intent, who, home, others }));
    if (found.length > 1) return void (await say(t("assignWhoAmbiguous", locale, { who, list: found.map((m) => m.displayName).join(` ${t("or", locale)} `) })));
    if (found[0]!.userId === user.id) return void (await say(t("assignToSelf", locale)));
    assigneeUserId = found[0]!.userId;
  }

  // Срок — из текста детерминированно; фрагмент от LLM — запасной (ADR-0005 п.3)
  const body = phrase?.rest ?? text;
  const spans = extractDateSpans(body, formatMoment(utcToLocal(now, tz)), tz, "point");
  const due = resolveDue(spans.point ?? intent.when, now, tz);
  if (due === "past") return void (await say(t("assignInPast", locale)));
  const title = taskTitle(intent.task ?? body, [spans.point ?? "", intent.when ?? "", ...(who && intent.task ? [who] : [])]);
  if (!title) return void (await say(t("assignNoTask", locale)));
  const kid = findMentioned(title, home.dependents);

  const draft: AssignDraft = {
    title,
    assigneeUserId,
    createdBy: user.id,
    dueAt: due?.dueAt ?? null,
    dueHasTime: due?.hasTime ?? false,
    forDependentId: kid?.id ?? null,
    eventLabel: null,
    eventStartAt: null,
  };
  // Событие в календаре: подходящее — связать (и взять его время, если срок — только день); нет — предложить создать
  if (due) {
    try {
      const provider = await quietProvider(ctx, user);
      const link = provider
        ? await findEventToLink(
            provider,
            { title, ...due },
            tz,
            await householdCalendarIds(ctx.db, home.household.id),
            await householdDefaultCalendar(ctx.db, home.household.id),
          )
        : {};
      if (link.event) {
        draft.event = link.event.ref;
        Object.assign(draft, eventLink(link.event, tz, utcToLocal(now, tz).day, locale));
        if (!due.hasTime && link.event.start) {
          draft.dueAt = localToUtc(link.event.start, tz);
          draft.dueHasTime = true;
        }
      } else if (link.newEvent) draft.newEvent = link.newEvent;
    } catch (e) {
      console.warn("assign: event lookup failed", e instanceof Error ? e.message : e);
    }
  }

  const actionId = await createPendingAction(ctx.db, {
    conversationId,
    userId: user.id,
    kind: ASSIGN_CARD,
    payload: { chatId, draft } satisfies AssignCardPayload,
    now,
  });
  const sent = await ctx.telegram.sendMessage(chatId, cardText(draft, home, now, tz, locale), {
    inline_keyboard: [
      [
        { text: t("assignButton", locale), callback_data: callbackData(actionId, "ok") },
        ...(draft.newEvent ? [{ text: t("assignWithEventButton", locale), callback_data: callbackData(actionId, "cal") }] : []),
      ],
      [{ text: t("cancelButton", locale), callback_data: callbackData(actionId, "x") }],
    ],
  });
  await attachMessage(ctx.db, actionId, sent.message_id);
}

function cardText(d: AssignDraft, home: Home, now: number, tz: string, locale: string): string {
  const header = `${t("assignConfirm", locale)}\n\n${t(d.assigneeUserId ? "assignOffer" : "assignOfferSomeone", locale, { title: d.title, when: dueLabel(d.dueAt, d.dueHasTime, now, tz, locale) })}`;
  const lines = [assignmentText(header, d, home, locale, { to: true, now, tz })];
  if (d.newEvent) lines.push(t("assignEventNew", locale, { calendar: d.newEvent.calendarTitle }));
  const reminders = remindersLine(d, now, tz, locale);
  if (reminders) lines.push(reminders);
  return lines.join("\n");
}

/**
 * «Поручить» / «Поручить + в календарь» / «Отмена». Карточка уже забрана атомарно (callbacks.ts). В группе нажать может
 * любой взрослый дома — автор поручения всё равно автор команды. true — поручение создано.
 */
export async function confirmAssign(ctx: AppContext, user: User, action: PendingAction<AssignCardPayload>, choice: string): Promise<boolean> {
  const { chatId } = action.payload;
  const d = { ...action.payload.draft };
  const locale = user.locale;
  const now = ctx.clock.now();
  if (choice === "x") {
    if (action.messageId) await ctx.telegram.editMessageText(chatId, action.messageId, t("cancelled", locale));
    return false;
  }
  const home = await loadHome(ctx.db, user.id);
  if (!home) {
    if (action.messageId) await ctx.telegram.editMessageText(chatId, action.messageId, t("assignNotInHome", locale));
    return false;
  }
  // Создать событие в календаре (срок со временем): через Google автора или владельца дома
  if (choice === "cal" && d.newEvent && d.dueAt !== null) {
    const start = utcToLocal(d.dueAt, user.home_tz);
    const duration = user.settings.durationMin ?? DEFAULT_DURATION_MIN;
    let created: EventRef | undefined;
    const ok = await withCalendar(ctx, user, chatId, async (provider) => {
      const res = await provider.createEvent({
        idempotencyKey: `${action.id}cal`,
        calendarId: d.newEvent!.calendarId,
        title: d.title,
        tz: user.home_tz,
        allDay: false,
        startDay: start.day,
        endDay: start.day,
        start,
        end: utcToLocal(d.dueAt! + duration * 60_000, user.home_tz),
      });
      created = res.ref;
    });
    if (!ok || !created) return false;
    await noteCreator(ctx, created, action.userId);
    d.event = created;
    d.eventLabel = d.title;
    d.eventStartAt = d.dueAt;
  }

  const a = await insertAssignment(
    ctx.db,
    {
      householdId: home.household.id,
      title: d.title,
      assigneeUserId: d.assigneeUserId,
      createdBy: user.id,
      dueAt: d.dueAt,
      dueHasTime: d.dueHasTime,
      forDependentId: d.forDependentId,
      originChatId: chatId < 0 ? String(chatId) : null,
      event: d.event ?? null,
      eventLabel: d.eventLabel,
      eventStartAt: d.eventStartAt,
    },
    now,
  );
  // Связь с событием: у события появляется ответственный и «для кого» (US-91 → US-92)
  if (d.event) {
    await setEventFamily(ctx.db, d.event, {
      ...(d.assigneeUserId ? { responsibleUserId: d.assigneeUserId } : {}),
      ...(d.forDependentId ? { forDependentId: d.forDependentId } : {}),
    });
  }
  if (a.dueAt !== null)
    await scheduleAssignmentJobs(
      ctx.db,
      a.id,
      planAssignmentJobs({ dueAt: a.dueAt, hasTime: a.dueHasTime, now, tz: user.home_tz, named: a.assigneeUserId !== null }),
    );
  if (action.messageId) {
    const role = chatId < 0 ? "group" : "author";
    const status = await statusMarkup(ctx, a, home, user, role);
    await ctx.telegram.editMessageText(chatId, action.messageId, status.text, status.markup);
    await addAssignmentMessage(ctx.db, a.id, { chatId: String(chatId), messageId: Number(action.messageId), userId: user.id, role });
  }
  await sendOffers(ctx, a, home);
  await recordFeature(ctx.db, user.id, "assign", now);
  return true;
}
