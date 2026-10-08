// Метрика `date_fix` (tech-debt #26): ловим правку даты сразу после карточки создания — другой вариант, изменение времени
// только что созданного события, отмена и создание заново на другую дату. Классификация — date-fix-logic.ts; здесь — состояние
// диалога, строка в date_metrics и лог. Всё best-effort: сбой метрики не ломает действие пользователя.

import type { StoredRef } from "../db/conversations";
import { getDialogState, mergeDialogState } from "../db/conversations";
import { recordDateMetric } from "../db/date-metrics";
import { log } from "../log";
import type { AppContext } from "./context";
import type { CreateCardPayload, CreateOption } from "./create-logic";
import { checkDisagreed, classifyDateFix, type DateFixKind, type DateFixWatch, optionWhen } from "./date-fix-logic";

interface CardRef {
  conversationId: string;
  userId: string;
}

async function recordFix(ctx: AppContext, userId: string, kind: DateFixKind, source: string, agreement: string | undefined): Promise<void> {
  const disagreed = checkDisagreed(agreement as DateFixWatch["agreement"]);
  log("date_fix", { source, fix: kind, agreement, disagreed });
  await recordDateMetric(ctx.db, { userId, event: "fix", source, fixKind: kind, agreement, disagreed, now: ctx.clock.now() });
}

async function safely(what: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error(`date_fix ${what} failed`, e instanceof Error ? e.message : e);
  }
}

/** Событие создано кнопкой карточки: правка ли это (другой вариант / пересоздание), учёт «создано», запомнить карточку. */
export function dateFixOnCreated(ctx: AppContext, card: CardRef, payload: CreateCardPayload, index: number, ref: StoredRef): Promise<void> {
  return safely("created", async () => {
    const o = payload.options[index]!;
    const now = ctx.clock.now();
    const source = payload.dateCheck?.source ?? "unknown";
    const agreement = payload.dateCheck?.agreement;
    const state = await getDialogState(ctx.db, card.conversationId, card.userId);
    const when = optionWhen(o);
    const kind = classifyDateFix(state.dateFix, { k: "pick", options: payload.options, index, title: o.title, when }, now);
    if (kind === "recreate") await recordFix(ctx, card.userId, kind, state.dateFix!.source, state.dateFix!.agreement);
    else if (kind) await recordFix(ctx, card.userId, kind, source, agreement);
    await recordDateMetric(ctx.db, { userId: card.userId, event: "created", source, agreement, disagreed: checkDisagreed(agreement), now });
    const watch: DateFixWatch = {
      stage: "created",
      eventId: ref.providerEventId,
      title: o.title,
      when,
      source: payload.dateCheck?.source ?? "message",
      ...(agreement ? { agreement } : {}),
      at: now,
      ...(kind ? { fixed: true as const } : {}),
    };
    await mergeDialogState(ctx.db, card.conversationId, card.userId, { dateFix: watch }, now);
  });
}

/** Карточку создания отменили: запомнить, что хотели, — пересоздание на другую дату станет правкой. */
export function dateFixOnCancelled(ctx: AppContext, card: CardRef, payload: CreateCardPayload): Promise<void> {
  return safely("cancelled", async () => {
    const o: CreateOption | undefined = payload.options[0];
    if (!o || o.series) return;
    const now = ctx.clock.now();
    const watch: DateFixWatch = {
      stage: "cancelled",
      title: o.title,
      when: optionWhen(o),
      source: payload.dateCheck?.source ?? "message",
      ...(payload.dateCheck ? { agreement: payload.dateCheck.agreement } : {}),
      at: now,
    };
    await mergeDialogState(ctx.db, card.conversationId, card.userId, { dateFix: watch }, now);
  });
}

/** Созданное только что событие откатили «Отменить»: дальше — как отменённая карточка. */
export function dateFixOnUndoCreate(ctx: AppContext, card: CardRef, ref: StoredRef): Promise<void> {
  return safely("undo", async () => {
    const state = await getDialogState(ctx.db, card.conversationId, card.userId);
    const w = state.dateFix;
    if (w?.stage !== "created" || w.eventId !== ref.providerEventId) return;
    const { eventId: _id, ...rest } = w;
    await mergeDialogState(ctx.db, card.conversationId, card.userId, { dateFix: { ...rest, stage: "cancelled", at: ctx.clock.now() } }, ctx.clock.now());
  });
}

/** Событие изменено: время только что созданного — правка его даты (один раз на карточку). */
export function dateFixOnModified(ctx: AppContext, card: CardRef, ref: StoredRef, timeChanged: boolean): Promise<void> {
  return safely("modified", async () => {
    const state = await getDialogState(ctx.db, card.conversationId, card.userId);
    const w = state.dateFix;
    const kind = classifyDateFix(w, { k: "modify", eventId: ref.providerEventId, timeChanged }, ctx.clock.now());
    if (!kind || !w) return;
    await recordFix(ctx, card.userId, kind, w.source, w.agreement);
    await mergeDialogState(ctx.db, card.conversationId, card.userId, { dateFix: undefined }, ctx.clock.now());
  });
}
