// Только сценарий с I/O; черновик → варианты — create-logic.ts, текст карточки — create-view.ts.

import type { CalendarInfo, CalendarProvider } from "../calendar/model";
import { formatDate, localToUtc, minutesBetween, utcToLocal } from "../dates/calendar";
import {
  AWAIT_TTL_MS,
  attachMessage,
  createPendingAction,
  getOpenCard,
  mergeDialogState,
  type PendingAction,
  updateOpenCardPayload,
} from "../db/conversations";
import { DEFAULT_DURATION_MIN } from "../db/settings";
import { type Feature, recordFeature } from "../db/features";
import { findUserById, type User } from "../db/users";
import type { TgCallbackQuery } from "../telegram/types";
import { toRRule } from "../dates/rrule";
import type { AppContext } from "./context";
import {
  type CalendarResolution,
  type CreateCardPayload,
  type CreateDraft,
  type CreateOption,
  isBirthdayOption,
  namedByAlias,
  resolveCalendar,
  resolveDraft,
  type TitleQuestionPayload,
} from "./create-logic";
import { cardBody, createCard } from "./create-view";
import { dateFixOnCancelled, dateFixOnCreated } from "./date-fix";
import { dateLabel, escapeHtml, hhmm } from "./format";
import { familyCardLines, notifyResponsible, saveEventFamily } from "./assign/family";
import { creatorNote, noteCreator } from "./household/scope";
import { attachUndoMessage, recordUndo } from "./undo";
import { t } from "./messages";
import { askQueue } from "./multi-event";
import type { MultiItem } from "./multi-logic";
import { notDoneLines } from "./multi-view";

export { type CreateCardPayload, type CreateDraft, draftFromIntent, type TitleQuestionPayload } from "./create-logic";

export const CREATE_CARD = "create";
export const TITLE_QUESTION = "title";

export interface CreateArgs {
  user: User;
  chatId: number;
  conversationId: string;
  draft: CreateDraft;
  // От какого момента считать «завтра»: дата пересланного сообщения (US-65); нет — сейчас
  refNow?: number;
  notDone?: string[];
  next?: MultiItem[];
}

export async function startCreate(ctx: AppContext, provider: CalendarProvider, a: CreateArgs): Promise<void> {
  const { user, chatId } = a;
  const locale = user.locale;
  const tz = user.tz;
  const now = utcToLocal(ctx.clock.now(), tz);

  const calendars = await provider.calendars();
  const cal = resolveCalendar(calendars, a.draft.calendar);
  if ("error" in cal) {
    await ctx.telegram.sendMessage(chatId, calendarErrorText(cal, calendars, locale));
    return;
  }

  let res = resolveDraft(a.draft, a.refNow ? utcToLocal(a.refNow, tz) : now, tz, cal, locale, user.settings.durationMin ?? DEFAULT_DURATION_MIN);
  // «Завтра» от даты пересланного сообщения уже прошло (US-65) — как «это время уже прошло»
  if (a.refNow && res.kind === "options" && res.options.every((o) => (o.start ? minutesBetween(o.start, now) <= 0 : o.endDay < now.day)))
    res = { kind: "ask", question: "inPast", keepStart: false };
  if (res.kind === "reply") {
    await ctx.telegram.sendMessage(chatId, res.text);
    return;
  }
  if (res.kind === "ask") {
    // Второе мнение LLM о дате — только для первой карточки: ответ на вопрос дополняет наш кусок
    // Вопрос о незнакомом поясе — один раз: ответ — уже время по своему поясу
    // Структура LLM, по которой спросили время, уже в startText словами («02.11.2026») — ответ дополнит её
    const { altStartText: _alt, altWhen: _when, llmFirst: _first, unknownZone: _zone, ...rest } = a.draft;
    const draft = res.keepStart ? { ...rest, ...(res.startText ? { startText: res.startText } : {}) } : { ...rest, startText: undefined };
    await mergeDialogState(
      ctx.db,
      a.conversationId,
      user.id,
      { awaiting: { kind: "create_time", draft, expiresAt: ctx.clock.now() + AWAIT_TTL_MS, ...(a.next?.length ? { next: a.next } : {}) } },
      ctx.clock.now(),
    );
    await ctx.telegram.sendMessage(chatId, t(res.question, locale, { zone: a.draft.unknownZone ?? "" }));
    return;
  }

  const showCalendar = calendars.filter((c) => c.writable).length > 1;
  const overlaps = res.options.length === 1 ? await findOverlaps(provider, res.options[0]!, calendars, locale) : [];
  const by = await creatorNote(ctx, user.id, "homeCreatedBy", locale);
  const fam = familyCardLines(a.draft.family, locale);
  const tzNote = res.options.length === 1 ? await homeTzNote(ctx, res.options[0]!, locale) : "";
  const notDone = notDoneLines(a.notDone, locale);
  const birthday = res.options.length === 1 && isBirthdayOption(res.options[0]!);
  const render = (yearly?: boolean) => `${createCard(res.options, "", now.day, locale, showCalendar, overlaps, yearly).text}${tzNote}${fam}${by}${notDone}`;
  const actionId = await createPendingAction(ctx.db, {
    conversationId: a.conversationId,
    userId: user.id,
    kind: CREATE_CARD,
    payload: {
      chatId,
      options: res.options,
      ...(namedByAlias(cal, a.draft.calendar) ? { viaAlias: true } : {}),
      ...(a.draft.family ? { family: a.draft.family } : {}),
      ...(a.draft.dateCheck ? { dateCheck: a.draft.dateCheck } : {}),
      ...(a.notDone?.length ? { notDone: a.notDone } : {}),
      ...(a.next?.length ? { next: a.next } : {}),
      ...(birthday ? { yearly: true, yearlyTexts: [render(true), render(false)] as [string, string] } : {}),
    } satisfies CreateCardPayload,
    now: ctx.clock.now(),
  });
  const { buttons } = createCard(res.options, actionId, now.day, locale, showCalendar, overlaps, birthday ? true : undefined);
  const sent = await ctx.telegram.sendMessage(chatId, render(birthday ? true : undefined), { inline_keyboard: buttons }, { html: true });
  await attachMessage(ctx.db, actionId, sent.message_id);
}

