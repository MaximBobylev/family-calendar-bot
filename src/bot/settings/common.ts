// Общие для кнопок (callbacks.ts) и ввода текстом (input.ts).

import { GoogleCalendarProvider } from "../../calendar/google-provider";
import { googleAccountEmail } from "../../db/accounts";
import { rescheduleDigest } from "../../jobs/digest";
import { DEFAULT_DIGEST_TIME, updateSettings } from "../../db/settings";
import type { User } from "../../db/users";
import type { AppContext } from "../context";
import { connectKeyboard } from "../keyboards";
import { t } from "../messages";
import { mainScreen } from "./screens";

export async function setDigest(ctx: AppContext, user: User, time: string | null): Promise<User> {
  await updateSettings(ctx.db, user.id, time ? { digestOff: undefined, digestTime: time === DEFAULT_DIGEST_TIME ? undefined : time } : { digestOff: true });
  await rescheduleDigest(ctx.db, user.id, ctx.clock.now());
  const { digestOff: _o, digestTime: _t, ...rest } = user.settings;
  return {
    ...user,
    settings: time
      ? { ...rest, digestTime: time }
      : { ...rest, digestOff: true, ...(user.settings.digestTime ? { digestTime: user.settings.digestTime } : {}) },
  };
}

export const calendarsOf = (ctx: AppContext, user: User) => new GoogleCalendarProvider(ctx.config, ctx.db, user.id, ctx.clock).calendars();

export async function showSettings(ctx: AppContext, user: User, chatId: number): Promise<void> {
  const s = mainScreen(ctx, user, await calendarsOf(ctx, user));
  await ctx.telegram.sendMessage(chatId, s.text, { inline_keyboard: s.buttons }, { html: true });
}

// Переподключение того же аккаунта сохраняет настройки (tech-debt #19).
export async function sendReconnect(ctx: AppContext, user: User, chatId: number): Promise<void> {
  const row = await googleAccountEmail(ctx.db, user.id);
  const text = row ? t("reconnectPrompt", user.locale, { email: row.email ?? "Google" }) : t("connectPrompt", user.locale);
  await ctx.telegram.sendMessage(chatId, text, await connectKeyboard(ctx, user.id, user.locale, user.tgName));
}
