// Сценарий карточки-списка (US-62, ADR-0008): показать, переключать без захвата карточки, создать с id на строку.
// Частичный сбой Google — карточка снова open с «Повторить»: те же id не дадут дублей, созданное не откатываем.

import { type CalendarProvider, ProviderUnavailable } from "../calendar/model";
import { formatDate, utcToLocal } from "../dates/calendar";
import { toRRule } from "../dates/rrule";
import {
  attachMessage,
  CONTEXT_TTL_MS,
  createPendingAction,
  getDialogState,
  getOpenCard,
  mergeDialogState,
  type PendingAction,
  reopenCard,
  setCardPayload,
  updateOpenCardPayload,
} from "../db/conversations";
import { type Feature, recordFeature } from "../db/features";
import { DEFAULT_DURATION_MIN } from "../db/settings";
import type { User } from "../db/users";
import { log } from "../log";
import type { CreateEventIntent } from "../nlu/intents";
import type { InlineKeyboardButton, TgCallbackQuery } from "../telegram/types";
import { familyHints, notifyResponsible, saveEventFamily } from "./assign/family";
import type { AppContext } from "./context";
import { calendarErrorText, remindersFor, startCreate } from "./create-event";
import { noteCreator } from "./household/scope";
import { callbackData } from "./keyboards";
import { t } from "./messages";
import {
  alignCalls,
  buildItems,
  doneOf,
  isCreated,
  isCreatePiece,
  MAX_FORWARD,
  MAX_OWN,
  MULTI_CARD,
  type MultiCardPayload,
  mainButton,
  toCreate,
  toggle,
} from "./multi-logic";
import type { Piece } from "./multi-split";
import { multiCardButtons, multiCardText, multiSummaryText } from "./multi-view";
import { attachUndoMessage, recordUndo } from "./undo";

export interface MultiArgs {
  user: User;
  chatId: number;
  conversationId: string;
  pieces: Piece[];
  calls: CreateEventIntent[];
  /** Пересланное: карточка пересланного (messageId) становится списком на месте. */
  forward?: { refNow?: number; from?: string; description: string; messageId?: number };
}

