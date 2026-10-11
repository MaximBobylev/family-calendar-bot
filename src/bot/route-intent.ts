// Общий путь для текста, голоса и пересланного после «Выполнить». Даты и «что менять» — из текста детерминированно,
// от LLM — интент и второе мнение (ADR-0005).

import { parseDateFragment } from "../dates";
import { formatMoment, parseLocal, utcToLocal } from "../dates/calendar";
import { cleanTitle, extractDateSpans, extractModifySpans, extractRecurrenceSpan, looksAllDay } from "../dates/extract";
import { CONTEXT_TTL_MS, getDialogState, mergeDialogState } from "../db/conversations";
import { log } from "../log";
import { recordFeature } from "../db/features";
import type { User } from "../db/users";
import { detailHints } from "../nlu/detail-hints";
import { effectiveIntent, lookupQuery, NEXT_WORD } from "../nlu/intent-overrides";
import type { Intent } from "../nlu/intents";
import { MASS_DELETE, modifyHints, modifyQuery } from "../nlu/modify-hints";
import { listAssignedByMe, listAssignments } from "./assign/answers";
import { familyHints } from "./assign/family";
import { assignOverride } from "./assign/logic";
import { assignmentApplies, startAssign } from "./assign/start";
import type { AppContext } from "./context";
import { draftFromIntent, startCreate, type CreateDraft } from "./create-event";
import { llmDateCheck, withConversationDay } from "./create-logic";
import { startDelete } from "./delete-event";
import { lookupEvent } from "./event-lookup";
import type { EventRequest } from "./find-event";
import { t } from "./messages";
import { startModify } from "./modify-event";
import { startMulti } from "./multi-event";
import { createPieces, llmCalls } from "./multi-logic";
import { splitMessage } from "./multi-split";
import { readEvents } from "./read-events";
import { handleTimezoneIntent } from "./timezone";
import { withCalendar } from "./with-calendar";

