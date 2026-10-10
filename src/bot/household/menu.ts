// Экран /home: callback_data «hm:<действие>[:<id>]», права проверяются на каждом нажатии, а не при показе кнопок.

import { GoogleCalendarProvider } from "../../calendar/google-provider";
import { hasGoogleAccount } from "../../db/accounts";
import {
  dependentsOf,
  dissolveHousehold,
  type Household,
  householdCalendarIds,
  householdDefaultCalendar,
  householdGroupChats,
  type Member,
  type Membership,
  membersOf,
  membershipOf,
  removeDependent,
  removeMember,
  setHouseholdDefaultCalendar,
  setMemberNameOf,
  toggleHouseholdCalendar,
} from "../../db/households";
import { updateSettings } from "../../db/settings";
import type { User } from "../../db/users";
import { rescheduleDigest } from "../../jobs/digest";
import type { InlineKeyboardButton, TgCallbackQuery } from "../../telegram/types";
import { cancelHouseholdAssignments, releaseMemberAssignments } from "../assign/answers";
import type { AppContext } from "../context";
import { escapeHtml } from "../format";
import { t } from "../messages";
import { askName, awaitHome, clearHomeAwait, leaveHousehold, roleButtons, sendInvite } from "./commands";

type Screen = { text: string; buttons: InlineKeyboardButton[][] };

const cb = (op: string, arg?: string) => `hm:${op}${arg ? `:${arg}` : ""}`;

export const isHouseholdCallback = (data: string | undefined) => !!data?.startsWith("hm:");

function memberLine(m: Member, locale: string, forOwner: boolean): string {
  const marks = [m.role === "owner" ? t("homeOwnerMark", locale) : "", m.hasGoogle || !forOwner ? "" : t("homeNoGoogleMark", locale)].filter(Boolean);
  const name = escapeHtml(m.displayName || "—");
  const aliases = m.aliases.length ? ` — ${escapeHtml(m.aliases.join(", "))}` : "";
  return `• ${name}${marks.length ? ` (${marks.join(", ")})` : ""}${aliases}`;
}

const rowsOf = <T>(items: T[], size: number): T[][] => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, i * size + size));

export async function homeScreen(ctx: AppContext, user: User, membership: Membership): Promise<Screen> {
  const { household } = membership;
  const locale = user.locale;
  const isOwner = membership.role === "owner";
  const [members, kids, calendars] = await Promise.all([membersOf(ctx.db, household.id), dependentsOf(ctx.db, household.id), sharedCalendars(ctx, household)]);
  const main = calendars.find((c) => c.main);
  const lines = [
    `<b>${escapeHtml(t("homeTitle", locale, { name: household.name }))}</b>`,
    "",
    t("homeMembers", locale),
    ...members.map((m) => memberLine(m, locale, isOwner)),
    "",
    kids.length
      ? `${t("homeKids", locale)} ${kids.map((k) => escapeHtml(k.aliases.length ? `${k.name} (${k.aliases.join(", ")})` : k.name)).join(", ")}`
      : t("homeNoKids", locale),
    calendars.length ? t("homeCalendars", locale, { list: escapeHtml(calendars.map((c) => c.title).join(", ")) }) : t("homeNoCalendars", locale),
    ...(main ? [t("homeDefaultCalendar", locale, { name: escapeHtml(main.title) })] : []),
    "",
    t("homeMenuHint", locale),
  ];
  const buttons: InlineKeyboardButton[][] = [];
  if (isOwner) {
    buttons.push([
      { text: t("homeInviteButton", locale), callback_data: cb("inv") },
      { text: t("homeCalendarsButton", locale), callback_data: cb("cal") },
    ]);
    for (const m of members.filter((x) => x.role !== "owner")) {
      buttons.push([
        { text: t("homeEditMemberButton", locale, { name: m.displayName || "—" }), callback_data: cb("nm", m.userId) },
        { text: t("homeRemoveButton", locale, { name: m.displayName || "—" }), callback_data: cb("rm", m.userId) },
      ]);
    }
  }
  buttons.push([
    { text: t("homeEditMeButton", locale), callback_data: cb("nm") },
    { text: t("homeAddKidButton", locale), callback_data: cb("kidadd") },
  ]);
  buttons.push(
    ...rowsOf(
      kids.map((k) => ({ text: t("homeRemoveKidButton", locale, { name: k.name }), callback_data: cb("kid", k.id) })),
      3,
    ),
  );
  buttons.push([
    isOwner ? { text: t("homeDissolveButton", locale), callback_data: cb("dis") } : { text: t("homeLeaveButton", locale), callback_data: cb("leave") },
  ]);
  return { text: lines.join("\n"), buttons };
}

