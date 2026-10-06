// Интент → обработчик фичи (создание, изменение, удаление, поиск, список). Общий путь для текста, голоса,
// переслушанного голосового и пересланного после «Выполнить». Даты и «что менять» — из текста детерминированно.

import { formatMoment, utcToLocal } from "../dates/calendar";
import { cleanTitle, extractDateSpans, extractModifySpans, extractRecurrenceSpan, looksAllDay } from "../dates/extract";
import { mergeDialogState } from "../db/conversations";
import type { User } from "../db/users";
import { detailHints } from "../nlu/detail-hints";
import { effectiveIntent, lookupQuery, NEXT_WORD } from "../nlu/intent-overrides";
import type { Intent } from "../nlu/intents";
import { MASS_DELETE, modifyHints, modifyQuery } from "../nlu/modify-hints";
import type { AppContext } from "./context";
import { draftFromIntent, startCreate, type CreateDraft } from "./create-event";
import { startDelete } from "./delete-event";
import { lookupEvent } from "./event-lookup";
import type { EventRequest } from "./find-event";
import { t } from "./messages";
import { startModify } from "./modify-event";
import { readEvents } from "./read-events";
import { withCalendar } from "./with-calendar";

/** Интент → действие. Общий путь для текста, голоса и переслушанного голосового. */
export async function routeIntent(ctx: AppContext, user: User, chatId: number, conversationId: string, text: string, parsedIntent: Intent): Promise<void> {
  // Сильные слова в тексте важнее выбора LLM: глаголы изменения/удаления, «когда …?» (замер Qwen3, 2026-10-04)
  const intent = effectiveIntent(text, parsedIntent);
  // Даты — из исходного текста детерминированно; фрагменты от LLM — запасной вариант (ADR-0005 п.3)
  const localNow = formatMoment(utcToLocal(ctx.clock.now(), user.home_tz));
  switch (intent.name) {
    case "unsupported":
      await ctx.telegram.sendMessage(chatId, t("unsupported", user.locale));
      return;
    case "multiple":
      await ctx.telegram.sendMessage(chatId, t("oneAtATime", user.locale));
      return;
    case "create_event": {
      // Повторение (US-32): правило вырезаем целиком, длительность ищем в остатке
      const rec = extractRecurrenceSpan(text, localNow, user.home_tz);
      const spans = extractDateSpans(rec ? rec.rest : text, localNow, user.home_tz, "point");
      const startText = rec ? undefined : (spans.point ?? (intent.start || undefined));
      const durationText = spans.duration ?? intent.duration;
      const title = cleanTitle(
        intent.title,
        [rec?.span, ...(rec?.remove ?? []), rec ? intent.start : undefined, startText, durationText].filter((x): x is string => !!x),
      );
      const draft: CreateDraft = {
        ...draftFromIntent(intent),
        startText,
        recurrenceText: rec?.span,
        title,
        durationText,
        allDay: intent.allDay || looksAllDay(text) || undefined,
      };
      for (const k of Object.keys(draft) as (keyof CreateDraft)[]) if (draft[k] === undefined) delete draft[k];
      await withCalendar(ctx, user, chatId, (provider) => startCreate(ctx, provider, { user, chatId, conversationId, draft }));
      return;
    }
    case "modify_event":
    case "delete_event": {
      if (intent.name === "delete_event" && MASS_DELETE.test(text)) {
        await ctx.telegram.sendMessage(chatId, t("massDeleteUnsupported", user.locale));
        return;
      }
      // От LLM — только сам интент; что и как менять, определяем по тексту детерминированно:
      // Qwen3 не заполняет «event» и выдумывает reference/scope (замер 2026-10-04)
      const isModify = intent.name === "modify_event";
      const llmModify = intent.name === "modify_event" ? intent : undefined;
      // Место, описание, напоминания (US-41, US-42): вырезаем из фразы — остаток описывает само событие
      const details = isModify ? detailHints(text) : { rest: text };
      if (details.reminders && "error" in details.reminders) {
        await ctx.telegram.sendMessage(chatId, t(details.reminders.error === "tooMany" ? "remindersTooMany" : "remindersTooFar", user.locale));
        return;
      }
      const eventText = details.rest;
      const hints = modifyHints(eventText);
      const spans = extractModifySpans(eventText, localNow, user.home_tz);
      const newTitle = isModify ? (hints.newTitle ?? llmModify?.newTitle) : undefined;
      // Место: явное («место: …») — из текста; иначе — от LLM; «будет в офисе» — догадка, если LLM промолчала
      const newLocation = details.location ?? llmModify?.newLocation ?? details.locationGuess;
      const fragments = [spans.reference, spans.target, spans.shift, spans.duration].filter((x): x is string => !!x);
      const llmLocationInText =
        details.location === undefined && llmModify?.newLocation && eventText.toLowerCase().includes(llmModify.newLocation.toLowerCase());
      const queryText = llmLocationInText ? eventText.replace(new RegExp(escapeRe(llmModify!.newLocation!), "i"), " ") : eventText;
      const query = modifyQuery(queryText, fragments, newTitle) ?? intent.event;
      const changesDetails = newLocation !== undefined || !!details.description || !!details.reminders;
      // «Добавь место: кафе Пушкин» без указания события — про последнее созданное/изменённое (US-60)
      const reference = hints.reference ?? (changesDetails && !query && !spans.reference ? "last" : undefined);
      const request: EventRequest = {
        spans,
        ...(query ? { query } : {}),
        ...(reference ? { reference } : {}),
        ...(hints.listIndex ? { listIndex: hints.listIndex } : {}),
        ...(newTitle ? { newTitle } : {}),
        ...(newLocation !== undefined ? { newLocation } : {}),
        ...(details.description ? { newDescription: details.description.text, appendDescription: details.description.append } : {}),
        ...(details.reminders && "overrides" in details.reminders ? { reminders: { useDefault: false, overrides: details.reminders.overrides } } : {}),
        ...(hints.scope ? { scope: hints.scope } : {}),
      };
      await withCalendar(ctx, user, chatId, (provider) =>
        isModify
          ? startModify(ctx, provider, { user, chatId, conversationId, request })
          : startDelete(ctx, provider, { user, chatId, conversationId, request }),
      );
      return;
    }
    case "find_event": {
      const query = lookupQuery(text) ?? intent.event;
      const next = intent.next || NEXT_WORD.test(text);
      await withCalendar(ctx, user, chatId, (provider) =>
        lookupEvent(ctx, provider, { user, chatId, conversationId, ...(query ? { query } : {}), ...(next ? { next } : {}) }),
      );
      return;
    }
    case "list_events":
      // Список показан — повтор того же вопроса голосом не сигнал «не понял» (multimodal-voice, D)
      await mergeDialogState(ctx.db, conversationId, user.id, { lastVoice: undefined }, ctx.clock.now());
      await withCalendar(ctx, user, chatId, (provider) =>
        readEvents(ctx, provider, {
          userId: user.id,
          chatId,
          locale: user.locale,
          tz: user.home_tz,
          range: extractDateSpans(text, localNow, user.home_tz, "range").range ?? intent.range,
          conversationId,
          ...(intent.calendar ? { calendar: intent.calendar } : {}),
        }),
      );
      return;
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
