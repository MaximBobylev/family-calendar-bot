// US-10: пересланное сообщение не исполняется как команда — это чужой текст (безопасность: «удали всё» от
// кого угодно). Бот показывает его и спрашивает: «Выполнить как команду?». Выполняется от имени нажавшего.
// R1 (US-65): здесь же будет кнопка «Создать событие из этого» — разбор чужого текста в событие.

import { attachMessage, createPendingAction, type PendingAction } from "../db/conversations";
import { recordFeature } from "../db/features";
import type { User } from "../db/users";
import type { AppContext } from "./context";
import { escapeHtml } from "./format";
import { callbackData } from "./keyboards";
import { t } from "./messages";

export const FORWARD_CARD = "forward";

/** Сколько текста храним в карточке: команде больше не нужно (в LLM уходит 500 символов). */
const MAX_STORED_LEN = 1000;
/** Сколько показываем в карточке. */
const MAX_SHOWN_LEN = 300;

export interface ForwardCardPayload {
  chatId: number;
  text: string;
}

export async function proposeForwarded(ctx: AppContext, user: User, chatId: number, conversationId: string, text: string): Promise<void> {
  const stored = text.slice(0, MAX_STORED_LEN);
  const id = await createPendingAction(ctx.db, {
    conversationId,
    userId: user.id,
    kind: FORWARD_CARD,
    payload: { chatId, text: stored } satisfies ForwardCardPayload,
    now: ctx.clock.now(),
  });
  const shown = stored.length > MAX_SHOWN_LEN ? `${stored.slice(0, MAX_SHOWN_LEN)}…` : stored;
  const sent = await ctx.telegram.sendMessage(
    chatId,
    t("forwardedConfirm", user.locale, { text: escapeHtml(shown) }),
    {
      inline_keyboard: [
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

/** Нажатие на карточке: текст команды для выполнения или null («Не выполнять»). Карточка уже «забрана». */
export async function confirmForwarded(ctx: AppContext, user: User, action: PendingAction<ForwardCardPayload>, choice: string): Promise<string | null> {
  const { chatId, text } = action.payload;
  const run = choice === "run";
  if (action.messageId) {
    const shown = text.length > MAX_SHOWN_LEN ? `${text.slice(0, MAX_SHOWN_LEN)}…` : text;
    await ctx.telegram.editMessageText(
      chatId,
      action.messageId,
      run ? t("forwardRunning", user.locale, { text: escapeHtml(shown) }) : t("forwardSkipped", user.locale),
      undefined,
      { html: true },
    );
  }
  if (run) await recordFeature(ctx.db, user.id, "forwarded_confirm", ctx.clock.now());
  return run ? text : null;
}