async function sharedCalendars(ctx: AppContext, household: Household): Promise<{ id: string; title: string; main: boolean }[]> {
  const ids = await householdCalendarIds(ctx.db, household.id);
  if (!ids.length) return [];
  const [cals, main] = await Promise.all([
    new GoogleCalendarProvider(ctx.config, ctx.db, household.ownerUserId, ctx.clock, ids).calendars(),
    householdDefaultCalendar(ctx.db, household.id),
  ]);
  return cals.map((c) => ({ id: c.id, title: c.title, main: c.id === main }));
}

// ⭐ «основной» — туда записываются события участников (ревью R1 блокер 2). done: «done» — чек-лист после создания,
// «menu» — экран дома.
export async function calendarsScreen(ctx: AppContext, household: Household, locale: string, o: { done: "done" | "menu" } = { done: "menu" }): Promise<Screen> {
  const [all, shared, main] = await Promise.all([
    new GoogleCalendarProvider(ctx.config, ctx.db, household.ownerUserId, ctx.clock).calendars(),
    householdCalendarIds(ctx.db, household.id),
    householdDefaultCalendar(ctx.db, household.id),
  ]);
  const buttons = all.map((c) => [
    { text: `${shared.includes(c.id) ? "✅" : "▫️"} ${c.title}`, callback_data: cb(o.done === "done" ? "tcn" : "tc", c.id) },
    ...(shared.includes(c.id) && c.writable ? [{ text: c.id === main ? "⭐" : "☆", callback_data: cb(o.done === "done" ? "defn" : "def", c.id) }] : []),
  ]);
  buttons.push([
    { text: t("homeInviteButton", locale), callback_data: cb("inv") },
    { text: t("homeDoneButton", locale), callback_data: cb(o.done) },
  ]);
  return { text: t("homeCalendarsPick", locale, { name: escapeHtml(household.name) }), buttons };
}

function checklistScreen(user: User, household: Household, first: string): Screen {
  const l = user.locale;
  return {
    text: escapeHtml(t("homeChecklist", l, { name: household.name, first: first || "Иван" })),
    buttons: [
      ...roleButtons(l),
      [
        { text: t("homeInviteButton", l), callback_data: cb("inv") },
        { text: t("homeAddKidButton", l), callback_data: cb("kidadd") },
      ],
      [{ text: t("homeTomorrowButton", l), callback_data: cb("tmr") }],
    ],
  };
}

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

