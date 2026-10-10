// Личный чат с ботом ещё не начат (Telegram 403) — открываем его deep link'ом из ответа на нажатие, дальше /start add_<токен>.

import { parseLocal, utcToLocal } from "../../dates/calendar";
import { hasGoogleAccount } from "../../db/accounts";
import { attachMessage, createPendingAction, ensureConversation } from "../../db/conversations";
import { loadInlineEvent } from "../../db/inline";
import type { User } from "../../db/users";
import { TelegramError } from "../../telegram/api";
import type { InlineKeyboardButton, TgCallbackQuery } from "../../telegram/types";
import type { AppContext } from "../context";
import { CREATE_CARD } from "../create-event";
import { type CreateCardPayload, type CreateOption, resolveCalendar } from "../create-logic";
import { createCard } from "../create-view";
import { t } from "../messages";
import { withCalendar } from "../with-calendar";
import { countPress, guestLinks } from "./guest";
import { addStartLink, type InlineEvent, parseInlineCallback } from "./logic";

export const isInlinePress = (cq: TgCallbackQuery | undefined) => !!cq && parseInlineCallback(cq.data) !== null;

// Ответ на нажатие у Telegram один: «карточка в личном чате» или ссылка, открывающая этот чат.
export async function handleInlinePress(ctx: AppContext, user: User, cq: TgCallbackQuery): Promise<void> {
  const token = parseInlineCallback(cq.data)!;
  const e = await loadInlineEvent(ctx.db, token, ctx.clock.now());
  if (!e) {
    await ctx.telegram.answerCallbackQuery(cq.id, t("inlineExpired", user.locale));
    return;
  }
  await countPress(ctx, cq, token, e);
  const sent = await deliverToPrivate(ctx, user, cq.from.id, token, e);
  if (sent) await ctx.telegram.answerCallbackQuery(cq.id, t("inlineCardSent", user.locale));
  else await ctx.telegram.answerCallbackQuery(cq.id, undefined, { url: addStartLink(ctx.config.telegramBotUsername, token) });
}

export async function handleAddStart(ctx: AppContext, user: User, chatId: number, token: string): Promise<void> {
  const e = await loadInlineEvent(ctx.db, token, ctx.clock.now());
  if (!e) {
    await ctx.telegram.sendMessage(chatId, t("inlineExpired", user.locale));
    return;
  }
  await deliverToPrivate(ctx, user, chatId, token, e);
}

// false — чат с ботом не начат или бот заблокирован.
async function deliverToPrivate(ctx: AppContext, user: User, chatId: number, token: string, e: InlineEvent): Promise<boolean> {
  try {
    if (await hasGoogleAccount(ctx.db, user.id)) return await sendCreateCard(ctx, user, chatId, e);
    const { text, markup } = guestLinks(ctx, e, token, user.locale, "inlineMemberNoGoogle");
    await ctx.telegram.sendMessage(chatId, text, markup, { html: true });
    return true;
  } catch (err) {
    if (isUnreachable(err)) return false;
    throw err;
  }
}

const isUnreachable = (err: unknown) => err instanceof TelegramError && err.status === 403;

// Вне withCalendar: 403 недоступного чата он выдал бы за внутреннюю ошибку и написал бы о ней туда же.
async function sendCreateCard(ctx: AppContext, user: User, chatId: number, e: InlineEvent): Promise<boolean> {
  const conversationId = await ensureConversation(ctx.db, chatId, "private");
  const tz = user.tz;
  let card: { actionId: string; text: string; buttons: InlineKeyboardButton[][] } | undefined;
  await withCalendar(ctx, user, chatId, async (provider) => {
    const calendars = await provider.calendars();
    const cal = resolveCalendar(calendars, undefined);
    if ("error" in cal) {
      await ctx.telegram.sendMessage(chatId, t("noWritableCalendar", user.locale));
      return;
    }
    const base = { calendarId: cal.id, calendarTitle: cal.title, title: e.title, titleGiven: true, tz, ...(e.location ? { location: e.location } : {}) };
    let option: CreateOption;
    if (e.allDay) {
      option = { ...base, allDay: true, startDay: parseLocal(`${e.startDate}T00:00`).day, endDay: parseLocal(`${e.endDate}T00:00`).day };
    } else {
      const start = utcToLocal(e.start!, tz);
      const end = utcToLocal(e.end!, tz);
      option = { ...base, allDay: false, start, end, startDay: start.day, endDay: end.day };
    }
    const actionId = await createPendingAction(ctx.db, {
      conversationId,
      userId: user.id,
      kind: CREATE_CARD,
      payload: { chatId, options: [option] } satisfies CreateCardPayload,
      now: ctx.clock.now(),
    });
    const showCalendar = calendars.filter((c) => c.writable).length > 1;
    card = { actionId, ...createCard([option], actionId, utcToLocal(ctx.clock.now(), tz).day, user.locale, showCalendar, []) };
  });
  // Ошибка календаря уже показана пользователю (значит, чат доступен)
  if (!card) return true;
  const sent = await ctx.telegram.sendMessage(chatId, card.text, { inline_keyboard: card.buttons }, { html: true });
  await attachMessage(ctx.db, card.actionId, sent.message_id);
  return true;
}
