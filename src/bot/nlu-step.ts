// Шаг NLU: текст команды → интент через цепочку LLM (ADR-0002), с лимитом и записью в журнал (US-13).
// Поправки интента по тексту (nlu/intent-overrides.ts) применяет routeIntent — они общие и для голоса.
// Разобранный интент сохраняется в inbox: повтор апдейта после сбоя LLM снова не зовёт (tech-debt #5).

import { calendarNamesOf } from "../db/accounts";
import { recordUsage } from "../db/usage";
import { saveIntent } from "../inbox";
import type { User } from "../db/users";
import { llmCostMicroUsd } from "../limits";
import { type Intent, LlmChainError, parseIntentChain, type ParsedIntent } from "../nlu/intents";
import type { AppContext } from "./context";
import { withinLimit } from "./input/limit";
import { t } from "./messages";

/** Интент от LLM. null — уже ответили пользователю (лимит исчерпан, LLM недоступна). */
export async function parseCommandIntent(ctx: AppContext, user: User, chatId: number, text: string): Promise<Intent | null> {
  // Повтор после сбоя: этот текст уже разобран прошлой попыткой — ни лимита, ни вызова, ни записи в журнал
  const done = ctx.progress?.nlu;
  if (done && done.text === text) return done.intent as Intent;
  const calendars = await calendarNamesOf(ctx.db, user.id);
  if (!(await withinLimit(ctx, user, "llm", chatId))) return null;
  let parsed: ParsedIntent;
  try {
    // Команда — короткая фраза; длинный текст в LLM не шлём (стоимость, prompt injection)
    const res = await parseIntentChain(ctx.config.llm, text.slice(0, 500), { calendars });
    parsed = res.parsed;
    const via = res.via;
    const costs = {
      ...ctx.config.costs,
      ...(via.inPerM !== undefined ? { llmInPerM: via.inPerM } : {}),
      ...(via.outPerM !== undefined ? { llmOutPerM: via.outPerM } : {}),
    };
    await recordUsage(ctx.db, {
      userId: user.id,
      kind: "llm",
      provider: via.name ?? via.baseUrl,
      model: via.model,
      tokensIn: parsed.tokensIn,
      tokensOut: parsed.tokensOut,
      costMicroUsd: llmCostMicroUsd(costs, parsed.tokensIn, parsed.tokensOut),
      text,
      // Упавшие до него провайдеры — видно в журнале, что сработал запасной
      result: res.failed.length ? { ...parsed.intent, fallbackFrom: res.failed } : parsed.intent,
      outcome: "ok",
      now: ctx.clock.now(),
    });
  } catch (e) {
    console.error("llm failed", e);
    const first = ctx.config.llm[0];
    await recordUsage(ctx.db, {
      userId: user.id,
      kind: "llm",
      provider: e instanceof LlmChainError ? "chain" : (first?.name ?? first?.baseUrl ?? "none"),
      model: first?.model ?? "none",
      text,
      result: e instanceof LlmChainError ? { failed: e.failed } : String(e),
      outcome: "error",
      now: ctx.clock.now(),
    });
    await ctx.telegram.sendMessage(chatId, t("llmUnavailable", user.locale));
    return null;
  }
  if (ctx.progress) await saveIntent(ctx.db, ctx.progress.updateId, { text, intent: parsed.intent });
  return parsed.intent;
}
