// Посторонние (не в allowlist и не в доме) попадают сюда прямо из webhook (gate.ts): без inbox и без регистрации.

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

export const inlineKeyboard = (token: string, locale: string): ReplyMarkup => ({
  inline_keyboard: [[{ text: t("inlineAddButton", locale), callback_data: inlineCallbackData(token) }]],
});

export async function countPress(ctx: AppContext, cq: TgCallbackQuery, token: string, e: InlineEvent): Promise<void> {
  if (!cq.inline_message_id) return;
  const now = ctx.clock.now();
  const { count, isNew } = await recordInlineAdd(ctx.db, { inlineMessageId: cq.inline_message_id, telegramId: cq.from.id, token, now });
  if (!isNew) return;
  const text = inlineCardText(e, utcToLocal(now, e.tz).day, count);
  await ctx.telegram.editInlineMessageText(cq.inline_message_id, text, inlineKeyboard(token, e.locale));
}

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

// Callback может открыть только t.me/<бот>?start=… — так и открываем личный чат, где /start add_<токен> пришлёт ссылки.
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
