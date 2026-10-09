// US-10: пересланное сообщение не исполняется как команда — это чужой текст (безопасность: «удали всё» от
// кого угодно). Бот показывает его и спрашивает: «Выполнить как команду?». Выполняется от имени нажавшего.
// US-65 (R1): кнопка «Создать событие из этого» — разбор чужого текста в событие (ingest.ts), всегда с карточкой.

import { attachMessage, createPendingAction, type PendingAction } from "../db/conversations";
import { recordFeature } from "../db/features";
import type { User } from "../db/users";
import type { AppContext } from "./context";
import { escapeHtml } from "./format";
import { formatMoment, utcToLocal } from "../dates/calendar";
import { eventFromForwarded } from "./ingest";
import { foreignDateSpans } from "./ingest-logic";
import { callbackData } from "./keyboards";
import { t } from "./messages";
import { withTyping } from "./with-typing";

export const FORWARD_CARD = "forward";

/** Сколько текста храним в карточке: команде больше не нужно (в LLM уходит 500 символов). */
const MAX_STORED_LEN = 1000;
/** Сколько показываем в карточке. */
const MAX_SHOWN_LEN = 300;
/** Похоже на событие — коротко: полный текст ещё будет в карточке события и в описании (ревью R1 #8). */
const MAX_SHOWN_EVENT_LEN = 120;

/** Откуда переслано (US-65): имя автора или чата, дата исходного сообщения (секунды Unix; 0 — скрыта). */
export interface ForwardOrigin {
  from?: string;
  date?: number;
}

export interface ForwardCardPayload extends ForwardOrigin {
  chatId: number;
  text: string;
}

/** forward_origin Telegram → имя и дата: user, hidden_user, chat, channel. */
export function forwardOrigin(origin: unknown): ForwardOrigin {
  if (!origin || typeof origin !== "object") return {};
  const o = origin as {
    type?: string;
    date?: number;
    sender_user?: { first_name?: string; last_name?: string };
    sender_user_name?: string;
    sender_chat?: { title?: string };
    chat?: { title?: string };
  };
  const user = o.sender_user ? [o.sender_user.first_name, o.sender_user.last_name].filter(Boolean).join(" ") : undefined;
  const from = (user || o.sender_user_name || o.sender_chat?.title || o.chat?.title)?.trim().slice(0, 100);
  return { ...(from ? { from } : {}), ...(typeof o.date === "number" && o.date > 0 ? { date: o.date } : {}) };
}

export async function proposeForwarded(
  ctx: AppContext,
  user: User,
  chatId: number,
  conversationId: string,
  text: string,
  origin: ForwardOrigin = {},
): Promise<void> {
  const stored = text.slice(0, MAX_STORED_LEN);
  const id = await createPendingAction(ctx.db, {
    conversationId,
    userId: user.id,
    kind: FORWARD_CARD,
    payload: { chatId, text: stored, ...origin } satisfies ForwardCardPayload,
    now: ctx.clock.now(),
  });
  // Похоже на событие (в тексте есть дата) — главный сценарий R1: «Создать событие» первым, без вопроса безопасности
  // в заголовке (ревью R1 #8). Без нажатия ничего не выполняется при любом порядке кнопок.
  const nowLocal = formatMoment(utcToLocal(ctx.clock.now(), user.tz));
  const looksEvent = !!foreignDateSpans(stored, nowLocal, user.tz).point;
  const l = user.locale;
  const limit = looksEvent ? MAX_SHOWN_EVENT_LEN : MAX_SHOWN_LEN;
  const shown = escapeHtml(stored.length > limit ? `${stored.slice(0, limit)}…` : stored);
  const sent = await ctx.telegram.sendMessage(
    chatId,
    looksEvent ? t("forwardedLooksEvent", l, { text: shown }) : t("forwardedConfirm", l, { text: shown }),
    {
      inline_keyboard: looksEvent
        ? [
            [{ text: t("forwardEventButton", l), callback_data: callbackData(id, "ev") }],
            [
              { text: t("forwardRunAsCommandButton", l), callback_data: callbackData(id, "run") },
              { text: t("forwardNoButton", l), callback_data: callbackData(id, "x") },
            ],
          ]
        : [
            [{ text: t("forwardEventButton", l), callback_data: callbackData(id, "ev") }],
            [
              { text: t("forwardRunButton", l), callback_data: callbackData(id, "run") },
              { text: t("forwardSkipButton", l), callback_data: callbackData(id, "x") },
            ],
          ],
    },
    { html: true },
  );
  await attachMessage(ctx.db, id, sent.message_id);
}

/**
 * Нажатие на карточке: текст команды для выполнения или null («Не выполнять» или «Создать событие» — карточка
 * события показана здесь же). Карточка уже «забрана».
 */
export async function confirmForwarded(ctx: AppContext, user: User, action: PendingAction<ForwardCardPayload>, choice: string): Promise<string | null> {
  const { chatId, text } = action.payload;
  const run = choice === "run";
  const event = choice === "ev";
  if (action.messageId) {
    const shown = escapeHtml(text.length > MAX_SHOWN_LEN ? `${text.slice(0, MAX_SHOWN_LEN)}…` : text);
    await ctx.telegram.editMessageText(
      chatId,
      action.messageId,
      run ? t("forwardRunning", user.locale, { text: shown }) : event ? t("forwardEventStarted", user.locale) : t("forwardSkipped", user.locale),
      undefined,
      { html: true },
    );
  }
  if (run) await recordFeature(ctx.db, user.id, "forwarded_confirm", ctx.clock.now());
  // Событие из чужого текста (US-65): команда не выполняется, только карточка «Создать событие?»
  if (event) await withTyping(ctx, chatId, () => eventFromForwarded(ctx, user, chatId, action.conversationId, action.payload));
  return run ? text : null;
}
