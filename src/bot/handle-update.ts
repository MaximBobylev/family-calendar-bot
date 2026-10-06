// Вход обработки одного апдейта: правки и чужие боты — мимо, доступ (US-01; приглашённые в дом — US-90), группы (US-94),
// регистрация, /disconnect (US-03), команды дома, без календаря и дома — только «Подключить»; дальше — сообщение
// (input/message.ts) или нажатие (callbacks.ts). Участник дома без Google работает с общими календарями дома.

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
  // Отредактированные сообщения игнорируем (US-10)
  if (update.edited_message) return;
  // Бота добавили в группу — приветствие с привязкой к дому (ревью R1 #13)
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
  // В группе — только обращённое к боту (privacy mode, US-94); webhook уже отсеял, здесь — для повторов из очереди
  if (message && isGroup && !isAddressedToBot(message, ctx.config.telegramBotUsername)) return;

  // Доступ проверяется до любой обработки (US-01, ADR-0001; приглашённые в дом — US-90)
  if (!(await hasAccess(ctx, from.id, message))) {
    if (message) await ctx.telegram.sendMessage(message.chat.id, t("notAllowed", lang));
    return;
  }

  // Вступление в дом по ссылке: код проверяется до регистрации (US-90)
  const inviteCode = message && !isGroup ? parseHomeStart(message.text) : null;
  if (message && inviteCode) {
    await joinByInvite(ctx, from, message.chat.id, inviteCode);
    return;
  }

  const user: User = { ...(await ensureTelegramUser(ctx.db, from.id, ctx.clock.now())).user, tgName: telegramName(from) };
  // «📅 Добавить себе» под inline-карточкой и продолжение по её ссылке в личном чате (US-95)
  if (isInlinePress(update.callback_query)) {
    await handleInlinePress(ctx, user, update.callback_query!);
    return;
  }
  const addToken = message && !isGroup ? parseAddStart(message.text) : null;
  if (message && addToken) {
    await handleAddStart(ctx, user, message.chat.id, addToken);
    return;
  }
  // Кнопки поручения (US-91): нажимает сам участник — и в личном чате, и в группе дома
  if (update.callback_query && isAssignCallback(update.callback_query.data)) {
    await handleAssignCallback(ctx, user, update.callback_query);
    return;
  }
  if (isGroup) {
    if (update.callback_query) await handleGroupCallback(ctx, user, update.callback_query);
    else if (message) await handleGroupMessage(ctx, user, message);
    return;
  }

  // Чьи календари в личном чате (US-90, QA-08): участник дома — общие календари дома через Google владельца, если их нет
  // в его собственном Google
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

  // Удалить свои данные можно всегда, даже без подключённого календаря (US-03)
  if (isDisconnectCommand(message.text)) {
    await proposeDisconnect(ctx, user, message.chat.id);
    return;
  }
  // Справка и приветствие — без LLM, по состоянию (ревью R1 §4)
  if (isHelpRequest(message.text)) {
    await sendHelp(ctx, user, message.chat.id);
    return;
  }
  if (isStart) {
    await sendStart(ctx, user, message.chat.id, hasGoogle, membership);
    return;
  }
  // /home, /leave, «создай дом …», ответы на вопросы дома («как вас называть») — и без Google (US-90)
  if (await handleHouseholdText(ctx, user, message, from)) return;

  // Без привязанного календаря и дома интент не распознаём — только предлагаем подключить (US-01)
  if (!hasGoogle && !membership) {
    await ctx.telegram.sendMessage(message.chat.id, t("connectPrompt", user.locale), await connectKeyboard(ctx, user.id, user.locale, user.tgName));
    return;
  }
  // «Беру» / «Не могу» / «Сделано» словом — ответ на поручение (ревью R1 #7)
  if (message.text && membership && (await handleTextAnswer(ctx, user, message.chat.id, message.text, message.reply_to_message?.message_id))) return;
  await handleCommand(scoped, user, message);
}
