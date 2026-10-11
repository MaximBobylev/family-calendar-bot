// Пересланное — чужой текст: без нажатия кнопки не исполняется как команда (иначе «удали всё» от кого угодно).

import { attachMessage, createPendingAction, type PendingAction } from "../db/conversations";
import { recordFeature } from "../db/features";
import type { User } from "../db/users";
import type { AppContext } from "./context";
import { escapeHtml } from "./format";
import { formatMoment, utcToLocal } from "../dates/calendar";
import { eventFromForwarded, multiForwardPieces } from "./ingest";
import { foreignDateSpans } from "./ingest-logic";
import { callbackData } from "./keyboards";
import { t } from "./messages";
import { withTyping } from "./with-typing";

export const FORWARD_CARD = "forward";

// Больше команде не нужно: в LLM уходит 500 символов
const MAX_STORED_LEN = 1000;
const MAX_SHOWN_LEN = 300;
// Коротко: полный текст ещё будет в карточке события и в описании
const MAX_SHOWN_EVENT_LEN = 120;

// date — секунды Unix
export interface ForwardOrigin {
  from?: string;
  date?: number;
}

export interface ForwardCardPayload extends ForwardOrigin {
  chatId: number;
  text: string;
}

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
  // Без нажатия ничего не выполняется при любом порядке кнопок — поэтому, если в тексте есть дата,
  // «Создать событие» первым и без вопроса безопасности в заголовке
  const nowLocal = formatMoment(utcToLocal(ctx.clock.now(), user.tz));
  const many = !!multiForwardPieces(stored, nowLocal, user.tz);
  const looksEvent = many || !!foreignDateSpans(stored, nowLocal, user.tz).point;
  const l = user.locale;
  const limit = looksEvent ? MAX_SHOWN_EVENT_LEN : MAX_SHOWN_LEN;
  const shown = escapeHtml(stored.length > limit ? `${stored.slice(0, limit)}…` : stored);
  const sent = await ctx.telegram.sendMessage(
    chatId,
    many ? t("forwardLooksEvents", l, { text: shown }) : looksEvent ? t("forwardedLooksEvent", l, { text: shown }) : t("forwardedConfirm", l, { text: shown }),
    {
      inline_keyboard: looksEvent
        ? [
            [{ text: t(many ? "forwardEventsButton" : "forwardEventButton", l), callback_data: callbackData(id, "ev") }],
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

// null — выполнять нечего: «Не выполнять» или «Создать событие» (карточка события показана здесь же)
export async function confirmForwarded(ctx: AppContext, user: User, action: PendingAction<ForwardCardPayload>, choice: string): Promise<string | null> {
  const { chatId, text } = action.payload;
  const run = choice === "run";
  const event = choice === "ev";
  // Несколько дел — это же сообщение станет списком (US-62)
  const many = event && !!multiForwardPieces(text, formatMoment(utcToLocal(ctx.clock.now(), user.tz)), user.tz);
  if (action.messageId && !many) {
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
  if (event)
    await withTyping(ctx, chatId, () =>
      eventFromForwarded(ctx, user, chatId, action.conversationId, action.payload, many && action.messageId ? Number(action.messageId) : undefined),
    );
  return run ? text : null;
}
