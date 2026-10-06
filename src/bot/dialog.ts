// Диалоговый слой до LLM: /connect, /settings, ответ на вопрос о названии (US-30), ответы на «Во сколько?» и ввод
// настроек (dialog_state.awaiting), отмена открытых карточек (US-05), «отмени последнее» (US-61), поводы
// переслушать голосовое. Остальное — шаг NLU (nlu-step.ts) и routeIntent.

import { parseDateFragment } from "../dates";
import { formatMoment, utcToLocal } from "../dates/calendar";
import { looksAllDay } from "../dates/extract";
import { cancelOpenCards, claimPendingAction, findOpenByMessage, getDialogState, mergeDialogState, type PendingAction } from "../db/conversations";
import type { User } from "../db/users";
import { effectiveIntent } from "../nlu/intent-overrides";
import { BARE_CANCEL, UNDO_PHRASE } from "../nlu/modify-hints";
import { isNotRight, NOT_RIGHT_WINDOW_MS, REPEAT_WINDOW_MS, similarTranscripts } from "../voice/signals";
import type { AppContext } from "./context";
import { CREATE_CARD, startCreate, TITLE_QUESTION, type CreateDraft, type TitleQuestionPayload } from "./create-event";
import { DELETE_CARD } from "./delete-event";
import { DISCONNECT_CARD } from "./disconnect";
import { PICK_CARD } from "./find-event";
import { escapeHtml } from "./format";
import { FORWARD_CARD } from "./forwarded";
import { t } from "./messages";
import { MODIFY_CARD } from "./modify-event";
import { parseCommandIntent } from "./nlu-step";
import { routeIntent } from "./route-intent";
import { sendReconnect, showSettings } from "./settings/common";
import { handleSettingsInput } from "./settings/input";
import { attachUndoMessage, recordUndo, undoLast } from "./undo";
import { escalateVoice } from "./voice-rehear";
import { withCalendar } from "./with-calendar";

/** Новая команда аннулирует открытые карточки (US-05): сообщения карточек — в «Отменено». */
export async function cancelCards(ctx: AppContext, user: User, conversationId: string): Promise<PendingAction[]> {
  const cancelled = await cancelOpenCards(ctx.db, conversationId, user.id, [
    CREATE_CARD,
    TITLE_QUESTION,
    MODIFY_CARD,
    PICK_CARD,
    DELETE_CARD,
    DISCONNECT_CARD,
    FORWARD_CARD,
  ]);
  for (const c of cancelled) {
    const cardChat = (c.payload as { chatId?: number }).chatId;
    if (c.kind !== TITLE_QUESTION && c.messageId && cardChat) await ctx.telegram.editMessageText(cardChat, c.messageId, t("cancelled", user.locale));
  }
  return cancelled;
}

