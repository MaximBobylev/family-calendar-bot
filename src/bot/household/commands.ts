// Команды дома в личном чате (US-90): создать дом, пригласить, вступить по ссылке, имя и другие имена, дети, выйти.
// Разбор текста — logic.ts (без LLM); экран /home и кнопки — menu.ts.

import { randomToken } from "../../crypto";
import { GoogleCalendarProvider } from "../../calendar/google-provider";
import { hasGoogleAccount } from "../../db/accounts";
import { attachMessage, claimPendingAction, createPendingAction, ensureConversation, findOpenByMessage } from "../../db/conversations";
import {
  addMember,
  adoptOwnerTimezone,
  consumeInvite,
  createHousehold,
  createInvite,
  dependentsOf,
  type Household,
  type Membership,
  memberCount,
  membersOf,
  membershipOf,
  peekInvite,
  removeMember,
  setMemberName,
  upsertDependent,
} from "../../db/households";
import { ensureTelegramUser, type User } from "../../db/users";
import type { TgMessage, TgUser } from "../../telegram/types";
import type { AppContext } from "../context";
import { escapeHtml } from "../format";
import { t } from "../messages";
import {
  defaultHouseholdCalendars,
  HOUSEHOLD_INVITE_TTL_MS,
  HOUSEHOLD_MAX_DEPENDENTS,
  HOUSEHOLD_MAX_MEMBERS,
  type HouseholdCommand,
  inviteLink,
  parseHouseholdCommand,
  parseNameAndAliases,
} from "./logic";
import { calendarsScreen, notify, showHome } from "./menu";

/** Вопрос «Как вас называть в доме?» (ForceReply) — ответ reply задаёт имя и другие имена. */
export const HOME_NAME_QUESTION = "home_name";

const aliasesSuffix = (aliases: string[], locale: string) => (aliases.length ? t("homeAliasesSuffix", locale, { list: aliases.join(", ") }) : "");

/**
 * Команды дома в личном чате и ответ на вопрос об имени. true — сообщение обработано, дальше не идёт.
 * Доступны и участнику без Google.
 */
export async function handleHouseholdText(ctx: AppContext, user: User, message: TgMessage, tgUser: TgUser): Promise<boolean> {
  const text = message.text?.trim();
  if (!text) return false;
  const chatId = message.chat.id;
  if (message.reply_to_message && (await answerNameQuestion(ctx, user, chatId, message.reply_to_message.message_id, text))) return true;
  const cmd = parseHouseholdCommand(text);
  if (!cmd) return false;
  await runHouseholdCommand(ctx, user, chatId, cmd, tgUser);
  return true;
}

async function runHouseholdCommand(ctx: AppContext, user: User, chatId: number, cmd: HouseholdCommand, tgUser: TgUser): Promise<void> {
  const locale = user.locale;
  const membership = await membershipOf(ctx.db, user.id);
  const send = (text: string) => ctx.telegram.sendMessage(chatId, text);
  switch (cmd.kind) {
    case "menu":
      await showHome(ctx, user, chatId);
      return;
    case "help":
    case "link":
    case "unlink":
      // link/unlink — команды группового чата
      await send(t("homeHelp", locale));
      return;
    case "create":
      await createHome(ctx, user, chatId, cmd.name, membership, tgUser);
      return;
    case "invite":
      if (!membership) await send(t("homeNone", locale));
      else if (membership.role !== "owner") await send(t("homeOwnerOnly", locale));
      else await sendInvite(ctx, user, chatId, membership.household, cmd.preset);
      return;
    case "name":
      if (!membership) await send(t("homeNotInHousehold", locale));
      else {
        await setMemberName(ctx.db, membership.household.id, user.id, cmd.name, cmd.aliases);
        await send(t("homeNameSet", locale, { name: cmd.name, aliases: aliasesSuffix(cmd.aliases, locale) }));
      }
      return;
    case "kid":
      if (!membership) await send(t("homeNotInHousehold", locale));
      else await addKid(ctx, user, chatId, membership.household, cmd.name, cmd.aliases);
      return;
    case "leave":
      if (!membership) await send(t("homeNotInHousehold", locale));
      else await leaveHousehold(ctx, user, chatId, membership);
      return;
  }
}

