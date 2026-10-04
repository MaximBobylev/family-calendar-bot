// Обработка одного апдейта: доступ, регистрация, привязка календаря, команды.

import { GoogleCalendarProvider } from "../calendar/google-provider";
import { parseDateFragment } from "../dates";
import { formatMoment, utcToLocal } from "../dates/calendar";
import { cleanTitle, extractDateSpans, looksAllDay } from "../dates/extract";
import { hasGoogleAccount } from "../db/accounts";
import {
  claimPendingAction, ensureConversation, findOpenByMessage, getDialogState, setDialogState, type PendingAction,
} from "../db/conversations";
import { recordUsage } from "../db/usage";
import { ensureTelegramUser, type User } from "../db/users";
import { GoogleAuthError } from "../google/auth";
import { parseIntent, type ParsedIntent } from "../nlu/intents";
import type { TgCallbackQuery, TgMessage, TgUpdate } from "../telegram/types";
import type { AppContext } from "./context";
import {
  CREATE_CARD, TITLE_QUESTION, cancelOpenCreateCards, confirmCreate, draftFromIntent, startCreate,
  type CreateCardPayload, type CreateDraft, type TitleQuestionPayload,
} from "./create-event";
import { connectKeyboard, parseCallbackData } from "./keyboards";
import { t } from "./messages";
import { readEvents } from "./read-events";

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

  const { user } = await ensureTelegramUser(ctx.db, from.id, from.language_code, ctx.clock.now());
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
  const conversationId = await ensureConversation(ctx.db, chatId, "private");
  const text = message.text?.trim();
  if (!text) {
    // Голос, фото и прочее — позже (US-10, US-66)
    await ctx.telegram.sendMessage(chatId, t("notImplemented", user.locale));
    return;
  }

  // Ответ (reply) на вопрос о названии — переименовать созданное событие (US-30)
  if (message.reply_to_message) {
    const q = await findOpenByMessage<TitleQuestionPayload>(ctx.db, conversationId, user.id, TITLE_QUESTION, message.reply_to_message.message_id, ctx.clock.now());
    if (q && (await claimPendingAction(ctx.db, q.id, user.id, ctx.clock.now())).ok) {
      await withCalendar(ctx, user, chatId, async (provider) => {
        await provider.renameEvent(q.payload.ref, text);
        await ctx.telegram.sendMessage(chatId, t("renamed", user.locale, { title: text }));
      });
      return;
    }
  }

  // Ответ на «Во сколько?» / «Когда поставить?» дополняет черновик (US-12)
  const state = await getDialogState(ctx.db, conversationId, user.id);
  if (state.awaiting) {
    await setDialogState(ctx.db, conversationId, user.id, {}, ctx.clock.now());
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
  await cancelOpenCreateCards(ctx, conversationId, user);

  const calendarNames = await ctx.db
    .prepare(
      `SELECT c.title AS name FROM calendars c JOIN provider_accounts a ON a.id = c.account_id WHERE a.user_id = ?1
       UNION SELECT alias FROM calendar_aliases WHERE user_id = ?1`,
    )
    .bind(user.id)
    .all<{ name: string }>();

  let parsed: ParsedIntent;
  try {
    parsed = await parseIntent(ctx.config.llm, text, { calendars: calendarNames.results.map((r) => r.name) });
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

  const intent = parsed.intent;
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
    case "list_events":
      await withCalendar(ctx, user, chatId, (provider) =>
        readEvents(ctx, provider, {
          userId: user.id, chatId, locale: user.locale, tz: user.home_tz,
          range: extractDateSpans(text, localNow, user.home_tz, "range").range ?? intent.range,
          ...(intent.calendar ? { calendar: intent.calendar } : {}),
        }),
      );
      return;
  }
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
  if (claim.action.kind === CREATE_CARD) {
    await withCalendar(ctx, user, chatId, (provider) => confirmCreate(ctx, provider, user, claim.action as PendingAction<CreateCardPayload>, parsed.choice));
  }
}

/** Ошибки Google — понятным текстом (US-14); отозванный доступ — предложить переподключить (US-02). */
async function withCalendar(
  ctx: AppContext,
  user: User,
  chatId: number,
  action: (provider: GoogleCalendarProvider) => Promise<void>,
): Promise<void> {
  try {
    await action(new GoogleCalendarProvider(ctx.config, ctx.db, user.id));
  } catch (e) {
    console.error("calendar action failed", e);
    if (e instanceof GoogleAuthError && e.revoked) {
      await ctx.telegram.sendMessage(chatId, t("googleRevoked", user.locale), await connectKeyboard(ctx, user.id, user.locale));
    } else {
      await ctx.telegram.sendMessage(chatId, t("googleUnavailable", user.locale));
    }
  }
}
