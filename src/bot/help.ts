// Без LLM: текст зависит от состояния — без Google, без дома, владелец, участник.

import { hasGoogleAccount } from "../db/accounts";
import { dependentsOf, type Membership, membersOf, membershipOf } from "../db/households";
import type { User } from "../db/users";
import type { AppContext } from "./context";
import { escapeHtml } from "./format";
import { connectKeyboard } from "./keyboards";
import { t } from "./messages";

const HELP =
  /^(?:\/help(?:@\w+)?|помощь|справка|help|что\s+(?:ты\s+)?(?:умеешь|можешь)|что\s+умеет\s+бот|как\s+(?:тобой|этим)\s+пользоваться|what\s+can\s+you\s+do)[?!.]*$/iu;

export const isHelpRequest = (text: string | undefined) => !!text && HELP.test(text.trim());

export async function sendHelp(ctx: AppContext, user: User, chatId: number): Promise<void> {
  const l = user.locale;
  const bot = escapeHtml(ctx.config.telegramBotUsername || "bot");
  const [hasGoogle, membership] = await Promise.all([hasGoogleAccount(ctx.db, user.id), membershipOf(ctx.db, user.id)]);
  let tail = "";
  if (!hasGoogle && !membership) tail = t("helpNoGoogle", l);
  else if (!membership) tail = t("helpNoHome", l);
  else if (membership.role !== "owner") tail = t("helpMember", l, { name: escapeHtml(membership.household.name) });
  const markup = !hasGoogle && !membership ? await connectKeyboard(ctx, user.id, l, user.tgName) : undefined;
  await ctx.telegram.sendMessage(chatId, `${t("helpPrivate", l, { bot })}${tail}`, markup, { html: true });
}

export async function sendGroupHelp(ctx: AppContext, user: User, chatId: number): Promise<void> {
  await ctx.telegram.sendMessage(chatId, t("helpGroup", user.locale, { bot: ctx.config.telegramBotUsername || "bot" }));
}

export async function sendStart(ctx: AppContext, user: User, chatId: number, hasGoogle: boolean, membership: Membership | null): Promise<void> {
  const l = user.locale;
  if (!hasGoogle && !membership) {
    await ctx.telegram.sendMessage(chatId, t("startNew", l), await connectKeyboard(ctx, user.id, l, user.tgName));
    return;
  }
  if (!membership) {
    await ctx.telegram.sendMessage(chatId, t("startConnected", l), {
      inline_keyboard: [[{ text: t("startCreateHomeButton", l), callback_data: "hm:new" }]],
    });
    return;
  }
  const members = await membersOf(ctx.db, membership.household.id);
  const owner = members.find((m) => m.role === "owner");
  if (membership.role !== "owner") {
    await ctx.telegram.sendMessage(chatId, t("startMember", l, { name: membership.household.name, owner: owner?.displayName || "—" }));
    return;
  }
  const kids = await dependentsOf(ctx.db, membership.household.id);
  const other = members.find((m) => m.userId !== user.id);
  await ctx.telegram.sendMessage(
    chatId,
    t("startOwner", l, {
      name: membership.household.name,
      members: members.map((m) => m.displayName || "—").join(", "),
      kids: kids.length ? t("startKids", l, { list: kids.map((k) => k.name).join(", ") }) : "",
      other: other?.displayName || (l === "en" ? "Anna" : "Аня"),
    }),
  );
}