async function createHome(ctx: AppContext, user: User, chatId: number, name: string, membership: Membership | null, tgUser: TgUser): Promise<void> {
  const locale = user.locale;
  if (membership) {
    await ctx.telegram.sendMessage(chatId, t("homeAlreadyIn", locale, { name: membership.household.name }));
    return;
  }
  // Дом без Google бессмыслен: общие календари — календари владельца (US-90)
  if (!(await hasGoogleAccount(ctx.db, user.id))) {
    await ctx.telegram.sendMessage(chatId, t("homeCreateNeedsGoogle", locale));
    return;
  }
  const calendars = await new GoogleCalendarProvider(ctx.config, ctx.db, user.id, ctx.clock).calendars();
  const household = await createHousehold(ctx.db, {
    ownerId: user.id,
    name,
    ownerName: tgUser.first_name,
    calendarIds: defaultHouseholdCalendars(calendars),
    now: ctx.clock.now(),
  });
  const picker = await calendarsScreen(ctx, household, locale);
  await ctx.telegram.sendMessage(chatId, escapeHtml(t("homeCreated", locale, { name })), { inline_keyboard: picker.buttons }, { html: true });
}

/** Ссылка-приглашение (только владелец): одноразовая, 48 ч; preset — имя и другие имена приглашённого. */
export async function sendInvite(
  ctx: AppContext,
  user: User,
  chatId: number,
  household: Household,
  preset?: { name: string; aliases: string[] },
): Promise<void> {
  const locale = user.locale;
  if ((await memberCount(ctx.db, household.id)) >= HOUSEHOLD_MAX_MEMBERS) {
    await ctx.telegram.sendMessage(chatId, t("homeFull", locale, { max: String(HOUSEHOLD_MAX_MEMBERS) }));
    return;
  }
  // Код — только [A-Za-z0-9_-] (payload deep link Telegram)
  const code = randomToken(12);
  await createInvite(ctx.db, {
    code,
    householdId: household.id,
    createdBy: user.id,
    preset: preset ? [preset.name, ...preset.aliases] : [],
    now: ctx.clock.now(),
    ttlMs: HOUSEHOLD_INVITE_TTL_MS,
  });
  const text = t("homeInvite", locale, { name: household.name, link: inviteLink(ctx.config.telegramBotUsername, code) });
  const forWhom = preset ? `\n${t("homeInviteFor", locale, { name: [preset.name, ...preset.aliases].join(", ") })}` : "";
  await ctx.telegram.sendMessage(chatId, `${text}${forWhom}`);
}

async function addKid(ctx: AppContext, user: User, chatId: number, household: Household, name: string, aliases: string[]): Promise<void> {
  const kids = await dependentsOf(ctx.db, household.id);
  const exists = kids.some((k) => k.name.toLowerCase() === name.toLowerCase());
  if (!exists && kids.length >= HOUSEHOLD_MAX_DEPENDENTS) {
    await ctx.telegram.sendMessage(chatId, t("homeKidsFull", user.locale, { max: String(HOUSEHOLD_MAX_DEPENDENTS) }));
    return;
  }
  await upsertDependent(ctx.db, household.id, name, aliases);
  await ctx.telegram.sendMessage(chatId, t("homeKidAdded", user.locale, { name, aliases: aliasesSuffix(aliases, user.locale) }));
}

/** Выйти из дома (участник; владелец — только распустить). messageId — экран /home, который заменить итогом. */
export async function leaveHousehold(ctx: AppContext, user: User, chatId: number, membership: Membership, messageId?: number): Promise<void> {
  const { household } = membership;
  const say = async (text: string) => {
    if (messageId) await ctx.telegram.editMessageText(chatId, messageId, text);
    else await ctx.telegram.sendMessage(chatId, text);
  };
  if (membership.role === "owner") {
    await say(t("homeOwnerCantLeave", user.locale));
    return;
  }
  await removeMember(ctx.db, household.id, user.id);
  await say(t("homeLeft", user.locale, { name: household.name }));
  const owner = (await membersOf(ctx.db, household.id)).find((m) => m.role === "owner");
  if (owner?.telegramId) await notify(ctx, owner.telegramId, t("homeMemberLeft", user.locale, { name: membership.displayName, home: household.name }));
}