/** false — строк не осталось: вызывающий идёт прежним путём одного события. Одна строка — обычная карточка. */
export async function startMulti(ctx: AppContext, provider: CalendarProvider, a: MultiArgs): Promise<boolean> {
  const { user, chatId } = a;
  const locale = user.locale;
  const tz = user.tz;
  const nowMs = ctx.clock.now();
  const now = utcToLocal(nowMs, tz);
  const families = await Promise.all(a.pieces.map((p) => (isCreatePiece(p) ? familyHints(ctx, user.id, p.text) : { remove: [] })));
  let conversationDay: string | undefined;
  if (!a.forward) {
    const state = await getDialogState(ctx.db, a.conversationId, user.id);
    conversationDay = state.lastDay && nowMs - state.lastDay.at < CONTEXT_TTL_MS ? state.lastDay.day : undefined;
  }
  const calendars = await provider.calendars();
  const built = buildItems({
    pieces: a.pieces,
    calls: alignCalls(a.pieces, a.calls),
    families,
    now,
    ...(a.forward?.refNow ? { refNow: utcToLocal(a.forward.refNow, tz) } : {}),
    tz,
    locale,
    durationMin: user.settings.durationMin ?? DEFAULT_DURATION_MIN,
    calendars,
    ...(conversationDay ? { conversationDay } : {}),
    ...(a.forward ? { llmFirst: true, description: a.forward.description } : {}),
  });
  const reply = async (text: string) => {
    if (a.forward?.messageId) await ctx.telegram.editMessageText(chatId, a.forward.messageId, text);
    else await ctx.telegram.sendMessage(chatId, text);
  };
  if ("calendarError" in built) {
    await reply(calendarErrorText(built.calendarError, calendars, locale));
    return true;
  }
  const { items } = built;
  for (const b of items) {
    if (b.check)
      log("date_check", {
        source: a.forward ? "forward" : "message",
        llm: b.check.llm,
        agreement: b.check.agreement,
        multi: true,
        ...(b.check.contextDay ? { context_day: true } : {}),
      });
  }
  if (items.length === 0) return false;
  if (items.length === 1) {
    if (a.forward?.messageId) await ctx.telegram.editMessageText(chatId, a.forward.messageId, t("forwardEventStarted", locale));
    await startCreate(ctx, provider, {
      user,
      chatId,
      conversationId: a.conversationId,
      draft: items[0]!.draft,
      ...(a.forward?.refNow ? { refNow: a.forward.refNow } : {}),
    });
    return true;
  }
  const max = a.forward ? MAX_FORWARD : MAX_OWN;
  if (items.length > max) {
    await reply(t(a.forward ? "multiTooManyForward" : "multiTooManyOwn", locale, { n: String(items.length), max: String(max) }));
    return true;
  }
  if (!items.some((b) => b.item.option)) {
    if (a.forward) {
      if (a.forward.messageId) await ctx.telegram.editMessageText(chatId, a.forward.messageId, t("forwardEventStarted", locale));
      await startCreate(ctx, provider, {
        user,
        chatId,
        conversationId: a.conversationId,
        draft: items[0]!.draft,
        ...(a.forward.refNow ? { refNow: a.forward.refNow } : {}),
      });
    } else await ctx.telegram.sendMessage(chatId, t("oneAtATime", locale));
    return true;
  }

  const payload: MultiCardPayload = {
    chatId,
    items: items.map((b) => b.item),
    ...(items.some((b) => b.item.birthday) ? { yearly: true } : {}),
    ...(a.forward ? { forwardedFrom: a.forward.from ?? "" } : {}),
    ...(built.viaAlias ? { viaAlias: true } : {}),
    ...(calendars.filter((c) => c.writable).length > 1 ? { showCalendar: true } : {}),
  };
  const id = await createPendingAction(ctx.db, { conversationId: a.conversationId, userId: user.id, kind: MULTI_CARD, payload, now: nowMs });
  const text = multiCardText(payload, now.day, locale);
  const markup = { inline_keyboard: multiCardButtons(payload, id, locale) };
  if (a.forward?.messageId) {
    await ctx.telegram.editMessageText(chatId, a.forward.messageId, text, markup, { html: true });
    await attachMessage(ctx.db, id, a.forward.messageId);
  } else {
    const sent = await ctx.telegram.sendMessage(chatId, text, markup, { html: true });
    await attachMessage(ctx.db, id, sent.message_id);
  }
  return true;
}

const PRESS_ATTEMPTS = 3;

/** Переключатели и пустой выбор — без захвата карточки; true — нажатие обработано здесь. */
export async function pressMulti(ctx: AppContext, user: User, cq: TgCallbackQuery, actionId: string, choice: string): Promise<boolean> {
  if (!/^(t\d|y|c)$/.test(choice)) return false;
  for (let attempt = 0; attempt < PRESS_ATTEMPTS; attempt++) {
    const card = await getOpenCard<MultiCardPayload>(ctx.db, actionId, user.id, ctx.clock.now());
    if (!card || card.action.kind !== MULTI_CARD) return false;
    const p = card.action.payload;
    if (choice === "c") {
      if (mainButton(p).n > 0) return false;
      await ctx.telegram.answerCallbackQuery(cq.id, t("multiSelectOne", user.locale));
      return true;
    }
    const next = toggle(p, choice);
    if (!next) {
      await ctx.telegram.answerCallbackQuery(cq.id);
      return true;
    }
    if (!(await updateOpenCardPayload(ctx.db, actionId, user.id, ctx.clock.now(), card.json, JSON.stringify(next)))) continue;
    await ctx.telegram.answerCallbackQuery(cq.id);
    if (card.action.messageId) {
      const today = utcToLocal(ctx.clock.now(), user.tz).day;
      await ctx.telegram.editMessageText(
        p.chatId,
        card.action.messageId,
        multiCardText(next, today, user.locale),
        { inline_keyboard: multiCardButtons(next, actionId, user.locale) },
        { html: true },
      );
    }
    return true;
  }
  await ctx.telegram.answerCallbackQuery(cq.id);
  return true;
}

/** Два сбоя подряд — Google лежит: остальные строки без вызовов (лимит подзапросов Worker), их создаст «Повторить». */
const MAX_FAILURES_IN_ROW = 2;

