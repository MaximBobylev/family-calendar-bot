// Обработка одного апдейта: доступ, регистрация, привязка календаря, команды.

import { GoogleCalendarProvider } from "../calendar/google-provider";
import { parseDateFragment } from "../dates";
import { formatMoment, utcToLocal } from "../dates/calendar";
import { cleanTitle, extractDateSpans, extractModifySpans, looksAllDay } from "../dates/extract";
import { BARE_CANCEL, DELETE_VERBS, MASS_DELETE, MODIFY_VERBS, UNDO_PHRASE, modifyHints, modifyQuery } from "../nlu/modify-hints";
import { hasGoogleAccount } from "../db/accounts";
import {
  cancelOpenCards, claimPendingAction, ensureConversation, findOpenByMessage, getDialogState, mergeDialogState, type PendingAction,
} from "../db/conversations";
import { recordUsage } from "../db/usage";
import { ensureTelegramUser, type User } from "../db/users";
import { GoogleAuthError } from "../google/auth";
import { GoogleApiError } from "../google/calendar-api";
import { parseIntent, type ParsedIntent } from "../nlu/intents";
import type { TgCallbackQuery, TgMessage, TgUpdate } from "../telegram/types";
import type { AppContext } from "./context";
import {
  CREATE_CARD, TITLE_QUESTION, confirmCreate, draftFromIntent, startCreate,
  type CreateCardPayload, type CreateDraft, type TitleQuestionPayload,
} from "./create-event";
import { DELETE_CARD, confirmDelete, proposeDelete, startDelete } from "./delete-event";
import { PICK_CARD, confirmPick, type EventRequest } from "./find-event";
import { MODIFY_CARD, confirmModify, proposeChange, startModify } from "./modify-event";
import { connectKeyboard, parseCallbackData } from "./keyboards";
import { t } from "./messages";
import { escapeHtml } from "./format";
import { UNDO_CARD, attachUndoMessage, performUndo, recordUndo, undoLast } from "./undo";
import { readEvents } from "./read-events";
import { isEmptySpeech, transcribe, type Transcript } from "../stt/whisper";

export async function handleUpdate(ctx: AppContext, update: TgUpdate): Promise<void> {
  // Отредактированные сообщения игнорируем (US-10)
  if (update.edited_message) return;

  const message = update.message;
  const from = message?.from ?? update.callback_query?.from;
  if (!from || from.is_bot) return;
  const lang = from.language_code ?? "ru";

  if (message && message.chat.type !== "private") {
    await ctx.telegram.sendMessage(message.chat.id, t("privateOnly", lang));
    return;
  }

  // Доступ проверяется до любой обработки (US-01, ADR-0001)
  if (!ctx.config.allowedTelegramIds.has(String(from.id))) {
    if (message) await ctx.telegram.sendMessage(message.chat.id, t("notAllowed", lang));
    return;
  }

  const { user } = await ensureTelegramUser(ctx.db, from.id, ctx.clock.now());
  if (update.callback_query) {
    await handleCallback(ctx, user, update.callback_query);
    return;
  }
  if (!message) return;
  const isStart = message.text?.trim() === "/start";

  // Без привязанного календаря интент не распознаём — только предлагаем подключить (US-01)
  if (!(await hasGoogleAccount(ctx.db, user.id))) {
    const text = isStart ? `${t("welcome", user.locale)}\n\n${t("connectPrompt", user.locale)}` : t("connectPrompt", user.locale);
    await ctx.telegram.sendMessage(message.chat.id, text, await connectKeyboard(ctx, user.id, user.locale));
    return;
  }

  if (isStart) {
    await ctx.telegram.sendMessage(message.chat.id, t("welcome", user.locale));
    return;
  }
  await handleCommand(ctx, user, message);
}

