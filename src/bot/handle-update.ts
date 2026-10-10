// Порядок проверок значим: доступ → приглашение в дом (до регистрации) → регистрация → кнопки → команды.

import { hasGoogleAccount } from "../db/accounts";
import { membershipOf } from "../db/households";
import { ensureTelegramUser, type User } from "../db/users";
import type { TgUpdate } from "../telegram/types";
import { handleAssignCallback, handleTextAnswer } from "./assign/answers";
import { isAssignCallback } from "./assign/view";
import { handleCallback } from "./callbacks";
import type { AppContext } from "./context";
import { isDisconnectCommand, proposeDisconnect } from "./disconnect";
import { telegramName } from "./format";
import { hasAccess } from "./gate";
import { handleHouseholdText, joinByInvite } from "./household/commands";
import { greetGroup, handleGroupCallback, handleGroupMessage } from "./household/group";
import { isAddressedToBot, parseHomeStart } from "./household/logic";
import { handleHouseholdCallback, isHouseholdCallback } from "./household/menu";
import { privateScope } from "./household/scope";
import { isHelpRequest, sendHelp, sendStart } from "./help";
import { parseAddStart } from "./inline/logic";
import { handleAddStart, handleInlinePress, isInlinePress } from "./inline/press";
import { handleCommand } from "./input/message";
import { connectKeyboard } from "./keyboards";
import { t } from "./messages";

export async function handleUpdate(ctx: AppContext, update: TgUpdate): Promise<void> {
  if (update.edited_message) return;
  if (update.my_chat_member) {
    await greetGroup(ctx, update.my_chat_member);
    return;
  }

  const message = update.message;
  const from = message?.from ?? update.callback_query?.from;
  if (!from || from.is_bot) return;
  const lang = from.language_code ?? "ru";
  const chat = message?.chat ?? update.callback_query?.message?.chat;
  const isGroup = !!chat && chat.type !== "private";
  if (chat?.type === "channel") return;
  // webhook это уже отсеял; здесь — для повторов из очереди
  if (message && isGroup && !isAddressedToBot(message, ctx.config.telegramBotUsername)) return;

  if (!(await hasAccess(ctx, from.id, message))) {
    if (message) await ctx.telegram.sendMessage(message.chat.id, t("notAllowed", lang));
    return;
  }

  // Код приглашения проверяется до регистрации
  const inviteCode = message && !isGroup ? parseHomeStart(message.text) : null;
  if (message && inviteCode) {
    await joinByInvite(ctx, from, message.chat.id, inviteCode);
    return;
  }

  const user: User = { ...(await ensureTelegramUser(ctx.db, from.id, ctx.clock.now())).user, tgName: telegramName(from) };
  if (isInlinePress(update.callback_query)) {
    await handleInlinePress(ctx, user, update.callback_query!);
    return;
  }
  const addToken = message && !isGroup ? parseAddStart(message.text) : null;
  if (message && addToken) {
    await handleAddStart(ctx, user, message.chat.id, addToken);
    return;
  }
  // До ветки группы: кнопки поручения нажимают и в личном чате, и в группе дома
  if (update.callback_query && isAssignCallback(update.callback_query.data)) {
    await handleAssignCallback(ctx, user, update.callback_query);
    return;
  }
  if (isGroup) {
    if (update.callback_query) await handleGroupCallback(ctx, user, update.callback_query);
    else if (message) await handleGroupMessage(ctx, user, message);
    return;
  }

  // Участник дома работает с общими календарями дома через Google владельца, если их нет в его собственном Google (QA-08)
  const hasGoogle = await hasGoogleAccount(ctx.db, user.id);
  const membership = await membershipOf(ctx.db, user.id);
  const scope = await privateScope(ctx, user.id);
  const scoped: AppContext = scope ? { ...ctx, calendarScope: scope } : ctx;

  if (update.callback_query) {
    if (isHouseholdCallback(update.callback_query.data)) await handleHouseholdCallback(ctx, user, update.callback_query);
    else await handleCallback(scoped, user, update.callback_query);
    return;
  }
  if (!message) return;
  const isStart = message.text?.trim() === "/start";

  // Раньше проверки календаря: удалить свои данные можно и без него (US-03)
  if (isDisconnectCommand(message.text)) {
    await proposeDisconnect(ctx, user, message.chat.id);
    return;
  }
  if (isHelpRequest(message.text)) {
    await sendHelp(ctx, user, message.chat.id);
    return;
  }
  if (isStart) {
    await sendStart(ctx, user, message.chat.id, hasGoogle, membership);
    return;
  }
  // Раньше проверки календаря: команды дома работают и без Google
  if (await handleHouseholdText(ctx, user, message, from)) return;

  if (!hasGoogle && !membership) {
    await ctx.telegram.sendMessage(message.chat.id, t("connectPrompt", user.locale), await connectKeyboard(ctx, user.id, user.locale, user.tgName));
    return;
  }
  // «Беру» / «Не могу» / «Сделано» словом
  if (message.text && membership && (await handleTextAnswer(ctx, user, message.chat.id, message.text, message.reply_to_message?.message_id))) return;
  await handleCommand(scoped, user, message);
}
