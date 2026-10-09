// US-07 (R2): поездки и домашний пояс голосом/текстом — «Я в Тбилиси [до …]», «Я переехал в …», «Я вернулся», «Какой у меня
// пояс?» (разбор — nlu/timezone-command.ts, до шага NLU); карточки «поездка / навсегда», «Не знаю», «Вернулись?»; задача
// trip_check. Текущий пояс = поездка ?? дом (db/users.ts): даты, сводки и напоминания сами берут его.

import { formatMoment, parseLocal, utcToLocal } from "../dates/calendar";
import { attachMessage, createPendingAction, ensureConversation, mergeDialogState, AWAIT_TTL_MS, type PendingAction } from "../db/conversations";
import { telegramChatOf } from "../db/accounts";
import { recordFeature } from "../db/features";
import { cancelTripChecks, endTrip, scheduleTripCheck, setHomeTz, setTrip, setTripUntil } from "../db/settings";
import { findUserById, type User } from "../db/users";
import { rescheduleDigest } from "../jobs/digest";
import { parseTimeZone } from "../dates/timezone";
import type { SetTimezoneIntent } from "../nlu/intents";
import { parseTimezoneCommand, placeTimeZone, type TimezoneCommand, tripUntil } from "../nlu/timezone-command";
import type { DueJob } from "../scheduler";
import type { AppContext } from "./context";
import { dateLabel, escapeHtml, hhmm } from "./format";
import { callbackData } from "./keyboards";
import { t } from "./messages";
import { TRIP_RECHECK_MS, tripCheckAt } from "./trip-logic";

export const TZ_MODE_CARD = "tz_mode";
export const TZ_UNTIL_CARD = "tz_until";
export const TZ_RETURN_CARD = "tz_return";
export const TZ_CARDS = new Set([TZ_MODE_CARD, TZ_UNTIL_CARD, TZ_RETURN_CARD]);
/** «Вернулись?» нажимают и через несколько дней — кнопки живут до следующего вопроса. */
const RETURN_CARD_TTL_MS = TRIP_RECHECK_MS;

interface ModePayload {
  chatId: number;
  tz: string;
}
interface ReturnPayload {
  chatId: number;
  tz: string;
}

const timeIn = (ctx: AppContext, tz: string) => hhmm(utcToLocal(ctx.clock.now(), tz).minutes);
const localNow = (ctx: AppContext, tz: string) => formatMoment(utcToLocal(ctx.clock.now(), tz));
/** «вс, 11 октября» по поясу поездки. */
const dayText = (ctx: AppContext, day: string, tz: string, locale: string) =>
  dateLabel(parseLocal(`${day}T00:00`).day, utcToLocal(ctx.clock.now(), tz).day, locale);

/** Фраза о поясе — обработана (true); иначе это обычная команда. */
export async function handleTimezoneCommand(ctx: AppContext, user: User, chatId: number, conversationId: string, text: string): Promise<boolean> {
  const cmd = parseTimezoneCommand(text);
  if (!cmd) return false;
  await applyTimezoneCommand(ctx, user, chatId, conversationId, cmd);
  return true;
}

/**
 * Интент set_timezone от LLM — фраза, которую не узнал разбор без LLM (город не из словаря, другая формулировка). Пояс:
 * город из словаря, иначе IANA-имя от модели после проверки (Intl); не знаем — подсказка про /settings, не угадываем.
 */
export async function handleTimezoneIntent(ctx: AppContext, user: User, chatId: number, conversationId: string, intent: SetTimezoneIntent): Promise<void> {
  if (intent.action === "where" || intent.action === "return") {
    await applyTimezoneCommand(ctx, user, chatId, conversationId, { kind: intent.action });
    return;
  }
  const tz = (intent.place ? placeTimeZone(intent.place) : undefined) ?? (intent.tz ? parseTimeZone(intent.tz) : undefined);
  const place = intent.place ?? intent.tz ?? "";
  if (!tz) {
    await ctx.telegram.sendMessage(chatId, t("tzUnknownPlace", user.locale, { place: escapeHtml(place.slice(0, 60)) }), undefined, { html: true });
    return;
  }
  const until = intent.action === "trip" && intent.until ? intent.until.replace(/^\s*(до|until|till)\s+/i, "") : undefined;
  await applyTimezoneCommand(
    ctx,
    user,
    chatId,
    conversationId,
    intent.action === "move" ? { kind: "move", tz, place } : { kind: "trip", tz, place, ...(until ? { until } : {}) },
  );
}