export function calendarErrorText(cal: Exclude<CalendarResolution, CalendarInfo>, calendars: CalendarInfo[], locale: string): string {
  if (cal.error === "noWritable") return t("noWritableCalendar", locale);
  if (cal.error === "readOnly") return t("calendarReadOnly", locale, { name: cal.name });
  const list = calendars
    .filter((c) => c.writable)
    .map((c) => `«${c.title}»`)
    .join(", ");
  return t("calendarNotFound", locale, { name: cal.name, list });
}

async function findOverlaps(provider: CalendarProvider, o: CreateOption, calendars: CalendarInfo[], locale: string): Promise<string[]> {
  if (o.allDay) return [];
  const relevant = new Set([o.calendarId, calendars.find((c) => c.isDefault)?.id]);
  const { events } = await provider.listEvents(localToUtc(o.start!, o.tz), localToUtc(o.end!, o.tz), o.tz);
  return events
    .filter((e) => !e.allDay && !e.free && relevant.has(e.ref.calendarId))
    .map((e) => {
      const otherDay = e.start!.day !== o.start!.day ? ` (${dateLabel(e.start!.day, o.start!.day, locale)})` : "";
      return `${hhmm(e.start!.minutes)}–${hhmm(e.end!.minutes)}${otherDay} ${escapeHtml(e.title)}`;
    });
}

// Не заданы в настройках — не передаём: Google поставит свои по умолчанию (для «весь день» — без напоминаний)
export function remindersFor(user: User, allDay: boolean): { reminders?: number[] } {
  const r = allDay ? (user.settings.allDayReminders ?? []) : user.settings.reminders;
  return r ? { reminders: r } : {};
}

const YEARLY_RULE = toRRule({ freq: "yearly" }, { day: 0, minutes: 0 }, "UTC", true);

/** «🔁 Каждый год: да / нет» у дня рождения (US-31, US-62) — без захвата карточки; true — нажатие обработано здесь. */
export async function pressCreateYearly(ctx: AppContext, user: User, cq: TgCallbackQuery, actionId: string, choice: string): Promise<boolean> {
  if (choice !== "y") return false;
  const card = await getOpenCard<CreateCardPayload>(ctx.db, actionId, user.id, ctx.clock.now());
  if (!card || card.action.kind !== CREATE_CARD || card.action.payload.yearly === undefined || !card.action.payload.yearlyTexts) return false;
  const p = card.action.payload;
  const next: CreateCardPayload = { ...p, yearly: !p.yearly };
  const ok = await updateOpenCardPayload(ctx.db, actionId, user.id, ctx.clock.now(), card.json, JSON.stringify(next));
  await ctx.telegram.answerCallbackQuery(cq.id);
  if (ok && card.action.messageId) {
    const today = utcToLocal(ctx.clock.now(), user.tz).day;
    const { buttons } = createCard(p.options, actionId, today, user.locale, false, [], next.yearly);
    await ctx.telegram.editMessageText(p.chatId, card.action.messageId, p.yearlyTexts![next.yearly ? 0 : 1], { inline_keyboard: buttons }, { html: true });
  }
  return true;
}

