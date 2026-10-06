// /home — экран дома (US-90): состав, дети, общие календари; кнопки владельца (пригласить, календари, убрать участника,
// распустить) и участника (выйти). Нажатия — callback_data «hm:<действие>[:<id>]», права проверяются на каждом нажатии.

import { GoogleCalendarProvider } from "../../calendar/google-provider";
import { hasGoogleAccount } from "../../db/accounts";
import {
  dependentsOf,
  dissolveHousehold,
  type Household,
  householdCalendarIds,
  householdGroupChats,
  type Member,
  type Membership,
  membersOf,
  membershipOf,
  removeDependent,
  removeMember,
  toggleHouseholdCalendar,
} from "../../db/households";
import type { User } from "../../db/users";
import type { InlineKeyboardButton, TgCallbackQuery } from "../../telegram/types";
import type { AppContext } from "../context";
import { escapeHtml } from "../format";
import { t } from "../messages";
import { leaveHousehold, sendInvite } from "./commands";

type Screen = { text: string; buttons: InlineKeyboardButton[][] };

const cb = (op: string, arg?: string) => `hm:${op}${arg ? `:${arg}` : ""}`;

export const isHouseholdCallback = (data: string | undefined) => !!data?.startsWith("hm:");

function memberLine(m: Member, locale: string): string {
  const marks = [m.role === "owner" ? t("homeOwnerMark", locale) : "", m.hasGoogle ? "" : t("homeNoGoogleMark", locale)].filter(Boolean);
  const name = escapeHtml(m.displayName || "—");
  const aliases = m.aliases.length ? ` — ${escapeHtml(m.aliases.join(", "))}` : "";
  return `• ${name}${marks.length ? ` (${marks.join(", ")})` : ""}${aliases}`;
}

/** Экран дома: текст (HTML) и кнопки по роли. */
export async function homeScreen(ctx: AppContext, user: User, membership: Membership): Promise<Screen> {
  const { household } = membership;
  const locale = user.locale;
  const [members, kids, calendars] = await Promise.all([
    membersOf(ctx.db, household.id),
    dependentsOf(ctx.db, household.id),
    sharedCalendarTitles(ctx, household),
  ]);
  const lines = [
    `<b>${escapeHtml(t("homeTitle", locale, { name: household.name }))}</b>`,
    "",
    t("homeMembers", locale),
    ...members.map((m) => memberLine(m, locale)),
    "",
    kids.length
      ? `${t("homeKids", locale)} ${kids.map((k) => escapeHtml(k.aliases.length ? `${k.name} (${k.aliases.join(", ")})` : k.name)).join(", ")}`
      : t("homeNoKids", locale),
    calendars.length ? t("homeCalendars", locale, { list: escapeHtml(calendars.join(", ")) }) : t("homeNoCalendars", locale),
    "",
    t("homeMenuHint", locale),
  ];
  const buttons: InlineKeyboardButton[][] = [];
  if (membership.role === "owner") {
    buttons.push([
      { text: t("homeInviteButton", locale), callback_data: cb("inv") },
      { text: t("homeCalendarsButton", locale), callback_data: cb("cal") },
    ]);
    const others = members.filter((m) => m.role !== "owner");
    for (const m of others) buttons.push([{ text: t("homeRemoveButton", locale, { name: m.displayName || "—" }), callback_data: cb("rm", m.userId) }]);
  }
  for (const k of kids) buttons.push([{ text: t("homeRemoveButton", locale, { name: k.name }), callback_data: cb("kid", k.id) }]);
  buttons.push([
    membership.role === "owner"
      ? { text: t("homeDissolveButton", locale), callback_data: cb("dis") }
      : { text: t("homeLeaveButton", locale), callback_data: cb("leave") },
  ]);
  return { text: lines.join("\n"), buttons };
}

/** Названия общих календарей дома (из D1, без Google). */
async function sharedCalendarTitles(ctx: AppContext, household: Household): Promise<string[]> {
  const ids = await householdCalendarIds(ctx.db, household.id);
  if (!ids.length) return [];
  const cals = await new GoogleCalendarProvider(ctx.config, ctx.db, household.ownerUserId, ctx.clock, ids).calendars();
  return cals.map((c) => c.title);
}

/** Выбор общих календарей: все календари владельца, отмеченные — общие. */
export async function calendarsScreen(ctx: AppContext, household: Household, locale: string): Promise<Screen> {
  const [all, shared] = await Promise.all([
    new GoogleCalendarProvider(ctx.config, ctx.db, household.ownerUserId, ctx.clock).calendars(),
    householdCalendarIds(ctx.db, household.id),
  ]);
  const buttons = all.map((c) => [{ text: `${shared.includes(c.id) ? "✅" : "▫️"} ${c.title}`, callback_data: cb("tc", c.id) }]);
  buttons.push([
    { text: t("homeInviteButton", locale), callback_data: cb("inv") },
    { text: t("homeDoneButton", locale), callback_data: cb("menu") },
  ]);
  return { text: t("homeCalendarsPick", locale, { name: escapeHtml(household.name) }), buttons };
}

