// Ошибки календаря — понятным текстом; прочие (Telegram, D1, баги) не выдаём за «Google не отвечает».

import { GoogleCalendarProvider } from "../calendar/google-provider";
import { AuthRevoked, CalendarError, PermissionDenied } from "../calendar/model";
import type { User } from "../db/users";
import { botWriteListener } from "../sync/bot-writes";
import type { AppContext } from "./context";
import { connectKeyboard } from "./keyboards";
import { t } from "./messages";

export async function withCalendar(ctx: AppContext, user: User, chatId: number, action: (provider: GoogleCalendarProvider) => Promise<void>): Promise<boolean> {
  try {
    const scope = ctx.calendarScope;
    if (scope && scope.calendarIds.length === 0) {
      await ctx.telegram.sendMessage(chatId, t("homeNoSharedCalendars", user.locale));
      return false;
    }
    // botWriteListener: после записи — уведомление в другие чаты календаря (US-72) и пересчёт напоминаний (US-71)
    await action(
      new GoogleCalendarProvider(
        ctx.config,
        ctx.db,
        scope?.ownerUserId ?? user.id,
        ctx.clock,
        scope?.calendarIds,
        botWriteListener(ctx, user, chatId),
        scope?.defaultCalendarId,
      ),
    );
    return true;
  } catch (e) {
    console.error("calendar action failed", e instanceof Error ? e.message : e);
    if (e instanceof AuthRevoked && ctx.calendarScope) {
      // Доступ отозван у владельца дома — участнику нечего переподключать
      await ctx.telegram.sendMessage(chatId, t("homeCalendarsUnavailable", user.locale));
    } else if (e instanceof AuthRevoked) {
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
