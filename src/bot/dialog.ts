// Всё, что решается до LLM: ответы на вопросы бота, отмена карточек, «отмени последнее», поводы переслушать голосовое.

import { parseDateFragment } from "../dates";
import { formatMoment, utcToLocal } from "../dates/calendar";
import { looksAllDay } from "../dates/extract";
import { cancelOpenCards, claimPendingAction, findOpenByMessage, getDialogState, hasOpenCard, mergeDialogState, type PendingAction } from "../db/conversations";
import type { User } from "../db/users";
import { effectiveIntent } from "../nlu/intent-overrides";
import { BARE_CANCEL, UNDO_PHRASE } from "../nlu/modify-hints";
import { isNotRight, NOT_RIGHT_WINDOW_MS, REPEAT_WINDOW_MS, similarTranscripts } from "../voice/signals";
import type { AppContext } from "./context";
import { CREATE_CARD, startCreate, TITLE_QUESTION, type CreateDraft, type TitleQuestionPayload } from "./create-event";
import { ASSIGN_CARD, ASSIGN_WHO_CARD } from "./assign/start";
import { DELETE_CARD } from "./delete-event";
import { DISCONNECT_CARD } from "./disconnect";
import { PICK_CARD } from "./find-event";
import { escapeHtml } from "./format";
import { FORWARD_CARD } from "./forwarded";
import { ICS_CARD } from "./ingest";
import { t } from "./messages";
import { MODIFY_CARD } from "./modify-event";
import { MULTI_CARD, ordinalLead } from "./multi-logic";
import { parseCommandIntent } from "./nlu-step";
import { routeIntent } from "./route-intent";
import { sendReconnect, showSettings } from "./settings/common";
import { handleSettingsInput } from "./settings/input";
import { handleSettingsCommand } from "./settings/voice";
import { attachUndoMessage, recordUndo, undoLast } from "./undo";
import { answerTripUntil, handleTimezoneCommand } from "./timezone";
import { escalateVoice } from "./voice-rehear";
import { withCalendar } from "./with-calendar";

export async function cancelCards(ctx: AppContext, user: User, conversationId: string): Promise<PendingAction[]> {
  const cancelled = await cancelOpenCards(ctx.db, conversationId, user.id, [
    CREATE_CARD,
    TITLE_QUESTION,
    MODIFY_CARD,
    PICK_CARD,
    DELETE_CARD,
    DISCONNECT_CARD,
    FORWARD_CARD,
    ICS_CARD,
    ASSIGN_CARD,
    ASSIGN_WHO_CARD,
    MULTI_CARD,
  ]);
  for (const c of cancelled) {
    const cardChat = (c.payload as { chatId?: number }).chatId;
    if (c.kind !== TITLE_QUESTION && c.messageId && cardChat) await ctx.telegram.editMessageText(cardChat, c.messageId, t("cancelled", user.locale));
  }
  return cancelled;
}

