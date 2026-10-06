// Бот в семейном групповом чате (US-94): привязка чата к дому (/home link), команды только участников дома по общим
// календарям (через аккаунт владельца), карточки может нажать любой взрослый дома. Непривязанный чат — без данных.

import { hasGoogleAccount } from "../../db/accounts";
import { ensureConversation } from "../../db/conversations";
import { cardOwner, type Household, householdOfConversation, linkConversation, type Membership, membershipOf } from "../../db/households";
import { findUserById, type User } from "../../db/users";
import type { TgCallbackQuery, TgMessage } from "../../telegram/types";
import { handleCallback } from "../callbacks";
import type { AppContext } from "../context";
import { handleCommand } from "../input/message";
import { parseCallbackData } from "../keyboards";
import { t } from "../messages";
import { parseHouseholdCommand, stripBotMention } from "./logic";
import { householdScope } from "./scope";

/** Команды, которые в группе не выполняем: они про личные данные одного человека. */
const PRIVATE_ONLY = /^\/(start|settings|connect|disconnect|forget)(@\w+)?\b/i;

const sameHome = (m: Membership | null, h: Household | null): m is Membership => !!m && !!h && m.household.id === h.id;

/** Привязать/отвязать чат может владелец или участник с Google ([решение 2026-10-06]). */
async function canManageLink(ctx: AppContext, m: Membership, userId: string): Promise<boolean> {
  return m.role === "owner" || hasGoogleAccount(ctx.db, userId);
}

/** Сообщение в группе — уже обращённое к боту (gate.ts) и от человека с доступом. */
export async function handleGroupMessage(ctx: AppContext, user: User, message: TgMessage): Promise<void> {
  const chatId = message.chat.id;
  const locale = user.locale;
  const conversationId = await ensureConversation(ctx.db, chatId, "group");
  const text = stripBotMention(message.text ?? "", ctx.config.telegramBotUsername);
  const cmd = text ? parseHouseholdCommand(text) : null;
  const [home, membership] = await Promise.all([householdOfConversation(ctx.db, conversationId), membershipOf(ctx.db, user.id)]);

  if (cmd?.kind === "link") {
    if (!membership || !(await canManageLink(ctx, membership, user.id))) {
      await ctx.telegram.sendMessage(chatId, t("groupLinkNeedsHome", locale));
    } else if (home && home.id !== membership.household.id) {
      await ctx.telegram.sendMessage(chatId, t("groupLinkedElsewhere", locale, { name: home.name }));
    } else {
      await linkConversation(ctx.db, conversationId, membership.household.id);
      await ctx.telegram.sendMessage(chatId, t("groupLinked", locale, { name: membership.household.name, bot: ctx.config.telegramBotUsername }));
    }
    return;
  }
  if (!home) {
    await ctx.telegram.sendMessage(chatId, t("groupNotLinked", locale));
    return;
  }
  if (!sameHome(membership, home)) {
    await ctx.telegram.sendMessage(chatId, t("groupMembersOnly", locale, { name: home.name }));
    return;
  }
  if (cmd?.kind === "unlink") {
    if (await canManageLink(ctx, membership, user.id)) {
      await linkConversation(ctx.db, conversationId, null);
      await ctx.telegram.sendMessage(chatId, t("groupUnlinked", locale, { name: home.name }));
    } else await ctx.telegram.sendMessage(chatId, t("homeOwnerOnly", locale));
    return;
  }
  // Управление домом и личные настройки — в личном чате
  if (cmd || PRIVATE_ONLY.test(text)) {
    await ctx.telegram.sendMessage(chatId, t("groupPrivateCommand", locale));
    return;
  }
  // Создавать и менять события в группе может любой участник дома — как и в личном чате (US-90, [решение 2026-10-06])
  const scoped: AppContext = { ...ctx, calendarScope: await householdScope(ctx.db, home) };
  await handleCommand(scoped, user, { ...message, text });
}

/**
 * Нажатие в группе: карточку может нажать любой взрослый дома (US-94) — проверяем членство нажавшего; действие
 * выполняется от имени автора карточки (его пояс, его «отмени последнее», он — «кто создал»).
 */
export async function handleGroupCallback(ctx: AppContext, user: User, cq: TgCallbackQuery): Promise<void> {
  const chatId = cq.message?.chat.id;
  const parsed = parseCallbackData(cq.data);
  if (!chatId || !parsed) {
    await ctx.telegram.answerCallbackQuery(cq.id, cq.data?.startsWith("hm:") ? t("groupPrivateCommand", user.locale) : undefined);
    return;
  }
  const conversationId = await ensureConversation(ctx.db, chatId, "group");
  const [home, membership, card] = await Promise.all([
    householdOfConversation(ctx.db, conversationId),
    membershipOf(ctx.db, user.id),
    cardOwner(ctx.db, parsed.actionId),
  ]);
  if (!home || !sameHome(membership, home)) {
    await ctx.telegram.answerCallbackQuery(cq.id, t("groupMembersOnlyButton", user.locale));
    return;
  }
  // Карточка — из этого же чата (не подставленный id чужой карточки)
  const author = card?.conversationId === conversationId ? (card.userId === user.id ? user : await findUserById(ctx.db, card.userId)) : null;
  if (!author) {
    await ctx.telegram.answerCallbackQuery(cq.id, t("cardExpired", user.locale));
    return;
  }
  await handleCallback({ ...ctx, calendarScope: await householdScope(ctx.db, home) }, author, cq);
}