async function applyTimezoneCommand(ctx: AppContext, user: User, chatId: number, conversationId: string, cmd: TimezoneCommand): Promise<void> {
  const l = user.locale;
  switch (cmd.kind) {
    case "where": {
      const trip = user.trip;
      await ctx.telegram.sendMessage(
        chatId,
        trip
          ? t("tzWhereTrip", l, { tz: trip.tz, time: timeIn(ctx, trip.tz), until: untilPart(ctx, trip.until, trip.tz, l), home: user.home_tz })
          : t("tzWhere", l, { tz: user.tz, time: timeIn(ctx, user.tz) }),
      );
      return;
    }
    case "return":
      await returnHome(ctx, user, chatId);
      return;
    case "move":
      await moveHome(ctx, user, chatId, cmd.tz);
      return;
    case "trip": {
      // Пояс поездки — домашний: это возвращение
      if (cmd.tz === user.home_tz) {
        await returnHome(ctx, user, chatId);
        return;
      }
      const until = cmd.until ? tripUntil(cmd.until, localNow(ctx, cmd.tz), cmd.tz) : undefined;
      if (until || user.trip?.tz === cmd.tz) {
        await startTrip(ctx, user, chatId, conversationId, cmd.tz, until ?? user.trip?.until);
        return;
      }
      const id = await createPendingAction(ctx.db, {
        conversationId,
        userId: user.id,
        kind: TZ_MODE_CARD,
        payload: { chatId, tz: cmd.tz } satisfies ModePayload,
        now: ctx.clock.now(),
      });
      const sent = await ctx.telegram.sendMessage(chatId, t("tzAskMode", l, { tz: cmd.tz, time: timeIn(ctx, cmd.tz) }), {
        inline_keyboard: [
          [
            { text: t("tzTripButton", l), callback_data: callbackData(id, "trip") },
            { text: t("tzMoveButton", l), callback_data: callbackData(id, "move") },
          ],
          [{ text: t("cancelButton", l), callback_data: callbackData(id, "x") }],
        ],
      });
      await attachMessage(ctx.db, id, sent.message_id);
      return;
    }
  }
}

const untilPart = (ctx: AppContext, until: string | undefined, tz: string, locale: string) =>
  until ? t("tzUntilPart", locale, { day: dayText(ctx, until, tz, locale) }) : "";

/** Включить поездку: пояс, вопрос «Вернулись?», сводки по новому поясу; без даты — спросить «До какого числа?». */
async function startTrip(ctx: AppContext, user: User, chatId: number, conversationId: string, tz: string, until: string | undefined): Promise<void> {
  const l = user.locale;
  const now = ctx.clock.now();
  await setTrip(ctx.db, user.id, tz, until ?? null);
  await scheduleTripCheck(ctx.db, user.id, tripCheckAt(now, tz, until));
  await rescheduleDigest(ctx.db, user.id, now);
  await recordFeature(ctx.db, user.id, "settings", now);
  const note = until ? ` ${t("tzTripUntilNote", l, { day: dayText(ctx, until, tz, l) })}` : "";
  await ctx.telegram.sendMessage(chatId, `${t("tzTripSet", l, { tz, time: timeIn(ctx, tz), home: user.home_tz })}${note}`);
  if (until) return;
  const id = await createPendingAction(ctx.db, { conversationId, userId: user.id, kind: TZ_UNTIL_CARD, payload: { chatId }, now });
  const sent = await ctx.telegram.sendMessage(chatId, t("tzAskUntil", l), {
    inline_keyboard: [[{ text: t("tzUntilUnknownButton", l), callback_data: callbackData(id, "skip") }]],
  });
  await attachMessage(ctx.db, id, sent.message_id);
  await mergeDialogState(ctx.db, conversationId, user.id, { awaiting: { kind: "trip_until", expiresAt: now + AWAIT_TTL_MS } }, now);
}

/** Ответ на «До какого числа?»: дата — запомнить; не дата — false (это новая команда). */
export async function answerTripUntil(ctx: AppContext, user: User, chatId: number, text: string): Promise<boolean> {
  const trip = user.trip;
  if (!trip) return false;
  const until = tripUntil(text.replace(/^\s*(до|until|till)\s+/i, ""), localNow(ctx, trip.tz), trip.tz);
  if (!until) return false;
  await setTripUntil(ctx.db, user.id, trip.tz, until);
  await scheduleTripCheck(ctx.db, user.id, tripCheckAt(ctx.clock.now(), trip.tz, until));
  await ctx.telegram.sendMessage(chatId, t("tzUntilSet", user.locale, { day: dayText(ctx, until, trip.tz, user.locale) }));
  return true;
}

