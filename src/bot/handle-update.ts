// Обработка одного апдейта: доступ, регистрация, привязка календаря, команды.

import { GoogleCalendarProvider } from "../calendar/google-provider";
import { hasGoogleAccount } from "../db/accounts";
import { recordUsage } from "../db/usage";
import { ensureTelegramUser, type User } from "../db/users";
import { GoogleAuthError } from "../google/auth";
import { parseIntent, type ParsedIntent } from "../nlu/intents";
import type { TgMessage, TgUpdate } from "../telegram/types";
import type { AppContext } from "./context";
import { connectKeyboard } from "./keyboards";
import { t } from "./messages";
import { readEvents } from "./read-events";

export async function handleUpdate(ctx: AppContext, update: TgUpdate): Promise<void> {
  // Отредактированные сообщения игнорируем (US-10)
  if (update.edited_message) return;

  const message = update.message;
  const from = message?.from ?? update.callback_query?.from;
  if (!from || from.is_bot) return;
  const lang = from.language_code ?? "ru";

  if (message && message.chat.type !== "private") {
    await ctx.telegram.sendMessage(message.chat.id, t("privateOnly", lang));
    return;
  }

  // Доступ проверяется до любой обработки (US-01, ADR-0001)
  if (!ctx.config.allowedTelegramIds.has(String(from.id))) {
    if (message) await ctx.telegram.sendMessage(message.chat.id, t("notAllowed", lang));
    return;
  }

  const { user } = await ensureTelegramUser(ctx.db, from.id, from.language_code, ctx.clock.now());
  if (!message) return;
  const isStart = message.text?.trim() === "/start";

  // Без привязанного календаря интент не распознаём — только предлагаем подключить (US-01)
  if (!(await hasGoogleAccount(ctx.db, user.id))) {
    const text = isStart ? `${t("welcome", user.locale)}\n\n${t("connectPrompt", user.locale)}` : t("connectPrompt", user.locale);
    await ctx.telegram.sendMessage(message.chat.id, text, await connectKeyboard(ctx, user.id, user.locale));
    return;
  }

  if (isStart) {
    await ctx.telegram.sendMessage(message.chat.id, t("welcome", user.locale));
    return;
  }
  await handleCommand(ctx, user, message);
}

async function handleCommand(ctx: AppContext, user: User, message: TgMessage): Promise<void> {
  const chatId = message.chat.id;
  const text = message.text?.trim();
  if (!text) {
    // Голос, фото и прочее — позже (US-10, US-66)
    await ctx.telegram.sendMessage(chatId, t("notImplemented", user.locale));
    return;
  }

  const calendarNames = await ctx.db
    .prepare(
      `SELECT c.title AS name FROM calendars c JOIN provider_accounts a ON a.id = c.account_id WHERE a.user_id = ?1
       UNION SELECT alias FROM calendar_aliases WHERE user_id = ?1`,
    )
    .bind(user.id)
    .all<{ name: string }>();

  let parsed: ParsedIntent;
  try {
    parsed = await parseIntent(ctx.config.llm, text, { calendars: calendarNames.results.map((r) => r.name) });
  } catch (e) {
    console.error("llm failed", e);
    await recordUsage(ctx.db, { userId: user.id, kind: "llm", provider: ctx.config.llm.baseUrl, model: ctx.config.llm.model, text, result: String(e), outcome: "error", now: ctx.clock.now() });
    await ctx.telegram.sendMessage(chatId, t("llmUnavailable", user.locale));
    return;
  }
  await recordUsage(ctx.db, {
    userId: user.id, kind: "llm", provider: ctx.config.llm.baseUrl, model: ctx.config.llm.model,
    tokensIn: parsed.tokensIn, tokensOut: parsed.tokensOut, text, result: parsed.intent, outcome: "ok", now: ctx.clock.now(),
  });

  const intent = parsed.intent;
  switch (intent.name) {
    case "unsupported":
      await ctx.telegram.sendMessage(chatId, t("unsupported", user.locale));
      return;
    case "multiple":
      await ctx.telegram.sendMessage(chatId, t("oneAtATime", user.locale));
      return;
    case "list_events":
      await withCalendar(ctx, user, chatId, (provider) =>
        readEvents(ctx, provider, {
          userId: user.id, chatId, locale: user.locale, tz: user.home_tz, range: intent.range,
          ...(intent.calendar ? { calendar: intent.calendar } : {}),
        }),
      );
      return;
  }
}

/** Ошибки Google — понятным текстом (US-14); отозванный доступ — предложить переподключить (US-02). */
async function withCalendar(
  ctx: AppContext,
  user: User,
  chatId: number,
  action: (provider: GoogleCalendarProvider) => Promise<void>,
): Promise<void> {
  try {
    await action(new GoogleCalendarProvider(ctx.config, ctx.db, user.id));
  } catch (e) {
    console.error("calendar action failed", e);
    if (e instanceof GoogleAuthError && e.revoked) {
      await ctx.telegram.sendMessage(chatId, t("googleRevoked", user.locale), await connectKeyboard(ctx, user.id, user.locale));
    } else {
      await ctx.telegram.sendMessage(chatId, t("googleUnavailable", user.locale));
    }
  }
}
