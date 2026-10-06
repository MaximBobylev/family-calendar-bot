// US-30 / US-31: создание события. Карточка-подтверждение (осторожный режим), варианты кнопками для
// неоднозначных дат, вопрос «во сколько?», предупреждение о пересечениях, вопрос о названии.
// US-32: серии. Здесь — сценарий (I/O); черновик → варианты — create-logic.ts, карточка — create-view.ts.

import type { CalendarInfo, CalendarProvider } from "../calendar/model";
import { localToUtc, utcToLocal } from "../dates/calendar";
import { attachMessage, createPendingAction, mergeDialogState, type PendingAction } from "../db/conversations";
import { DEFAULT_DURATION_MIN } from "../db/settings";
import type { User } from "../db/users";
import type { AppContext } from "./context";
import { type CreateCardPayload, type CreateDraft, type CreateOption, resolveCalendar, resolveDraft, type TitleQuestionPayload } from "./create-logic";
import { cardBody, createCard } from "./create-view";
import { dateLabel, escapeHtml, hhmm } from "./format";
import { attachUndoMessage, recordUndo } from "./undo";
import { t } from "./messages";

export { type CreateCardPayload, type CreateDraft, draftFromIntent, type TitleQuestionPayload } from "./create-logic";

export const CREATE_CARD = "create";
export const TITLE_QUESTION = "title";
const AWAIT_TTL_MS = 15 * 60 * 1000;

// --- Сценарий --------------------------------------------------------------

export interface CreateArgs {
  user: User;
  chatId: number;
  conversationId: string;
  draft: CreateDraft;
}

export async function startCreate(ctx: AppContext, provider: CalendarProvider, a: CreateArgs): Promise<void> {
  const { user, chatId } = a;
  const locale = user.locale;
  const tz = user.home_tz;
  const now = utcToLocal(ctx.clock.now(), tz);

  const calendars = await provider.calendars();
  const cal = resolveCalendar(calendars, a.draft.calendar);
  if ("error" in cal) {
    const text =
      cal.error === "readOnly"
        ? t("calendarReadOnly", locale, { name: cal.name })
        : t("calendarNotFound", locale, {
            name: cal.name,
            list: calendars
              .filter((c) => c.writable)
              .map((c) => `«${c.title}»`)
              .join(", "),
          });
    await ctx.telegram.sendMessage(chatId, text);
    return;
  }

  const res = resolveDraft(a.draft, now, tz, cal, locale, user.settings.durationMin ?? DEFAULT_DURATION_MIN);
  if (res.kind === "reply") {
    await ctx.telegram.sendMessage(chatId, res.text);
    return;
  }
  if (res.kind === "ask") {
    // Ответ пользователя дополнит этот же черновик (US-12)
    const draft = res.keepStart ? a.draft : { ...a.draft, startText: undefined };
    await mergeDialogState(
      ctx.db,
      a.conversationId,
      user.id,
      { awaiting: { kind: "create_time", draft, expiresAt: ctx.clock.now() + AWAIT_TTL_MS } },
      ctx.clock.now(),
    );
    await ctx.telegram.sendMessage(chatId, t(res.question, locale));
    return;
  }

  const showCalendar = calendars.filter((c) => c.writable).length > 1;
  const actionId = await createPendingAction(ctx.db, {
    conversationId: a.conversationId,
    userId: user.id,
    kind: CREATE_CARD,
    payload: { chatId, options: res.options } satisfies CreateCardPayload,
    now: ctx.clock.now(),
  });

  // Пересечения — только для единственного варианта (US-30)
  const overlaps = res.options.length === 1 ? await findOverlaps(provider, res.options[0]!, calendars) : [];
  const { text, buttons } = createCard(res.options, actionId, now.day, locale, showCalendar, overlaps);
  const sent = await ctx.telegram.sendMessage(chatId, text, { inline_keyboard: buttons }, { html: true });
  await attachMessage(ctx.db, actionId, sent.message_id);
}

/** Пересечения с событиями в целевом календаре и календаре по умолчанию (US-30). */
async function findOverlaps(provider: CalendarProvider, o: CreateOption, calendars: CalendarInfo[]): Promise<string[]> {
  if (o.allDay) return [];
  const relevant = new Set([o.calendarId, calendars.find((c) => c.isDefault)?.id]);
  const { events } = await provider.listEvents(localToUtc(o.start!, o.tz), localToUtc(o.end!, o.tz), o.tz);
  return events
    .filter((e) => !e.allDay && !e.free && relevant.has(e.ref.calendarId))
    .map((e) => {
      // Пересечение, начавшееся в другой день, — с меткой дня
      const otherDay = e.start!.day !== o.start!.day ? ` (${dateLabel(e.start!.day, o.start!.day, "ru")})` : "";
      return `${hhmm(e.start!.minutes)}–${hhmm(e.end!.minutes)}${otherDay} ${escapeHtml(e.title)}`;
    });
}

/** Напоминания по умолчанию из настроек бота (US-04): нет — как в Google; для «весь день» — без напоминаний. */
function remindersFor(user: User, allDay: boolean): { reminders?: number[] } {
  const r = allDay ? (user.settings.allDayReminders ?? []) : user.settings.reminders;
  return r ? { reminders: r } : {};
}

/** Нажатие кнопки на карточке создания. Карточка уже «забрана» атомарно (claimPendingAction). */
export async function confirmCreate(
  ctx: AppContext,
  provider: CalendarProvider,
  user: User,
  action: PendingAction<CreateCardPayload>,
  choice: string,
): Promise<void> {
  const { chatId, options } = action.payload;
  const locale = user.locale;
  const today = utcToLocal(ctx.clock.now(), user.home_tz).day;

  if (choice === "x") {
    if (action.messageId) await ctx.telegram.editMessageText(chatId, action.messageId, t("cancelled", locale));
    return;
  }
  const o = options[Number(choice.slice(1))];
  if (!o) return;

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
    ...(o.series ? { recurrence: [o.series.rrule] } : {}),
    ...remindersFor(user, o.allDay),
  });

  const calendarsCount = (await provider.calendars()).filter((c) => c.writable).length;
  const body = cardBody(o, today, locale, calendarsCount > 1);
  const undo = await recordUndo(ctx, {
    conversationId: action.conversationId,
    user,
    chatId,
    record: { kind: "create", ref: created.ref, ...(created.etag ? { etag: created.etag } : {}) },
    summary: body,
  });
  const row = [...(created.link ? [{ text: t("openInCalendar", locale), url: created.link }] : []), undo.button];
  if (action.messageId) {
    await ctx.telegram.editMessageText(chatId, action.messageId, `${t("created", locale)}\n\n${body}`, { inline_keyboard: [row] }, { html: true });
    await attachUndoMessage(ctx.db, undo.undoId, Number(action.messageId));
  }
  await mergeDialogState(ctx.db, action.conversationId, user.id, { lastEvent: { ref: created.ref, at: ctx.clock.now() } }, ctx.clock.now());

  // Название не задано — спросить; ответом считается только reply на этот вопрос (US-30)
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
}