export async function confirmMulti(
  ctx: AppContext,
  provider: CalendarProvider,
  user: User,
  action: PendingAction<MultiCardPayload>,
  choice: string,
): Promise<boolean> {
  const p = action.payload;
  const locale = user.locale;
  if (choice === "x") {
    if (action.messageId) await ctx.telegram.editMessageText(p.chatId, action.messageId, t("cancelled", locale));
    return false;
  }
  if (choice !== "c" && choice !== "r") return false;
  const items = p.items.map((it) => ({ ...it }));
  let failures = 0;
  let createdNow = 0;
  for (const [it, i] of toCreate({ ...p, items })) {
    const o = it.option!;
    if (failures >= MAX_FAILURES_IN_ROW) {
      items[i] = { ...it, done: { failed: true } };
      continue;
    }
    const yearly = it.birthday && p.yearly ? [toRRule({ freq: "yearly" }, { day: o.startDay, minutes: 0 }, o.tz, true)] : undefined;
    try {
      const created = await provider.createEvent({
        idempotencyKey: `${action.id}${i}`,
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
        ...(yearly ? { recurrence: yearly } : o.series ? { recurrence: [o.series.rrule] } : {}),
        ...remindersFor(user, o.allDay),
      });
      items[i] = { ...it, done: { ref: created.ref, ...(created.link ? { link: created.link } : {}), ...(created.etag ? { etag: created.etag } : {}) } };
      failures = 0;
      createdNow++;
      // Не user.id: в группе нажать может любой взрослый дома, а автор — тот, кто попросил (US-94)
      await noteCreator(ctx, created.ref, action.userId);
      await saveEventFamily(ctx, created.ref, it.family);
      await notifyResponsible(ctx, it.family, action.userId, o);
    } catch (e) {
      if (!(e instanceof ProviderUnavailable)) throw e;
      console.error("multi create failed", e.message);
      items[i] = { ...it, done: { failed: true } };
      failures++;
    }
  }
  const next: MultiCardPayload = { ...p, items };
  const created = items.filter(isCreated);
  const left = toCreate(next).length;
  const today = utcToLocal(ctx.clock.now(), user.tz).day;
  const text = multiSummaryText(next, today, locale);
  let undoButton: InlineKeyboardButton | undefined;
  let undoId: string | undefined;
  if (created.length) {
    const undo = await recordUndo(ctx, {
      conversationId: action.conversationId,
      user,
      chatId: p.chatId,
      record: {
        kind: "create_many",
        items: created.map((it) => {
          const d = doneOf(it)!;
          return { ref: d.ref, ...(d.etag ? { etag: d.etag } : {}), title: it.title };
        }),
      },
      summary: text,
    });
    undoId = undo.undoId;
    undoButton = { text: t("multiUndoAll", locale, { n: String(created.length) }), callback_data: undo.button.callback_data };
  }
  const row: InlineKeyboardButton[] = left
    ? [
        { text: t("multiRetry", locale, { n: String(left) }), callback_data: callbackData(action.id, "r") },
        undoButton ?? { text: t("cancelButton", locale), callback_data: callbackData(action.id, "x") },
      ]
    : undoButton
      ? [undoButton]
      : [];
  const json = JSON.stringify(next);
  if (left) await reopenCard(ctx.db, action.id, json, ctx.clock.now());
  else await setCardPayload(ctx.db, action.id, json);
  if (action.messageId) {
    await ctx.telegram.editMessageText(p.chatId, action.messageId, text, { inline_keyboard: row.length ? [row] : [] }, { html: true });
    if (undoId) await attachUndoMessage(ctx.db, undoId, Number(action.messageId));
  }
  if (created.length) {
    const last = created.at(-1)!;
    const refs = created.map((it) => doneOf(it)!.ref);
    await mergeDialogState(
      ctx.db,
      action.conversationId,
      user.id,
      {
        lastList: { refs, at: ctx.clock.now() },
        lastEvent: { ref: refs.at(-1)!, at: ctx.clock.now() },
        lastDay: { day: formatDate(last.option!.startDay), at: ctx.clock.now() },
      },
      ctx.clock.now(),
    );
  }
  if (createdNow) {
    const recurring = items.some((it) => isCreated(it) && (it.option?.series || (it.birthday && p.yearly)));
    const features: Feature[] = ["create", ...(recurring ? ["recurring" as const] : []), ...(p.viaAlias ? ["alias" as const] : [])];
    await recordFeature(ctx.db, user.id, features, ctx.clock.now());
  }
  return createdNow > 0;
}