export async function confirmCreate(
  ctx: AppContext,
  provider: CalendarProvider,
  user: User,
  action: PendingAction<CreateCardPayload>,
  choice: string,
): Promise<boolean> {
  const { chatId, options } = action.payload;
  const locale = user.locale;
  const today = utcToLocal(ctx.clock.now(), user.tz).day;

  const askNext = async () => {
    if (action.payload.next?.length) await askQueue(ctx, user, chatId, action.conversationId, action.payload.next, { more: true });
  };
  if (choice === "x") {
    if (action.messageId) await ctx.telegram.editMessageText(chatId, action.messageId, t("cancelled", locale));
    await dateFixOnCancelled(ctx, action, action.payload);
    await askNext();
    return false;
  }
  const o = options[Number(choice.slice(1))];
  if (!o) return false;

  const created = await provider.createEvent({
    idempotencyKey: `${action.id}${choice.slice(1)}`,
    calendarId: o.calendarId,
    title: o.title,
    tz: o.tz,
    allDay: o.allDay,
    startDay: o.startDay,
    endDay: o.endDay,
    ...(o.start ? { start: o.start } : {}),
    ...(o.end ? { end: o.end } : {}),
    ...(o.location ? { location: o.location } : {}),
    ...(o.description ? { description: o.description } : {}),
    ...(o.series ? { recurrence: [o.series.rrule] } : action.payload.yearly ? { recurrence: [YEARLY_RULE] } : {}),
    ...remindersFor(user, o.allDay),
  });

  // Не user.id: в группе нажать «Создать» может любой взрослый дома, а автор — тот, кто попросил (US-94)
  await noteCreator(ctx, created.ref, action.userId);
  await saveEventFamily(ctx, created.ref, action.payload.family);
  await notifyResponsible(ctx, action.payload.family, action.userId, o);
  const calendarsCount = (await provider.calendars()).filter((c) => c.writable).length;
  const body = cardBody(o, today, locale, calendarsCount > 1, action.payload.yearly);
  const undo = await recordUndo(ctx, {
    conversationId: action.conversationId,
    user,
    chatId,
    record: { kind: "create", ref: created.ref, ...(created.etag ? { etag: created.etag } : {}) },
    summary: body,
  });
  const row = [...(created.link ? [{ text: t("openInCalendar", locale), url: created.link }] : []), undo.button];
  if (action.messageId) {
    const by = await creatorNote(ctx, action.userId, "homeCreatedByDone", locale);
    const fam = familyCardLines(action.payload.family, locale);
    const tz = await homeTzNote(ctx, o, locale);
    await ctx.telegram.editMessageText(
      chatId,
      action.messageId,
      `${t("created", locale)}\n\n${body}${tz}${fam}${by}${notDoneLines(action.payload.notDone, locale)}`,
      { inline_keyboard: [row] },
      { html: true },
    );
    await attachUndoMessage(ctx.db, undo.undoId, Number(action.messageId));
  }
  await mergeDialogState(
    ctx.db,
    action.conversationId,
    user.id,
    { lastEvent: { ref: created.ref, at: ctx.clock.now() }, lastDay: { day: formatDate(o.startDay), at: ctx.clock.now() } },
    ctx.clock.now(),
  );
  await dateFixOnCreated(ctx, action, action.payload, Number(choice.slice(1)), created.ref);
  const features: Feature[] = [
    "create",
    ...(o.series || action.payload.yearly ? ["recurring" as const] : []),
    ...(action.payload.viaAlias ? ["alias" as const] : []),
  ];
  await recordFeature(ctx.db, user.id, features, ctx.clock.now());

  // Ответом считается только reply на этот вопрос (US-30)
  if (!o.titleGiven) {
    const qId = await createPendingAction(ctx.db, {
      conversationId: action.conversationId,
      userId: user.id,
      kind: TITLE_QUESTION,
      payload: { ref: created.ref, title: o.title } satisfies TitleQuestionPayload,
      now: ctx.clock.now(),
    });
    const q = await ctx.telegram.sendMessage(chatId, t("askTitle", locale), { force_reply: true });
    await attachMessage(ctx.db, qId, q.message_id);
  }
  await askNext();
  return true;
}

// Решение владельца (QA-09): в календарях дома время считаем в поясе автора, как он сказал, а пояс дома (владельца) — подсказкой
async function homeTzNote(ctx: AppContext, o: CreateOption, locale: string): Promise<string> {
  if (!ctx.calendarScope || o.allDay || !o.start || o.series) return "";
  const owner = await findUserById(ctx.db, ctx.calendarScope.ownerUserId);
  if (!owner || owner.tz === o.tz) return "";
  const home = utcToLocal(localToUtc(o.start, o.tz), owner.tz);
  return `\n${t("createHomeTzNote", locale, { time: hhmm(o.start.minutes), tz: o.tz, homeTime: hhmm(home.minutes), homeTz: owner.tz })}`;
}