/** /home в личном чате. */
export async function showHome(ctx: AppContext, user: User, chatId: number): Promise<void> {
  const membership = await membershipOf(ctx.db, user.id);
  if (!membership) {
    const key = (await hasGoogleAccount(ctx.db, user.id)) ? "homeNone" : "homeNoneNoGoogle";
    await ctx.telegram.sendMessage(chatId, t(key, user.locale));
    return;
  }
  const screen = await homeScreen(ctx, user, membership);
  await ctx.telegram.sendMessage(chatId, screen.text, { inline_keyboard: screen.buttons }, { html: true });
}

/** Нажатие кнопки экрана дома (только личный чат). */
export async function handleHouseholdCallback(ctx: AppContext, user: User, cq: TgCallbackQuery): Promise<void> {
  const [, op = "", arg = ""] = (cq.data ?? "").split(":");
  const locale = user.locale;
  const chatId = cq.message?.chat.id ?? cq.from.id;
  const messageId = cq.message?.message_id;
  const membership = await membershipOf(ctx.db, user.id);
  if (!membership) {
    await ctx.telegram.answerCallbackQuery(cq.id, t("homeNotInHousehold", locale));
    return;
  }
  const { household } = membership;
  const isOwner = membership.role === "owner";
  const show = async (screen: Screen) => {
    if (messageId) await ctx.telegram.editMessageText(chatId, messageId, screen.text, { inline_keyboard: screen.buttons }, { html: true });
    else await ctx.telegram.sendMessage(chatId, screen.text, { inline_keyboard: screen.buttons }, { html: true });
  };
  const replace = async (text: string) => {
    if (messageId) await ctx.telegram.editMessageText(chatId, messageId, text);
    else await ctx.telegram.sendMessage(chatId, text);
  };
  const ownerOps = new Set(["inv", "cal", "tc", "rm", "dis", "disy"]);
  if (ownerOps.has(op) && !isOwner) {
    await ctx.telegram.answerCallbackQuery(cq.id, t("homeOwnerOnly", locale));
    return;
  }
  await ctx.telegram.answerCallbackQuery(cq.id);
  switch (op) {
    case "menu":
      await show(await homeScreen(ctx, user, membership));
      return;
    case "inv":
      await sendInvite(ctx, user, chatId, household);
      return;
    case "cal":
      await show(await calendarsScreen(ctx, household, locale));
      return;
    case "tc":
      await toggleHouseholdCalendar(ctx.db, household, arg);
      await show(await calendarsScreen(ctx, household, locale));
      return;
    case "rm": {
      const removed = (await membersOf(ctx.db, household.id)).find((m) => m.userId === arg && m.role !== "owner");
      if (removed && (await removeMember(ctx.db, household.id, removed.userId))) {
        await ctx.telegram.sendMessage(chatId, t("homeRemoved", locale, { name: removed.displayName }));
        if (removed.telegramId) await notify(ctx, removed.telegramId, t("homeYouWereRemoved", locale, { name: household.name }));
      }
      await show(await homeScreen(ctx, user, membership));
      return;
    }
    case "kid": {
      const name = await removeDependent(ctx.db, household.id, arg);
      if (name) await ctx.telegram.sendMessage(chatId, t("homeKidRemoved", locale, { name }));
      await show(await homeScreen(ctx, user, membership));
      return;
    }
    case "leave":
      await leaveHousehold(ctx, user, chatId, membership, messageId);
      return;
    case "dis":
      await show({
        text: escapeHtml(t("homeDissolveConfirm", locale, { name: household.name })),
        buttons: [
          [
            { text: t("homeDissolveYes", locale), callback_data: cb("disy") },
            { text: t("cancelButton", locale), callback_data: cb("menu") },
          ],
        ],
      });
      return;
    case "disy":
      await dissolveWithNotice(ctx, household, user.id, locale);
      await replace(t("homeDissolved", locale, { name: household.name }));
      return;
  }
}

/**
 * Распустить дом с уведомлением участников и групповых чатов (US-90; владелец решил сам или отключил бота — US-03,
 * [решение 2026-10-06]). Уведомления — до удаления: потом не узнать, кому писать.
 */
export async function dissolveWithNotice(ctx: AppContext, household: Household, ownerId: string, locale: string): Promise<void> {
  const members = (await membersOf(ctx.db, household.id)).filter((m) => m.userId !== ownerId && m.telegramId);
  const groups = await householdGroupChats(ctx.db, household.id);
  const text = t("homeDissolvedNotice", locale, { name: household.name });
  await dissolveHousehold(ctx.db, household.id);
  for (const chat of [...members.map((m) => m.telegramId!), ...groups]) await notify(ctx, chat, text);
}

/** Уведомление другому человеку — best-effort: он мог заблокировать бота. */
export async function notify(ctx: AppContext, chatId: string | number, text: string): Promise<void> {
  await ctx.telegram.sendMessage(chatId, text).catch((e) => console.warn("household notify failed", e instanceof Error ? e.message : e));
}