export async function handleHouseholdCallback(ctx: AppContext, user: User, cq: TgCallbackQuery): Promise<void> {
  const [, op = "", arg = ""] = (cq.data ?? "").split(":");
  const locale = user.locale;
  const chatId = cq.message?.chat.id ?? cq.from.id;
  const messageId = cq.message?.message_id;
  const membership = await membershipOf(ctx.db, user.id);
  const show = async (screen: Screen) => {
    if (messageId) await ctx.telegram.editMessageText(chatId, messageId, screen.text, { inline_keyboard: screen.buttons }, { html: true });
    else await ctx.telegram.sendMessage(chatId, screen.text, { inline_keyboard: screen.buttons }, { html: true });
  };
  const replace = async (text: string) => {
    if (messageId) await ctx.telegram.editMessageText(chatId, messageId, text);
    else await ctx.telegram.sendMessage(chatId, text);
  };
  if (op === "new") {
    await ctx.telegram.answerCallbackQuery(cq.id);
    if (membership) await ctx.telegram.sendMessage(chatId, t("homeAlreadyIn", locale, { name: membership.household.name }));
    else {
      await awaitHome(ctx, user, chatId, { kind: "home_create" });
      await ctx.telegram.sendMessage(chatId, t("homeAskCreate", locale));
    }
    return;
  }
  if (op === "tmr") {
    await ctx.telegram.answerCallbackQuery(cq.id);
    await updateSettings(ctx.db, user.id, { tomorrowDigest: true });
    await rescheduleDigest(ctx.db, user.id, ctx.clock.now());
    await ctx.telegram.sendMessage(chatId, t("homeTomorrowOn", locale));
    return;
  }
  if (!membership) {
    await ctx.telegram.answerCallbackQuery(cq.id, t("homeNotInHousehold", locale));
    return;
  }
  const { household } = membership;
  const isOwner = membership.role === "owner";
  const ownerOps = new Set(["inv", "cal", "tc", "tcn", "def", "defn", "done", "rm", "rmy", "dis", "disy"]);
  if ((ownerOps.has(op) || (op === "nm" && arg && arg !== user.id)) && !isOwner) {
    await ctx.telegram.answerCallbackQuery(cq.id, t("homeOwnerOnly", locale));
    return;
  }
  await ctx.telegram.answerCallbackQuery(cq.id);
  switch (op) {
    case "menu":
      await show(await homeScreen(ctx, user, membership));
      return;
    case "done": {
      const me = (await membersOf(ctx.db, household.id)).find((m) => m.userId === user.id);
      await awaitHome(ctx, user, chatId, { kind: "home_name" });
      await show(checklistScreen(user, household, me?.displayName ?? ""));
      return;
    }
    case "inv":
      await sendInvite(ctx, user, chatId, household);
      return;
    case "cal":
      await show(await calendarsScreen(ctx, household, locale));
      return;
    case "tc":
    case "tcn":
      await toggleHouseholdCalendar(ctx.db, household, arg);
      await show(await calendarsScreen(ctx, household, locale, { done: op === "tcn" ? "done" : "menu" }));
      return;
    case "def":
    case "defn":
      await setHouseholdDefaultCalendar(ctx.db, household.id, arg);
      await show(await calendarsScreen(ctx, household, locale, { done: op === "defn" ? "done" : "menu" }));
      return;
    case "nm": {
      const target = arg ? (await membersOf(ctx.db, household.id)).find((m) => m.userId === arg) : undefined;
      if (!target || target.userId === user.id) await askName(ctx, user, chatId);
      else {
        await awaitHome(ctx, user, chatId, { kind: "home_name", userId: target.userId });
        await ctx.telegram.sendMessage(chatId, t("homeAskNameOf", locale, { name: target.displayName || "—" }));
      }
      return;
    }
    case "role": {
      const me = (await membersOf(ctx.db, household.id)).find((m) => m.userId === user.id);
      if (!me) return;
      const roles = (arg === "w" ? t("homeRoleWife", locale) : t("homeRoleHusband", locale)).replace(/^\S+\s/, "").split(/,\s*/);
      const aliases = [...me.aliases, ...roles.filter((r) => !me.aliases.some((a) => a.toLowerCase() === r.toLowerCase()))];
      await setMemberNameOf(ctx.db, household.id, user.id, me.displayName, aliases);
      await clearHomeAwait(ctx, user, chatId);
      await ctx.telegram.sendMessage(
        chatId,
        t("homeNameSet", locale, { name: me.displayName, aliases: t("homeAliasesSuffix", locale, { list: aliases.join(", ") }) }),
      );
      return;
    }
    case "kidadd":
      await awaitHome(ctx, user, chatId, { kind: "home_kid" });
      await ctx.telegram.sendMessage(chatId, t("homeAskKid", locale));
      return;
    case "rm": {
      const m = (await membersOf(ctx.db, household.id)).find((x) => x.userId === arg && x.role !== "owner");
      if (!m) return void (await show(await homeScreen(ctx, user, membership)));
      await show({
        text: escapeHtml(t("homeRemoveConfirm", locale, { name: m.displayName || "—", home: household.name })),
        buttons: [
          [
            { text: t("homeRemoveYes", locale), callback_data: cb("rmy", m.userId) },
            { text: t("cancelButton", locale), callback_data: cb("menu") },
          ],
        ],
      });
      return;
    }
    case "rmy": {
      const removed = (await membersOf(ctx.db, household.id)).find((m) => m.userId === arg && m.role !== "owner");
      if (removed) {
        await releaseMemberAssignments(ctx, household.id, removed.userId);
        if (await removeMember(ctx.db, household.id, removed.userId)) {
          await ctx.telegram.sendMessage(chatId, t("homeRemoved", locale, { name: removed.displayName }));
          if (removed.telegramId) await notify(ctx, removed.telegramId, t("homeYouWereRemoved", locale, { name: household.name }));
        }
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

// Уведомления — до удаления: потом не узнать, кому писать.
export async function dissolveWithNotice(ctx: AppContext, household: Household, ownerId: string, locale: string): Promise<void> {
  const members = (await membersOf(ctx.db, household.id)).filter((m) => m.userId !== ownerId && m.telegramId);
  const groups = await householdGroupChats(ctx.db, household.id);
  const text = t("homeDissolvedNotice", locale, { name: household.name });
  await cancelHouseholdAssignments(ctx, household.id).catch((e) => console.warn("dissolve: assignments", e instanceof Error ? e.message : e));
  await dissolveHousehold(ctx.db, household.id);
  for (const chat of [...members.map((m) => m.telegramId!), ...groups]) await notify(ctx, chat, text);
}

// Best-effort: человек мог заблокировать бота.
export async function notify(ctx: AppContext, chatId: string | number, text: string): Promise<void> {
  await ctx.telegram.sendMessage(chatId, text).catch((e) => console.warn("household notify failed", e instanceof Error ? e.message : e));
}