async function handleCommand(ctx: AppContext, user: User, message: TgMessage): Promise<void> {
  const chatId = message.chat.id;
  // «печатает…» сразу: дальше LLM и Google (US-10). Не критично — ошибку игнорируем
  if (!ctx.config.testMode) await ctx.telegram.sendChatAction(chatId);
  const conversationId = await ensureConversation(ctx.db, chatId, "private");
  let text = message.text?.trim();
  if (!text && (message.voice || message.audio)) {
    text = (await recognizeVoice(ctx, user, message)) ?? undefined;
    if (!text) return;
  }
  if (!text) {
    // Фото, файлы и прочее — позже (US-66)
    await ctx.telegram.sendMessage(chatId, t("notImplemented", user.locale));
    return;
  }

  // Ответ (reply) на вопрос о названии — переименовать созданное событие (US-30)
  if (message.reply_to_message) {
    const q = await findOpenByMessage<TitleQuestionPayload>(ctx.db, conversationId, user.id, TITLE_QUESTION, message.reply_to_message.message_id, ctx.clock.now());
    if (q && (await claimPendingAction(ctx.db, q.id, user.id, ctx.clock.now())).ok) {
      await withCalendar(ctx, user, chatId, async (provider) => {
        const res = await provider.updateEvent(q.payload.ref, { tz: user.home_tz, title: text }, { notify: false });
        const undo = await recordUndo(ctx, {
          conversationId, user, chatId,
          record: { kind: "update", ref: q.payload.ref, tz: user.home_tz, notify: false, before: { title: q.payload.title ?? t("defaultTitle", user.locale) }, ...(res.etag ? { etag: res.etag } : {}) },
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
    if (state.awaiting.expiresAt > ctx.clock.now()) {
      const draft = state.awaiting.draft as CreateDraft;
      // «Весь день» в ответ на «Во сколько?» (US-31)
      if (draft.startText && looksAllDay(text)) {
        await withCalendar(ctx, user, chatId, (provider) => startCreate(ctx, provider, { user, chatId, conversationId, draft: { ...draft, allDay: true } }));
        return;
      }
      const combined = draft.startText ? `${draft.startText} ${text}` : text;
      const now = formatMoment(utcToLocal(ctx.clock.now(), user.home_tz));
      const probe = parseDateFragment({ text: combined, kind: "point", now, tz: user.home_tz });
      if (!("error" in probe) || probe.error === "in_past") {
        await withCalendar(ctx, user, chatId, (provider) => startCreate(ctx, provider, { user, chatId, conversationId, draft: { ...draft, startText: combined } }));
        return;
      }
      // Не похоже на время — это новая команда
    }
  }

  // Новая команда аннулирует открытые карточки (US-05)
  const cancelled = await cancelOpenCards(ctx.db, conversationId, user.id, [CREATE_CARD, TITLE_QUESTION, MODIFY_CARD, PICK_CARD, DELETE_CARD]);
  for (const c of cancelled) {
    const cardChat = (c.payload as { chatId?: number }).chatId;
    if (c.kind !== TITLE_QUESTION && c.messageId && cardChat) await ctx.telegram.editMessageText(cardChat, c.messageId, t("cancelled", user.locale));
  }

  // «Отмени последнее» — отмена действия (US-61); голое «отмена» при открытой карточке — отмена карточки
  if (UNDO_PHRASE.test(text)) {
    const hadCards = cancelled.some((c) => c.kind !== TITLE_QUESTION);
    if (!(BARE_CANCEL.test(text) && hadCards)) {
      await withCalendar(ctx, user, chatId, (provider) => undoLast(ctx, provider, user, conversationId, chatId));
    }
    return;
  }

  const calendarNames = await ctx.db
    .prepare(
      `SELECT c.title AS name FROM calendars c JOIN provider_accounts a ON a.id = c.account_id WHERE a.user_id = ?1
       UNION SELECT alias FROM calendar_aliases WHERE user_id = ?1`,
    )
    .bind(user.id)
    .all<{ name: string }>();

  let parsed: ParsedIntent;
  try {
    // Команда — короткая фраза; длинный текст в LLM не шлём (стоимость, prompt injection)
    parsed = await parseIntent(ctx.config.llm, text.slice(0, 500), { calendars: calendarNames.results.map((r) => r.name) });
  } catch (e) {
    console.error("llm failed", e);
    await recordUsage(ctx.db, { userId: user.id, kind: "llm", provider: ctx.config.llm.baseUrl, model: ctx.config.llm.model, text, result: String(e), outcome: "error", now: ctx.clock.now() });
    await ctx.telegram.sendMessage(chatId, t("llmUnavailable", user.locale));
    return;
  }
  await recordUsage(ctx.db, {
    userId: user.id, kind: "llm", provider: ctx.config.llm.baseUrl, model: ctx.config.llm.model,
    tokensIn: parsed.tokensIn, tokensOut: parsed.tokensOut, text, result: parsed.intent, outcome: "ok", now: ctx.clock.now(),
  });

  let intent = parsed.intent;
  // Сильные глаголы — это изменение/удаление, даже если LLM решила иначе (замер Qwen3, 2026-10-04)
  if (intent.name !== "multiple") {
    if (DELETE_VERBS.test(text)) {
      if (intent.name !== "delete_event") intent = { name: "delete_event" };
    } else if (intent.name !== "modify_event" && MODIFY_VERBS.test(text)) intent = { name: "modify_event" };
  }
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
      const spans = extractDateSpans(text, localNow, user.home_tz, "point");
      const startText = spans.point ?? (intent.start || undefined);
      const durationText = spans.duration ?? intent.duration;
      const title = cleanTitle(intent.title, [startText, durationText].filter((x): x is string => !!x));
      const draft: CreateDraft = {
        ...draftFromIntent(intent),
        startText,
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
      const hints = modifyHints(text);
      const spans = extractModifySpans(text, localNow, user.home_tz);
      const isModify = intent.name === "modify_event";
      const llmModify = intent.name === "modify_event" ? intent : undefined;
      const newTitle = isModify ? (hints.newTitle ?? llmModify?.newTitle) : undefined;
      const fragments = [spans.reference, spans.target, spans.shift, spans.duration].filter((x): x is string => !!x);
      const query = modifyQuery(text, fragments, newTitle) ?? intent.event;
      const request: EventRequest = {
        spans,
        ...(query ? { query } : {}),
        ...(hints.reference ? { reference: hints.reference } : {}),
        ...(hints.listIndex ? { listIndex: hints.listIndex } : {}),
        ...(newTitle ? { newTitle } : {}),
        ...(llmModify?.newLocation ? { newLocation: llmModify.newLocation } : {}),
        ...(hints.scope ? { scope: hints.scope } : {}),
      };
      await withCalendar(ctx, user, chatId, (provider) =>
        isModify
          ? startModify(ctx, provider, { user, chatId, conversationId, request })
          : startDelete(ctx, provider, { user, chatId, conversationId, request }),
      );
      return;
    }
    case "list_events":
      await withCalendar(ctx, user, chatId, (provider) =>
        readEvents(ctx, provider, {
          userId: user.id, chatId, locale: user.locale, tz: user.home_tz,
          range: extractDateSpans(text, localNow, user.home_tz, "range").range ?? intent.range,
          conversationId,
          ...(intent.calendar ? { calendar: intent.calendar } : {}),
        }),
      );
      return;
  }
}

const MAX_VOICE_SEC = 60;
/** duration указывает отправитель; размер ограничиваем отдельно (≈1 мин Opus — ~200 КБ). */
const MAX_VOICE_BYTES = 2 * 1024 * 1024;

/** Голосовое → текст (US-10). null — уже ответили пользователю (слишком длинное, не расслышал, ошибка). */
async function recognizeVoice(ctx: AppContext, user: User, message: TgMessage): Promise<string | null> {
  const chatId = message.chat.id;
  const voice = (message.voice ?? message.audio)!;
  // Длинное — отказ без скачивания и без затрат на STT
  if (voice.duration > MAX_VOICE_SEC || (voice.file_size ?? 0) > MAX_VOICE_BYTES) {
    await ctx.telegram.sendMessage(chatId, t("voiceTooLong", user.locale));
    return null;
  }
  let audio: ArrayBuffer;
  try {
    audio = await ctx.telegram.downloadFile(voice.file_id);
  } catch (e) {
    console.error("voice download failed", e);
    await ctx.telegram.sendMessage(chatId, t("voiceDownloadFailed", user.locale));
    return null;
  }
  const usage = { userId: user.id, kind: "stt" as const, provider: ctx.config.stt.baseUrl, model: ctx.config.stt.model, audioMs: voice.duration * 1000 };
  let transcript: Transcript;
  try {
    transcript = await transcribe(ctx.config.stt, audio);
  } catch (e) {
    console.error("stt failed", e);
    await recordUsage(ctx.db, { ...usage, result: String(e), outcome: "error", now: ctx.clock.now() });
    await ctx.telegram.sendMessage(chatId, t("sttUnavailable", user.locale));
    return null;
  }
  await recordUsage(ctx.db, { ...usage, text: transcript.text, result: { language: transcript.language }, outcome: "ok", now: ctx.clock.now() });
  if (isEmptySpeech(transcript.text)) {
    await ctx.telegram.sendMessage(chatId, t("notHeard", user.locale));
    return null;
  }
  // Показываем, что услышали, — до долгой обработки (US-10)
  await ctx.telegram.sendMessage(chatId, t("heard", user.locale, { text: escapeHtml(transcript.text) }), undefined, { html: true });
  return transcript.text;
}

/** Нажатие кнопки на карточке: атомарно «забираем» карточку — повторное нажатие ничего не делает (US-05). */
async function handleCallback(ctx: AppContext, user: User, cq: TgCallbackQuery): Promise<void> {
  const parsed = parseCallbackData(cq.data);
  if (!parsed) {
    await ctx.telegram.answerCallbackQuery(cq.id);
    return;
  }
  const claim = await claimPendingAction(ctx.db, parsed.actionId, user.id, ctx.clock.now());
  if (!claim.ok) {
    const stale = claim.reason !== "done";
    await ctx.telegram.answerCallbackQuery(cq.id, t(stale ? "cardExpired" : "alreadyDone", user.locale));
    if (stale && cq.message) await ctx.telegram.editMessageText(cq.message.chat.id, cq.message.message_id, t("cardExpired", user.locale));
    return;
  }
  await ctx.telegram.answerCallbackQuery(cq.id);
  const chatId = cq.message?.chat.id ?? cq.from.id;
  const action = claim.action;
  const ok = await withCalendar(ctx, user, chatId, async (provider) => {
    if (action.kind === CREATE_CARD) await confirmCreate(ctx, provider, user, action as PendingAction<CreateCardPayload>, parsed.choice);
    else if (action.kind === MODIFY_CARD) await confirmModify(ctx, provider, user, action as Parameters<typeof confirmModify>[3], parsed.choice);
    else if (action.kind === UNDO_CARD) await performUndo(ctx, provider, user, action as Parameters<typeof performUndo>[3]);
    else if (action.kind === DELETE_CARD) await confirmDelete(ctx, provider, user, action as Parameters<typeof confirmDelete>[3], parsed.choice);
    else if (action.kind === PICK_CARD) {
      const picked = await confirmPick(ctx, provider, user, action as Parameters<typeof confirmPick>[3], parsed.choice);
      if (picked?.purpose === "modify") await proposeChange(ctx, provider, user, picked.chatId, action.conversationId, picked.event, picked.request);
      if (picked?.purpose === "delete") await proposeDelete(ctx, provider, user, picked.chatId, action.conversationId, picked.event, picked.request);
    }
  });
  // Карточка уже «done»: при сбое убираем кнопки, чтобы не было «Уже сделано» на несделанном (ревью 2026-10-05)
  if (!ok && action.messageId) await ctx.telegram.editMessageText(chatId, action.messageId, t("actionFailed", user.locale));
}

/**
 * Ошибки календаря — понятным текстом (US-14); отозванный доступ — предложить переподключить (US-02).
 * Прочие ошибки (Telegram, D1, баги) не выдаём за «Google не отвечает» (ревью 2026-10-05).
 * Возвращает false, если действие не удалось.
 */
async function withCalendar(
  ctx: AppContext,
  user: User,
  chatId: number,
  action: (provider: GoogleCalendarProvider) => Promise<void>,
): Promise<boolean> {
  try {
    await action(new GoogleCalendarProvider(ctx.config, ctx.db, user.id));
    return true;
  } catch (e) {
    console.error("calendar action failed", e instanceof Error ? e.message : e);
    if (e instanceof GoogleAuthError && e.revoked) {
      await ctx.telegram.sendMessage(chatId, t("googleRevoked", user.locale), await connectKeyboard(ctx, user.id, user.locale));
    } else if (e instanceof GoogleAuthError || e instanceof GoogleApiError) {
      await ctx.telegram.sendMessage(chatId, t("googleUnavailable", user.locale));
    } else {
      await ctx.telegram.sendMessage(chatId, t("internalError", user.locale)).catch(() => undefined);
    }
    return false;
  }
}