export async function routeIntent(ctx: AppContext, user: User, chatId: number, conversationId: string, text: string, parsedIntent: Intent): Promise<void> {
  const localNow = formatMoment(utcToLocal(ctx.clock.now(), user.tz));
  if (await routeMulti(ctx, user, chatId, conversationId, text, parsedIntent, localNow)) return;
  // Слова в тексте важнее выбора LLM (замер Qwen3): глаголы изменения/удаления, «когда …?»; поручения — до остальных поправок
  const assign = assignOverride(text, parsedIntent);
  let intent = assign && (await assignmentApplies(ctx, user.id, assign, parsedIntent)) ? assign : effectiveIntent(text, parsedIntent);
  if (intent.name === "set_timezone" && intent.action === "trip") {
    const planned = plannedTripStart(text, localNow, user.tz);
    if (planned) intent = { name: "create_event", start: planned, ...(cleanTitle(text, [planned]) ? { title: cleanTitle(text, [planned])! } : {}) };
  }
  switch (intent.name) {
    case "unsupported":
      await ctx.telegram.sendMessage(chatId, t("unsupported", user.locale));
      return;
    case "multiple":
      await ctx.telegram.sendMessage(chatId, t("oneAtATime", user.locale));
      return;
    case "set_timezone":
      await handleTimezoneIntent(ctx, user, chatId, conversationId, intent);
      return;
    case "assign_task":
      await startAssign(ctx, user, chatId, conversationId, text, intent);
      return;
    case "list_assignments":
      if (intent.byMe) await listAssignedByMe(ctx, user, chatId);
      else await listAssignments(ctx, user, chatId, text);
      return;
    case "create_event": {
      // «…, отводит папа» — не часть названия и не дата
      const fam = await familyHints(ctx, user.id, text);
      const famText = fam.remove.reduce((s, r) => s.replace(r, " "), text);
      const rec = extractRecurrenceSpan(famText, localNow, user.tz);
      const spans = extractDateSpans(rec ? rec.rest : famText, localNow, user.tz, "point");
      // День разговора (US-60) LLM не видит — её второе мнение тогда не спрашиваем
      const state = !rec && spans.point ? await getDialogState(ctx.db, conversationId, user.id) : undefined;
      const fresh = state?.lastDay && ctx.clock.now() - state.lastDay.at < CONTEXT_TTL_MS ? state.lastDay.day : undefined;
      const inContext = spans.point ? withConversationDay(spans.point, fresh, parseLocal(localNow).day) : undefined;
      const point = inContext ?? spans.point;
      // Незнакомый пояс («в 15 по Варне») LLM тоже не пересчитает — спрашиваем время по своему поясу
      const llm = spans.unknownZone || inContext ? {} : { start: intent.start, ...(intent.when ? { when: intent.when } : {}) };
      const check = rec ? undefined : llmDateCheck(famText, point, llm, parseLocal(localNow), user.tz);
      if (check) {
        const unknownZone = spans.unknownZone ? true : undefined;
        log("date_check", {
          source: "message",
          llm: check.llm,
          agreement: check.agreement,
          unsure: spans.unsure,
          unknown_zone: unknownZone,
          ...(inContext ? { context_day: true } : {}),
        });
      }
      const start = check?.pick ?? {};
      const startText = start.startText;
      const durationText = spans.duration ?? intent.duration;
      const title = cleanTitle(
        intent.title,
        [
          rec?.span,
          ...(rec?.remove ?? []),
          rec ? intent.start : undefined,
          startText,
          ...(spans.pointParts ?? []),
          durationText,
          spans.unknownZone,
          ...fam.remove,
        ].filter((x): x is string => !!x),
      );
      const draft: CreateDraft = {
        ...draftFromIntent(intent),
        startText,
        altStartText: start.altStartText,
        altWhen: start.altWhen,
        recurrenceText: rec?.span,
        title,
        durationText,
        allDay: intent.allDay || looksAllDay(famText) || undefined,
        family: fam.family,
        unknownZone: spans.unknownZone,
        dateCheck: check ? { source: "message", agreement: check.agreement, llm: check.llm } : undefined,
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
      // От LLM — только сам интент: Qwen3 не заполняет «event» и выдумывает reference/scope (замер)
      const isModify = intent.name === "modify_event";
      const llmModify = intent.name === "modify_event" ? intent : undefined;
      // Детали вырезаем из фразы — остаток описывает само событие
      const details = isModify ? detailHints(text) : { rest: text };
      if (details.reminders && "error" in details.reminders) {
        await ctx.telegram.sendMessage(chatId, t(details.reminders.error === "tooMany" ? "remindersTooMany" : "remindersTooFar", user.locale));
        return;
      }
      const eventText = details.rest;
      const hints = modifyHints(eventText);
      const spans = extractModifySpans(eventText, localNow, user.tz);
      const newTitle = isModify ? (hints.newTitle ?? llmModify?.newTitle) : undefined;
      // Явное «место: …» — из текста; иначе — от LLM; «будет в офисе» — догадка, если LLM промолчала
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
      const found = await withCalendar(ctx, user, chatId, (provider) =>
        lookupEvent(ctx, provider, { user, chatId, conversationId, ...(query ? { query } : {}), ...(next ? { next } : {}) }),
      );
      if (found) await recordFeature(ctx.db, user.id, "find", ctx.clock.now());
      return;
    }
    case "list_events": {
      // Повтор того же вопроса голосом после списка — уже не сигнал «не понял»
      await mergeDialogState(ctx.db, conversationId, user.id, { lastVoice: undefined }, ctx.clock.now());
      const listed = await withCalendar(ctx, user, chatId, (provider) =>
        readEvents(ctx, provider, {
          userId: user.id,
          chatId,
          locale: user.locale,
          tz: user.tz,
          range: extractDateSpans(text, localNow, user.tz, "range").range ?? intent.range,
          conversationId,
          ...(intent.calendar ? { calendar: intent.calendar } : {}),
        }),
      );
      if (listed) await recordFeature(ctx.db, user.id, "list", ctx.clock.now());
      return;
    }
  }
}

// Делитель — до поправок интента (ADR-0008 п.2): «удали» во втором деле иначе превратило бы всё сообщение в удаление,
// а «отводит папа» при multiple схлопнуло бы его в первое событие
async function routeMulti(
  ctx: AppContext,
  user: User,
  chatId: number,
  conversationId: string,
  text: string,
  parsed: Intent,
  localNow: string,
): Promise<boolean> {
  if (parsed.name !== "create_event" && parsed.name !== "multiple" && parsed.name !== "unsupported") return false;
  const pieces = splitMessage(text, localNow, user.tz);
  const creates = createPieces(pieces);
  if (creates.length === 0 || (creates.length === 1 && !pieces.some((p) => p.action === "other"))) return false;
  const assign = assignOverride(text, parsed);
  if (assign && assign.name !== "create_event") return false;
  let handled = false;
  const ok = await withCalendar(ctx, user, chatId, async (provider) => {
    handled = await startMulti(ctx, provider, { user, chatId, conversationId, pieces, calls: llmCalls(parsed) });
  });
  return handled || !ok;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// «Поездка в Казань с 5 по 8 декабря» — планы (событие), а не «я сейчас там»
function plannedTripStart(text: string, localNow: string, tz: string): string | undefined {
  const point = extractDateSpans(text, localNow, tz, "point").point;
  if (!point) return undefined;
  const r = parseDateFragment({ text: point, kind: "point", now: localNow, tz });
  if ("error" in r) return undefined;
  const v = "ambiguous" in r ? r.ambiguous[0]! : r;
  const start =
    "datetime" in v
      ? v.datetime
      : "interval" in v
        ? v.interval.start
        : "range" in v
          ? v.range.from
          : "date" in v
            ? typeof v.date === "string"
              ? v.date
              : v.date.date
            : undefined;
  return start && start.slice(0, 10) > localNow.slice(0, 10) ? point : undefined;
}
