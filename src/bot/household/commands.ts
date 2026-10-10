// Ответы на вопросы дома — обычным сообщением через dialog_state.awaiting, без reply (ревью R1 #7).

import { randomToken } from "../../crypto";
import { GoogleCalendarProvider } from "../../calendar/google-provider";
import { hasGoogleAccount } from "../../db/accounts";
import { ensureConversation, getDialogState, mergeDialogState } from "../../db/conversations";
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
  setMemberNameOf,
  upsertDependent,
} from "../../db/households";
import { setLocale } from "../../db/settings";
import { ensureTelegramUser, findUserById, type User } from "../../db/users";
import type { InlineKeyboardButton, TgMessage, TgUser } from "../../telegram/types";
import { releaseMemberAssignments } from "../assign/answers";
import type { AppContext } from "../context";
import { escapeHtml } from "../format";
import { t } from "../messages";
import {
  cleanHouseholdName,
  defaultHouseholdCalendars,
  HOUSEHOLD_INVITE_TTL_MS,
  HOUSEHOLD_MAX_DEPENDENTS,
  HOUSEHOLD_MAX_MEMBERS,
  type HouseholdCommand,
  inviteLink,
  looksLikeNames,
  parseHouseholdCommand,
  parseNameAndAliases,
} from "./logic";
import { calendarsScreen, notify, showHome } from "./menu";

// Сутки: на вопрос об имени отвечают не сразу.
const HOME_AWAIT_TTL_MS = 24 * 60 * 60 * 1000;

const aliasesSuffix = (aliases: string[], locale: string) => (aliases.length ? t("homeAliasesSuffix", locale, { list: aliases.join(", ") }) : "");

export const roleButtons = (locale: string): InlineKeyboardButton[][] => [
  [
    { text: t("homeRoleHusband", locale), callback_data: "hm:role:h" },
    { text: t("homeRoleWife", locale), callback_data: "hm:role:w" },
  ],
];

export async function awaitHome(
  ctx: AppContext,
  user: User,
  chatId: number,
  awaiting: { kind: "home_name"; userId?: string } | { kind: "home_kid" } | { kind: "home_create" },
): Promise<void> {
  const conversationId = await ensureConversation(ctx.db, chatId, "private");
  await mergeDialogState(ctx.db, conversationId, user.id, { awaiting: { ...awaiting, expiresAt: ctx.clock.now() + HOME_AWAIT_TTL_MS } }, ctx.clock.now());
}

export async function clearHomeAwait(ctx: AppContext, user: User, chatId: number): Promise<void> {
  const conversationId = await ensureConversation(ctx.db, chatId, "private");
  const { awaiting } = await getDialogState(ctx.db, conversationId, user.id);
  if (awaiting?.kind.startsWith("home_")) await mergeDialogState(ctx.db, conversationId, user.id, { awaiting: undefined }, ctx.clock.now());
}

// Доступны и участнику без Google.
export async function handleHouseholdText(ctx: AppContext, user: User, message: TgMessage, tgUser: TgUser): Promise<boolean> {
  const text = message.text?.trim();
  if (!text) return false;
  const chatId = message.chat.id;
  const cmd = parseHouseholdCommand(text);
  if (!cmd && (await answerHomeQuestion(ctx, user, chatId, text, tgUser))) return true;
  if (!cmd) return false;
  await runHouseholdCommand(ctx, user, chatId, cmd, tgUser);
  return true;
}

