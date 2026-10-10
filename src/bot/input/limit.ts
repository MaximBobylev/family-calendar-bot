// Лимит проверяется до внешнего вызова: исчерпан — вежливый ответ без вызова LLM/STT (tech-debt #4).

import { usageWindow } from "../../db/usage";
import type { User } from "../../db/users";
import { checkLimit, HOUR_MS, MINUTE_MS } from "../../limits";
import type { AppContext } from "../context";
import { t } from "../messages";

const LIMIT_MESSAGES = {
  llm: { hour: "llmLimitHour", day: "llmLimitDay" },
  stt: { hour: "sttLimitHour", day: "sttLimitDay" },
} as const;

export async function withinLimit(ctx: AppContext, user: User, kind: "llm" | "stt", chatId: number): Promise<boolean> {
  const now = ctx.clock.now();
  const verdict = checkLimit(ctx.config.limits[kind], await usageWindow(ctx.db, user.id, kind, now), now);
  if (verdict.ok) return true;
  console.warn("usage limit reached", user.id, kind, verdict.window);
  const params: Record<string, string> =
    verdict.window === "hour"
      ? { minutes: String(Math.max(1, Math.ceil(verdict.retryInMs / MINUTE_MS))) }
      : { hours: String(Math.max(1, Math.ceil(verdict.retryInMs / HOUR_MS))) };
  const key = LIMIT_MESSAGES[kind][verdict.window];
  await ctx.telegram.sendMessage(chatId, t(key, user.locale, { limit: String(verdict.limit), ...params }));
  return false;
}
