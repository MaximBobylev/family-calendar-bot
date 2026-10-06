// Обёртка действий с календарём: провайдер на пользователя и ошибки — понятным текстом (US-14, US-02).
// Общая для маршрутизации интентов, диалога и нажатий кнопок.

import { GoogleCalendarProvider } from "../calendar/google-provider";
import { AuthRevoked, CalendarError, PermissionDenied } from "../calendar/model";
import type { User } from "../db/users";
import type { AppContext } from "./context";
import { connectKeyboard } from "./keyboards";
import { t } from "./messages";

/**
 * Ошибки календаря — понятным текстом (US-14); отозванный доступ — предложить переподключить (US-02).
 * Прочие ошибки (Telegram, D1, баги) не выдаём за «Google не отвечает» (ревью 2026-10-05).
 * Возвращает false, если действие не удалось.
 */
export async function withCalendar(ctx: AppContext, user: User, chatId: number, action: (provider: GoogleCalendarProvider) => Promise<void>): Promise<boolean> {
  try {
    await action(new GoogleCalendarProvider(ctx.config, ctx.db, user.id, ctx.clock));
    return true;
  } catch (e) {
    console.error("calendar action failed", e instanceof Error ? e.message : e);
    if (e instanceof AuthRevoked) {
      await ctx.telegram.sendMessage(chatId, t("googleRevoked", user.locale), await connectKeyboard(ctx, user.id, user.locale, user.tgName));
    } else if (e instanceof PermissionDenied) {
      await ctx.telegram.sendMessage(chatId, t("calendarForbidden", user.locale));
    } else if (e instanceof CalendarError) {
      await ctx.telegram.sendMessage(chatId, t("googleUnavailable", user.locale));
    } else {
      await ctx.telegram.sendMessage(chatId, t("internalError", user.locale)).catch(() => undefined);
    }
    return false;
  }
}