/**
 * `/start home_<код>` (US-90): проверить приглашение ДО регистрации (посторонний с неверным кодом не становится
 * пользователем), затем атомарно «погасить» код и добавить в дом. Приглашённому allowlist не нужен.
 */
export async function joinByInvite(ctx: AppContext, from: TgUser, chatId: number, code: string): Promise<void> {
  const lang = from.language_code ?? "ru";
  const now = ctx.clock.now();
  const home = await peekInvite(ctx.db, code, now);
  if (!home) {
    await ctx.telegram.sendMessage(chatId, t("homeInviteInvalid", lang));
    return;
  }
  const { user } = await ensureTelegramUser(ctx.db, from.id, now);
  const locale = user.locale;
  const current = await membershipOf(ctx.db, user.id);
  if (current) {
    await ctx.telegram.sendMessage(chatId, t("homeAlreadyIn", locale, { name: current.household.name }));
    return;
  }
  if ((await memberCount(ctx.db, home.id)) >= HOUSEHOLD_MAX_MEMBERS) {
    await ctx.telegram.sendMessage(chatId, t("homeFull", locale, { max: String(HOUSEHOLD_MAX_MEMBERS) }));
    return;
  }
  const invite = await consumeInvite(ctx.db, code, user.id, now);
  if (!invite) {
    await ctx.telegram.sendMessage(chatId, t("homeInviteInvalid", locale));
    return;
  }
  const preset = parseNameAndAliases(invite.preset.join(","));
  const name = preset?.name ?? from.first_name;
  await addMember(ctx.db, { householdId: home.id, userId: user.id, name, aliases: preset?.aliases ?? [], now });
  await adoptOwnerTimezone(ctx.db, user.id, home.ownerUserId);
  await ctx.telegram.sendMessage(chatId, t("homeJoined", locale, { name: home.name }));
  // Имя задал владелец при приглашении — не переспрашиваем
  if (!preset) await askName(ctx, user, chatId);
  const owner = (await membersOf(ctx.db, home.id)).find((m) => m.role === "owner");
  if (owner?.telegramId) await notify(ctx, owner.telegramId, t("homeMemberJoined", locale, { name, home: home.name }));
}

async function askName(ctx: AppContext, user: User, chatId: number): Promise<void> {
  const conversationId = await ensureConversation(ctx.db, chatId, "private");
  const id = await createPendingAction(ctx.db, { conversationId, userId: user.id, kind: HOME_NAME_QUESTION, payload: {}, now: ctx.clock.now() });
  const q = await ctx.telegram.sendMessage(chatId, t("homeAskName", user.locale), { force_reply: true });
  await attachMessage(ctx.db, id, q.message_id);
}

/** Ответ (reply) на «Как вас называть в доме?». */
async function answerNameQuestion(ctx: AppContext, user: User, chatId: number, replyTo: number, text: string): Promise<boolean> {
  const conversationId = await ensureConversation(ctx.db, chatId, "private");
  const q = await findOpenByMessage(ctx.db, conversationId, user.id, HOME_NAME_QUESTION, replyTo, ctx.clock.now());
  if (!q || !(await claimPendingAction(ctx.db, q.id, user.id, ctx.clock.now())).ok) return false;
  const membership = await membershipOf(ctx.db, user.id);
  const parsed = parseNameAndAliases(text);
  if (!membership || !parsed) return false;
  await setMemberName(ctx.db, membership.household.id, user.id, parsed.name, parsed.aliases);
  await ctx.telegram.sendMessage(chatId, t("homeNameSet", user.locale, { name: parsed.name, aliases: aliasesSuffix(parsed.aliases, user.locale) }));
  return true;
}
