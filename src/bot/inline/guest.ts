// US-95: общее для inline-карточки — токен события, кнопка «Добавить себе», счётчик на сообщении, гостевые ссылки
// (шаблон Google Calendar и .ics без OAuth) и маршрут /ics/<токен>. Посторонние (не в allowlist и не в доме) сюда
// попадают прямо из webhook (gate.ts): без записи апдейта в inbox и без регистрации — как ответ «бот закрыт».

import { GOOGLE_CALENDAR_TEMPLATE_URL } from "../../config";
import { utcToLocal } from "../../dates/calendar";
import { loadInlineEvent, recordInlineAdd } from "../../db/inline";
import type { InlineKeyboardButton, ReplyMarkup, TgCallbackQuery, TgMessage } from "../../telegram/types";
import type { AppContext } from "../context";
import { t } from "../messages";
import { addStartLink, buildIcs, googleTemplateUrl, inlineCallbackData, inlineCardText, type InlineEvent, parseAddStart, parseInlineCallback } from "./logic";

/** Токен события: HMAC от автора и события — не угадать по содержимому, а повторный запрос даёт тот же токен. */
export async function inlineToken(secret: string, authorTg: number, e: InlineEvent): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(`inline:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${authorTg}\n${JSON.stringify(e)}`)));
  return [...sig.slice(0, 10)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Кнопка под карточкой в чате. */
export const inlineKeyboard = (token: string, locale: string): ReplyMarkup => ({
  inline_keyboard: [[{ text: t("inlineAddButton", locale), callback_data: inlineCallbackData(token) }]],
});

/** Учесть нажатие под карточкой и обновить счётчик «Добавили себе: N» (только при новом нажавшем). */
export async function countPress(ctx: AppContext, cq: TgCallbackQuery, token: string, e: InlineEvent): Promise<void> {
  if (!cq.inline_message_id) return;
  const now = ctx.clock.now();
  const { count, isNew } = await recordInlineAdd(ctx.db, { inlineMessageId: cq.inline_message_id, telegramId: cq.from.id, token, now });
  if (!isNew) return;
  const text = inlineCardText(e, utcToLocal(now, e.tz).day, count);
  await ctx.telegram.editInlineMessageText(cq.inline_message_id, text, inlineKeyboard(token, e.locale));
}

/** Сообщение со ссылками «добавить без бота»: шаблон Google Calendar и .ics; note — что дальше (зависит от доступа). */
export function guestLinks(
  ctx: AppContext,
  e: InlineEvent,
  token: string,
  locale: string,
  note: "inlineGuestClosed" | "inlineMemberNoGoogle",
): { text: string; markup: ReplyMarkup } {
  const shown = { ...e, locale };
  const text = [
    inlineCardText(shown, utcToLocal(ctx.clock.now(), e.tz).day),
    "",
    t("inlineGuestIntro", locale),
    t("inlineIcsHint", locale),
    "",
    t(note, locale),
  ].join("\n");
  const buttons: InlineKeyboardButton[][] = [
    [{ text: t("inlineGoogleButton", locale), url: googleTemplateUrl(GOOGLE_CALENDAR_TEMPLATE_URL, e) }],
    [{ text: t("inlineIcsButton", locale), url: `${ctx.config.publicBaseUrl}/ics/${token}` }],
  ];
  return { text, markup: { inline_keyboard: buttons } };
}

/**
 * Посторонний нажал «Добавить себе»: callback может открыть только t.me/<бот>?start=… — открываем личный чат,
 * где /start add_<токен> пришлёт ссылки (replyGuestStart). true — нажатие было на inline-карточке.
 */
export async function answerGuestPress(ctx: AppContext, cq: TgCallbackQuery): Promise<boolean> {
  const token = parseInlineCallback(cq.data);
  if (!token) return false;
  const lang = cq.from.language_code ?? "ru";
  const e = await loadInlineEvent(ctx.db, token, ctx.clock.now());
  if (!e) {
    await ctx.telegram.answerCallbackQuery(cq.id, t("inlineExpired", lang));
    return true;
  }
  await ctx.telegram.answerCallbackQuery(cq.id, undefined, { url: addStartLink(ctx.config.telegramBotUsername, token) });
  await countPress(ctx, cq, token, e);
  return true;
}

/** Посторонний открыл бота по ссылке карточки (/start add_<токен>): ссылки без OAuth вместо «бот закрыт». */
export async function replyGuestStart(ctx: AppContext, message: TgMessage): Promise<boolean> {
  if (message.chat.type !== "private") return false;
  const token = parseAddStart(message.text);
  if (!token) return false;
  const locale = message.from?.language_code === "en" ? "en" : "ru";
  const e = await loadInlineEvent(ctx.db, token, ctx.clock.now());
  if (!e) {
    await ctx.telegram.sendMessage(message.chat.id, t("inlineExpired", locale));
    return true;
  }
  const { text, markup } = guestLinks(ctx, e, token, locale, "inlineGuestClosed");
  await ctx.telegram.sendMessage(message.chat.id, text, markup, { html: true });
  return true;
}

/** GET /ics/<токен> — файл события для Apple Календаря, Outlook и др.; нет токена или срок вышел — 404. */
export async function serveIcs(ctx: AppContext, path: string): Promise<Response> {
  const token = /^\/ics\/([0-9a-f]{20})(?:\.ics)?$/.exec(path)?.[1];
  const e = token ? await loadInlineEvent(ctx.db, token, ctx.clock.now()) : null;
  if (!token || !e) return new Response("Not found", { status: 404 });
  const host = new URL(ctx.config.publicBaseUrl).host;
  return new Response(buildIcs(e, `${token}@${host}`, ctx.clock.now()), {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": 'attachment; filename="event.ics"',
      "cache-control": "private, max-age=300",
    },
  });
}
