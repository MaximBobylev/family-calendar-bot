// Отвечаем прямо из webhook, без inbox: Telegram шлёт запрос на каждое нажатие клавиши, ответ нужен сразу, повтор
// безвреден. Посторонним — пустой ответ.

import { DEFAULT_DURATION_MIN } from "../../db/settings";
import { saveInlineEvent } from "../../db/inline";
import { findUserByTelegramId } from "../../db/users";
import type { TgInlineQuery } from "../../telegram/types";
import type { AppContext } from "../context";
import { hasAccess } from "../gate";
import { t } from "../messages";
import { inlineKeyboard, inlineToken } from "./guest";
import { inlineCardText, inlineEventEnd, inlineResultTitle, inlineWhen, parseInlineQuery } from "./logic";
import { utcToLocal } from "../../dates/calendar";

// Ссылка .ics и кнопка ещё работают у тех, кто открыл чат позже.
const KEEP_AFTER_END_MS = 7 * 86_400_000;
const MAX_RESULTS = 3;

export async function handleInlineQuery(ctx: AppContext, q: TgInlineQuery): Promise<void> {
  if (q.from.is_bot || !(await hasAccess(ctx, q.from.id))) {
    await ctx.telegram.answerInlineQuery(q.id, [], { cacheTime: 300 });
    return;
  }
  const now = ctx.clock.now();
  const user = await findUserByTelegramId(ctx.db, q.from.id);
  const locale = user?.locale ?? (q.from.language_code === "en" ? "en" : "ru");
  const tz = user?.tz ?? "UTC";
  const events = parseInlineQuery(q.query, now, tz, user?.settings.durationMin ?? DEFAULT_DURATION_MIN, locale).slice(0, MAX_RESULTS);

  const today = utcToLocal(now, tz).day;
  const results = [];
  for (const e of events) {
    const token = await inlineToken(ctx.config.telegramWebhookSecret, q.from.id, e);
    await saveInlineEvent(ctx.db, { token, createdByTg: q.from.id, event: e, now, expiresAt: Math.max(inlineEventEnd(e), now) + KEEP_AFTER_END_MS });
    results.push({
      type: "article",
      id: token,
      title: inlineResultTitle(e, now),
      description: `${inlineWhen(e, today)} · ${t("inlineAddButton", locale)}`,
      input_message_content: { message_text: inlineCardText(e, today), parse_mode: "HTML", link_preview_options: { is_disabled: true } },
      reply_markup: inlineKeyboard(token, locale),
    });
  }
  await ctx.telegram.answerInlineQuery(q.id, results);
}
