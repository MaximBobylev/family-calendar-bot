// Приём сообщения: текст, голосовое/аудио (→ распознавание), пересланное (→ карточка «Выполнить?», US-10),
// прочее (фото, файлы) — «пока не умею». Дальше — диалоговый слой (dialog.ts).

import { ensureConversation } from "../../db/conversations";
import type { User } from "../../db/users";
import type { TgMessage } from "../../telegram/types";
import type { AppContext } from "../context";
import { cancelCards, runCommand } from "../dialog";
import { proposeForwarded } from "../forwarded";
import { t } from "../messages";
import { withTyping } from "../with-typing";
import { recognizeVoice } from "./voice";

export async function handleCommand(ctx: AppContext, user: User, message: TgMessage): Promise<void> {
  const chatId = message.chat.id;
  await withTyping(ctx, chatId, async () => {
    // Групповой чат дома — свой разговор (US-94); состояние диалога — по паре чат × пользователь
    const conversationId = await ensureConversation(ctx.db, chatId, message.chat.type === "private" ? "private" : "group");
    let text = message.text?.trim();
    let voice: { fileId: string; durationSec: number } | undefined;
    if (!text && (message.voice || message.audio)) {
      text = (await recognizeVoice(ctx, user, message)) ?? undefined;
      if (!text) return;
      const v = (message.voice ?? message.audio)!;
      voice = { fileId: v.file_id, durationSec: v.duration };
    }
    if (!text) {
      // Фото, файлы и прочее — позже (US-66)
      await ctx.telegram.sendMessage(chatId, t("notImplemented", user.locale));
      return;
    }
    // Пересланное — чужой текст, не команда пользователя: только по кнопке «Выполнить» (US-10)
    if (message.forward_origin) {
      await cancelCards(ctx, user, conversationId);
      await proposeForwarded(ctx, user, chatId, conversationId, text);
      return;
    }
    await runCommand(ctx, user, chatId, conversationId, text, {
      ...(voice ? { voice } : {}),
      ...(message.reply_to_message ? { replyTo: message.reply_to_message.message_id } : {}),
    });
  });
}