/** Команда текстом (или распознанное голосовое, или пересланное после «Выполнить»): от /settings до routeIntent. */
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

  // Ответ (reply) на вопрос о названии — переименовать созданное событие (US-30)
  if (opts.replyTo) {
    const q = await findOpenByMessage<TitleQuestionPayload>(ctx.db, conversationId, user.id, TITLE_QUESTION, opts.replyTo, ctx.clock.now());
    if (q && (await claimPendingAction(ctx.db, q.id, user.id, ctx.clock.now())).ok) {
      await withCalendar(ctx, user, chatId, async (provider) => {
        const res = await provider.updateEvent(q.payload.ref, { tz: user.home_tz, title: text }, { notify: false });
        const undo = await recordUndo(ctx, {
          conversationId,
          user,
          chatId,
          record: {
            kind: "update",
            ref: q.payload.ref,
            tz: user.home_tz,
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

  // Ответ на «Во сколько?» / «Когда поставить?» дополняет черновик (US-12)
  const state = await getDialogState(ctx.db, conversationId, user.id);
  if (state.awaiting) {
    await mergeDialogState(ctx.db, conversationId, user.id, { awaiting: undefined }, ctx.clock.now());
    if (state.awaiting.expiresAt > ctx.clock.now() && state.awaiting.kind !== "create_time") {
      if (await handleSettingsInput(ctx, user, chatId, state.awaiting, text)) return;
    }
    if (state.awaiting.kind === "create_time" && state.awaiting.expiresAt > ctx.clock.now()) {
      const draft = completeDraft(state.awaiting.draft as CreateDraft, text, formatMoment(utcToLocal(ctx.clock.now(), user.home_tz)), user.home_tz);
      if (draft) {
        await withCalendar(ctx, user, chatId, (provider) => startCreate(ctx, provider, { user, chatId, conversationId, draft }));
        return;
      }
      // Не похоже на время — это новая команда
    }
  }

  const cancelled = await cancelCards(ctx, user, conversationId);

  // «Отмени последнее» — отмена действия (US-61); голое «отмена» при открытой карточке — отмена карточки
  if (UNDO_PHRASE.test(text)) {
    const hadCards = cancelled.some((c) => c.kind !== TITLE_QUESTION);
    if (!(BARE_CANCEL.test(text) && hadCards)) {
      await withCalendar(ctx, user, chatId, (provider) => undoLast(ctx, provider, user, conversationId, chatId));
    }
    return;
  }

  // Голосовое, которое текстовый путь, похоже, не понял, — переслушать мультимодальной моделью (multimodal-voice, D)
  const nowMs = ctx.clock.now();
  const prevVoice = state.lastVoice;
  if (voice) {
    const current = { ...voice, transcript: text, at: nowMs };
    await mergeDialogState(ctx.db, conversationId, user.id, { lastVoice: current }, nowMs);
    // Повтор той же фразы — Whisper, скорее всего, снова ошибся
    if (prevVoice && nowMs - prevVoice.at < REPEAT_WINDOW_MS && similarTranscripts(prevVoice.transcript, text)) {
      if (await escalateVoice(ctx, user, chatId, conversationId, current)) return;
    }
  }
  // «Не так» — переслушать предыдущее голосовое
  if (isNotRight(text) && prevVoice && nowMs - prevVoice.at < NOT_RIGHT_WINDOW_MS) {
    if (await escalateVoice(ctx, user, chatId, conversationId, prevVoice)) return;
  }

  const intent = await parseCommandIntent(ctx, user, chatId, text);
  if (!intent) return;

  // Голосовое, на которое текстовый путь сказал бы «не понимаю», — сначала переслушать
  if (voice && effectiveIntent(text, intent).name === "unsupported") {
    if (await escalateVoice(ctx, user, chatId, conversationId, { ...voice, transcript: text, at: nowMs })) return;
  }
  await routeIntent(ctx, user, chatId, conversationId, text, intent);
}

/** Ответ на «Во сколько?» / «Когда поставить?»: дополненный черновик или undefined, если это не время. */
function completeDraft(draft: CreateDraft, text: string, now: string, tz: string): CreateDraft | undefined {
  // «Весь день» в ответ на «Во сколько?» (US-31)
  if ((draft.startText || draft.recurrenceText) && looksAllDay(text)) return { ...draft, allDay: true };
  // Серия без времени: «в 10» дополняет правило (US-32)
  if (draft.recurrenceText) {
    const recurrenceText = `${draft.recurrenceText} ${/^\d/.test(text) ? `в ${text}` : text}`;
    const probe = parseDateFragment({ text: recurrenceText, kind: "recurrence", now, tz });
    return "recurrence" in probe && probe.recurrence.time ? { ...draft, recurrenceText } : undefined;
  }
  const combined = draft.startText ? `${draft.startText} ${text}` : text;
  const probe = parseDateFragment({ text: combined, kind: "point", now, tz });
  return !("error" in probe) || probe.error === "in_past" ? { ...draft, startText: combined } : undefined;
}