// Не похоже на имя или название — вопрос снимается, сообщение идёт дальше как команда.
async function answerHomeQuestion(ctx: AppContext, user: User, chatId: number, text: string, tgUser: TgUser): Promise<boolean> {
  const conversationId = await ensureConversation(ctx.db, chatId, "private");
  const { awaiting } = await getDialogState(ctx.db, conversationId, user.id);
  if (!awaiting || (awaiting.kind !== "home_name" && awaiting.kind !== "home_kid" && awaiting.kind !== "home_create")) return false;
  await mergeDialogState(ctx.db, conversationId, user.id, { awaiting: undefined }, ctx.clock.now());
  if (awaiting.expiresAt <= ctx.clock.now() || text.startsWith("/")) return false;
  if (awaiting.kind === "home_create") {
    const name = cleanHouseholdName(text);
    if (!name || !looksLikeNames(text)) return false;
    await createHome(ctx, user, chatId, name, await membershipOf(ctx.db, user.id), tgUser);
    return true;
  }
  const parsed = looksLikeNames(text) ? parseNameAndAliases(text) : null;
  const membership = await membershipOf(ctx.db, user.id);
  if (!parsed || !membership) return false;
  if (awaiting.kind === "home_kid") {
    await addKid(ctx, user, chatId, membership.household, parsed.name, parsed.aliases);
    return true;
  }
  const target = awaiting.userId ?? user.id;
  if (target !== user.id && membership.role !== "owner") return false;
  if (await nameTaken(ctx, membership.household.id, parsed.name, target)) {
    await ctx.telegram.sendMessage(chatId, t("homeNameTaken", user.locale, { name: parsed.name }));
    return true;
  }
  if (!(await setMemberNameOf(ctx.db, membership.household.id, target, parsed.name, parsed.aliases))) return false;
  await ctx.telegram.sendMessage(chatId, t("homeNameSet", user.locale, { name: parsed.name, aliases: aliasesSuffix(parsed.aliases, user.locale) }));
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
      else if (await nameTaken(ctx, membership.household.id, cmd.name, user.id)) await send(t("homeNameTaken", locale, { name: cmd.name }));
      else {
        await setMemberNameOf(ctx.db, membership.household.id, user.id, cmd.name, cmd.aliases);
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

export async function createHome(ctx: AppContext, user: User, chatId: number, name: string, membership: Membership | null, tgUser: TgUser): Promise<void> {
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
  const shared = defaultHouseholdCalendars(calendars);
  const household = await createHousehold(ctx.db, {
    ownerId: user.id,
    name,
    ownerName: tgUser.first_name,
    calendarIds: shared,
    now: ctx.clock.now(),
  });
  const picker = await calendarsScreen(ctx, household, locale, { done: "done" });
  // Семейного по названию нет — личный не отмечаем сами, спрашиваем и подсказываем создать «Семья» (ревью R1, блокер 2)
  const text = shared.length ? t("homeCreated", locale, { name }) : `${t("homeCreated", locale, { name })}\n\n${t("homeNoFamilyCalendar", locale)}`;
  await ctx.telegram.sendMessage(chatId, escapeHtml(text), { inline_keyboard: picker.buttons }, { html: true });
}

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

export async function addKid(ctx: AppContext, user: User, chatId: number, household: Household, name: string, aliases: string[]): Promise<void> {
  const kids = await dependentsOf(ctx.db, household.id);
  const exists = kids.some((k) => k.name.toLowerCase() === name.toLowerCase());
  // Имя взрослого участника — «Ане» потом не отличить (QA-16)
  if (await nameTaken(ctx, household.id, name)) {
    await ctx.telegram.sendMessage(chatId, t("homeNameTaken", user.locale, { name }));
    return;
  }
  if (!exists && kids.length >= HOUSEHOLD_MAX_DEPENDENTS) {
    await ctx.telegram.sendMessage(chatId, t("homeKidsFull", user.locale, { max: String(HOUSEHOLD_MAX_DEPENDENTS) }));
    return;
  }
  await upsertDependent(ctx.db, household.id, name, aliases);
  await ctx.telegram.sendMessage(chatId, t("homeKidAdded", user.locale, { name, aliases: aliasesSuffix(aliases, user.locale) }));
}

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
  await releaseMemberAssignments(ctx, household.id, user.id);
  await removeMember(ctx.db, household.id, user.id);
  await say(t("homeLeft", user.locale, { name: household.name }));
  await notifyOwner(ctx, household, "homeMemberLeft", membership.displayName);
}

async function nameTaken(ctx: AppContext, householdId: string, name: string, exceptUserId?: string): Promise<boolean> {
  const n = name.toLowerCase();
  const [members, kids] = await Promise.all([membersOf(ctx.db, householdId), dependentsOf(ctx.db, householdId)]);
  return (
    members.some((m) => m.userId !== exceptUserId && m.displayName.toLowerCase() === n) || (!!exceptUserId && kids.some((k) => k.name.toLowerCase() === n))
  );
}

export async function notifyOwner(ctx: AppContext, household: Household, key: "homeMemberLeft" | "homeMemberJoined", name: string): Promise<void> {
  const owner = (await membersOf(ctx.db, household.id)).find((m) => m.role === "owner");
  if (!owner?.telegramId) return;
  const ownerUser = await findUserById(ctx.db, owner.userId);
  await notify(ctx, owner.telegramId, t(key, ownerUser?.locale ?? "ru", { name, home: household.name }));
}

// Приглашение проверяется ДО регистрации: посторонний с неверным кодом не становится пользователем. Приглашённому
// allowlist не нужен.
export async function joinByInvite(ctx: AppContext, from: TgUser, chatId: number, code: string): Promise<void> {
  const lang = from.language_code ?? "ru";
  const now = ctx.clock.now();
  const home = await peekInvite(ctx.db, code, now);
  if (!home) {
    await ctx.telegram.sendMessage(chatId, t("homeInviteInvalid", lang));
    return;
  }
  const { user: registered, created } = await ensureTelegramUser(ctx.db, from.id, now);
  let user = registered;
  if (created && !/^(ru|uk|be)\b/i.test(lang)) {
    await setLocale(ctx.db, user.id, "en");
    user = { ...user, locale: "en" };
  }
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
  const owner = (await membersOf(ctx.db, home.id)).find((m) => m.role === "owner");
  await ctx.telegram.sendMessage(chatId, t("homeJoined", locale, { name: home.name, owner: owner?.displayName || "—" }), {
    inline_keyboard: [[{ text: t("homeTomorrowButton", locale), callback_data: "hm:tmr" }]],
  });
  // Имя задал владелец при приглашении — не переспрашиваем
  if (!preset) await askName(ctx, { ...user, locale }, chatId);
  await notifyOwner(ctx, home, "homeMemberJoined", name);
}

export async function askName(ctx: AppContext, user: User, chatId: number): Promise<void> {
  await awaitHome(ctx, user, chatId, { kind: "home_name" });
  await ctx.telegram.sendMessage(chatId, t("homeAskName", user.locale), { inline_keyboard: roleButtons(user.locale) });
}
