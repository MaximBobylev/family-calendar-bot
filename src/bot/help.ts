// Справка /help и приветствие /start (ревью R1 §4): без LLM, по состоянию — новый пользователь, с Google без дома,
// владелец дома, участник; в группе — короткая справка. «Что ты умеешь», «помощь», «help» — тоже справка.

import { hasGoogleAccount } from "../db/accounts";
import { dependentsOf, type Membership, membersOf, membershipOf } from "../db/households";
import type { User } from "../db/users";
import type { AppContext } from "./context";
import { escapeHtml } from "./format";
import { connectKeyboard } from "./keyboards";
import { t } from "./messages";

/** «/help», «помощь», «справка», «что ты умеешь?», «help» — детерминированно, без LLM. */
const HELP =
  /^(?:\/help(?:@\w+)?|помощь|справка|help|что\s+(?:ты\s+)?(?:умеешь|можешь)|что\s+умеет\s+бот|как\s+(?:тобой|этим)\s+пользоваться|what\s+can\s+you\s+do)[?!.]*$/iu;

export const isHelpRequest = (text: string | undefined) => !!text && HELP.test(text.trim());

/** Справка в личном чате: общая часть + строка по состоянию (без Google — с кнопкой «Подключить»). */
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

/** Справка в группе — как обращаться и как привязать чат. */
export async function sendGroupHelp(ctx: AppContext, user: User, chatId: number): Promise<void> {
  await ctx.telegram.sendMessage(chatId, t("helpGroup", user.locale, { bot: ctx.config.telegramBotUsername || "bot" }));
}

/** /start по состоянию (ревью R1 §4.1). Без Google и дома — с кнопкой «Подключить». */
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
