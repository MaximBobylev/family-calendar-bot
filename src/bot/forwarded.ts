// US-10: пересланное сообщение не исполняется как команда — это чужой текст (безопасность: «удали всё» от
// кого угодно). Бот показывает его и спрашивает: «Выполнить как команду?». Выполняется от имени нажавшего.
// US-65 (R1): кнопка «Создать событие из этого» — разбор чужого текста в событие (ingest.ts), всегда с карточкой.

import { attachMessage, createPendingAction, type PendingAction } from "../db/conversations";
import { recordFeature } from "../db/features";
import type { User } from "../db/users";
import type { AppContext } from "./context";
import { escapeHtml } from "./format";
import { eventFromForwarded } from "./ingest";
import { callbackData } from "./keyboards";
import { t } from "./messages";
import { withTyping } from "./with-typing";

export const FORWARD_CARD = "forward";

/** Сколько текста храним в карточке: команде больше не нужно (в LLM уходит 500 символов). */
const MAX_STORED_LEN = 1000;
/** Сколько показываем в карточке. */
const MAX_SHOWN_LEN = 300;

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
  const shown = stored.length > MAX_SHOWN_LEN ? `${stored.slice(0, MAX_SHOWN_LEN)}…` : stored;
  const sent = await ctx.telegram.sendMessage(
    chatId,
    t("forwardedConfirm", user.locale, { text: escapeHtml(shown) }),
    {
      inline_keyboard: [
        [{ text: t("forwardEventButton", user.locale), callback_data: callbackData(id, "ev") }],
        [
          { text: t("forwardRunButton", user.locale), callback_data: callbackData(id, "run") },
          { text: t("forwardSkipButton", user.locale), callback_data: callbackData(id, "x") },
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
      run
        ? t("forwardRunning", user.locale, { text: shown })
        : event
          ? t("forwardEventStarted", user.locale, { text: shown })
          : t("forwardSkipped", user.locale),
      undefined,
      { html: true },
    );
  }
  if (run) await recordFeature(ctx.db, user.id, "forwarded_confirm", ctx.clock.now());
  // Событие из чужого текста (US-65): команда не выполняется, только карточка «Создать событие?»
  if (event) await withTyping(ctx, chatId, () => eventFromForwarded(ctx, user, chatId, action.conversationId, action.payload));
  return run ? text : null;
}