export async function runCommand(
  ctx: AppContext,
  user: User,
  chatId: number,
  conversationId: string,
  text: string,
  opts: { voice?: { fileId: string; durationSec: number }; replyTo?: number } = {},
): Promise<void> {
  const { voice } = opts;
  if (/^\/connect(@\w+)?$/i.test(text)) {
    await sendReconnect(ctx, user, chatId);
    return;
  }
  if (/^\/settings(@\w+)?$/i.test(text) || /^(настройки|settings)$/i.test(text)) {
    await showSettings(ctx, user, chatId);
    return;
  }

  if (opts.replyTo) {
    const q = await findOpenByMessage<TitleQuestionPayload>(ctx.db, conversationId, user.id, TITLE_QUESTION, opts.replyTo, ctx.clock.now());
    if (q && (await claimPendingAction(ctx.db, q.id, user.id, ctx.clock.now())).ok) {
      await withCalendar(ctx, user, chatId, async (provider) => {
        const res = await provider.updateEvent(q.payload.ref, { tz: user.tz, title: text }, { notify: false });
        const undo = await recordUndo(ctx, {
          conversationId,
          user,
          chatId,
          record: {
            kind: "update",
            ref: q.payload.ref,
            tz: user.tz,
            notify: false,
            before: { title: q.payload.title ?? t("defaultTitle", user.locale) },
            ...(res.etag ? { etag: res.etag } : {}),
          },
          summary: `<b>${escapeHtml(text)}</b> → <b>${escapeHtml(q.payload.title ?? t("defaultTitle", user.locale))}</b>`,
        });
        const sent = await ctx.telegram.sendMessage(chatId, t("renamed", user.locale, { title: text }), { inline_keyboard: [[undo.button]] });
        await attachUndoMessage(ctx.db, undo.undoId, sent.message_id);
      });
      return;
    }
  }

  const state = await getDialogState(ctx.db, conversationId, user.id);
  if (state.awaiting) {
    await mergeDialogState(ctx.db, conversationId, user.id, { awaiting: undefined }, ctx.clock.now());
    const aw = state.awaiting;
    if (aw.expiresAt > ctx.clock.now() && (aw.kind === "settings_tz" || aw.kind === "settings_digest_time" || aw.kind === "settings_alias")) {
      if (await handleSettingsInput(ctx, user, chatId, aw, text)) return;
    }
    // Не дата — дальше как новая команда
    if (aw.kind === "trip_until" && aw.expiresAt > ctx.clock.now() && (await answerTripUntil(ctx, user, chatId, text))) return;
    if (state.awaiting.kind === "create_time" && state.awaiting.expiresAt > ctx.clock.now()) {
      const draft = completeDraft(state.awaiting.draft as CreateDraft, text, formatMoment(utcToLocal(ctx.clock.now(), user.tz)), user.tz);
      if (draft) {
        await withCalendar(ctx, user, chatId, (provider) => startCreate(ctx, provider, { user, chatId, conversationId, draft }));
        return;
      }
      // Не похоже на время — это новая команда
    }
  }

  // «второе — в 13» при открытой карточке-списке: правку словами не делаем (US-62), но и не отменяем карточку,
  // и не переносим чужое событие из последнего списка (US-60)
  if (ordinalLead(text) && (await hasOpenCard(ctx.db, conversationId, user.id, MULTI_CARD, ctx.clock.now()))) {
    await ctx.telegram.sendMessage(chatId, t("multiOrdinalHint", user.locale));
    return;
  }

  const cancelled = await cancelCards(ctx, user, conversationId);

  // Голое «отмена» при открытой карточке — отмена карточки, а не последнего действия
  if (UNDO_PHRASE.test(text)) {
    const hadCards = cancelled.some((c) => c.kind !== TITLE_QUESTION);
    if (!(BARE_CANCEL.test(text) && hadCards)) {
      await withCalendar(ctx, user, chatId, (provider) => undoLast(ctx, provider, user, conversationId, chatId));
    }
    return;
  }

  if (await handleTimezoneCommand(ctx, user, chatId, conversationId, text)) return;
  if (await handleSettingsCommand(ctx, user, chatId, text)) return;

  const nowMs = ctx.clock.now();
  const prevVoice = state.lastVoice;
  if (voice) {
    const current = { ...voice, transcript: text, at: nowMs };
    await mergeDialogState(ctx.db, conversationId, user.id, { lastVoice: current }, nowMs);
    // Повтор той же фразы — Whisper, скорее всего, снова ошибся. То же голосовое (повтор апдейта после сбоя) — не повтор
    const repeated = prevVoice && prevVoice.fileId !== voice.fileId && nowMs - prevVoice.at < REPEAT_WINDOW_MS;
    if (repeated && similarTranscripts(prevVoice.transcript, text)) {
      if (await escalateVoice(ctx, user, chatId, conversationId, current)) return;
    }
  }
  if (isNotRight(text) && prevVoice && nowMs - prevVoice.at < NOT_RIGHT_WINDOW_MS) {
    if (await escalateVoice(ctx, user, chatId, conversationId, prevVoice)) return;
  }

  const intent = await parseCommandIntent(ctx, user, chatId, text);
  if (!intent) return;

  if (voice && effectiveIntent(text, intent).name === "unsupported") {
    if (await escalateVoice(ctx, user, chatId, conversationId, { ...voice, transcript: text, at: nowMs })) return;
  }
  await routeIntent(ctx, user, chatId, conversationId, text, intent);
}

function completeDraft(draft: CreateDraft, text: string, now: string, tz: string): CreateDraft | undefined {
  if ((draft.startText || draft.recurrenceText) && looksAllDay(text)) return { ...draft, allDay: true };
  if (draft.recurrenceText) {
    const recurrenceText = `${draft.recurrenceText} ${/^\d/.test(text) ? `в ${text}` : text}`;
    const probe = parseDateFragment({ text: recurrenceText, kind: "recurrence", now, tz });
    return "recurrence" in probe && probe.recurrence.time ? { ...draft, recurrenceText } : undefined;
  }
  const combined = draft.startText ? `${draft.startText} ${text}` : text;
  const probe = parseDateFragment({ text: combined, kind: "point", now, tz });
  return !("error" in probe) || probe.error === "in_past" ? { ...draft, startText: combined } : undefined;
}