async function returnHome(ctx: AppContext, user: User, chatId: number, editMessageId?: PendingAction["messageId"]): Promise<void> {
  const l = user.locale;
  const reply = (text: string) => (editMessageId ? ctx.telegram.editMessageText(chatId, editMessageId, text) : ctx.telegram.sendMessage(chatId, text));
  if (!user.trip) {
    await reply(t("tzAlreadyHome", l, { home: user.home_tz, time: timeIn(ctx, user.home_tz) }));
    return;
  }
  await endTrip(ctx.db, user.id);
  await cancelTripChecks(ctx.db, user.id).run();
  await rescheduleDigest(ctx.db, user.id, ctx.clock.now());
  await recordFeature(ctx.db, user.id, "settings", ctx.clock.now());
  await reply(t("tzReturned", l, { home: user.home_tz, time: timeIn(ctx, user.home_tz) }));
}

async function moveHome(ctx: AppContext, user: User, chatId: number, tz: string, editMessageId?: PendingAction["messageId"]): Promise<void> {
  await setHomeTz(ctx.db, user.id, tz);
  await cancelTripChecks(ctx.db, user.id).run();
  await rescheduleDigest(ctx.db, user.id, ctx.clock.now());
  await recordFeature(ctx.db, user.id, "settings", ctx.clock.now());
  const text = t("tzMoved", user.locale, { tz, time: timeIn(ctx, tz) });
  if (editMessageId) await ctx.telegram.editMessageText(chatId, editMessageId, text);
  else await ctx.telegram.sendMessage(chatId, text);
}

/** Нажатие на карточке пояса. Карточка уже «забрана» атомарно. */
export async function confirmTimezone(ctx: AppContext, user: User, action: PendingAction, choice: string): Promise<void> {
  const l = user.locale;
  const { chatId } = action.payload as { chatId: number };
  const edit = (text: string) => (action.messageId ? ctx.telegram.editMessageText(chatId, action.messageId, text) : ctx.telegram.sendMessage(chatId, text));
  if (action.kind === TZ_MODE_CARD) {
    const { tz } = action.payload as ModePayload;
    if (choice === "trip") {
      if (action.messageId) await ctx.telegram.editMessageText(chatId, action.messageId, t("tzAskMode", l, { tz, time: timeIn(ctx, tz) }));
      await startTrip(ctx, user, chatId, action.conversationId, tz, undefined);
    } else if (choice === "move") await moveHome(ctx, user, chatId, tz, action.messageId);
    else await edit(t("cancelled", l));
    return;
  }
  if (action.kind === TZ_UNTIL_CARD) {
    await mergeDialogState(ctx.db, action.conversationId, user.id, { awaiting: undefined }, ctx.clock.now());
    await edit(t("tzUntilUnknown", l));
    return;
  }
  // «Вернулись?»: поездка за это время могла закончиться или смениться — тогда кнопки уже ни о чём
  const { tz } = action.payload as ReturnPayload;
  if (user.trip?.tz !== tz) {
    await edit(t("cardExpired", l));
    return;
  }
  if (choice === "back") await returnHome(ctx, user, chatId, action.messageId);
  else if (choice === "keep") await moveHome(ctx, user, chatId, tz, action.messageId);
  else {
    await scheduleTripCheck(ctx.db, user.id, ctx.clock.now() + TRIP_RECHECK_MS);
    await edit(t("tzNotYet", l));
  }
}

/** Задача «Вернулись?»: в день окончания поездки или раз в неделю без даты. */
export async function runTripCheckJob(ctx: AppContext, job: DueJob): Promise<void> {
  const user = job.user_id ? await findUserById(ctx.db, job.user_id) : null;
  const trip = user?.trip;
  if (!user || !trip) return;
  const chat = await telegramChatOf(ctx.db, user.id);
  if (!chat) return;
  const chatId = Number(chat);
  const l = user.locale;
  const conversationId = await ensureConversation(ctx.db, chatId, "private");
  const id = await createPendingAction(ctx.db, {
    conversationId,
    userId: user.id,
    kind: TZ_RETURN_CARD,
    payload: { chatId, tz: trip.tz } satisfies ReturnPayload,
    now: ctx.clock.now(),
    ttlMs: RETURN_CARD_TTL_MS,
  });
  const sent = await ctx.telegram.sendMessage(chatId, t("tzReturnAsk", l, { tz: trip.tz, home: user.home_tz }), {
    inline_keyboard: [
      [{ text: t("tzBackButton", l, { home: user.home_tz }), callback_data: callbackData(id, "back") }],
      [{ text: t("tzNotYetButton", l), callback_data: callbackData(id, "notyet") }],
      [{ text: t("tzKeepButton", l, { tz: trip.tz }), callback_data: callbackData(id, "keep") }],
    ],
  });
  await attachMessage(ctx.db, id, sent.message_id);
}
