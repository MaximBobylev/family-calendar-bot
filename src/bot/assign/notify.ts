// Сообщения о поручении (US-91): предложения исполнителям, итог автору и в группе, их обновление при каждом переходе
// статуса (взял один — у остальных кнопки убираются). Каждое сообщение — на языке и в поясе своего получателя.

import { telegramChatOf } from "../../db/accounts";
import { addAssignmentMessage, type Assignment, type AssignmentMessage, assignmentMessages } from "../../db/assignments";
import { findUserById } from "../../db/users";
import type { InlineKeyboardButton, ReplyMarkup } from "../../telegram/types";
import type { AppContext } from "../context";
import { t } from "../messages";
import { type Home, memberName } from "./family";
import { assignCallback, assignmentText, doneButtons, offerButtons, whenOfAssignment } from "./view";

export interface Viewer {
  locale: string;
  tz: string;
}

const FALLBACK: Viewer = { locale: "ru", tz: "UTC" };

/** Язык и пояс участника; чат в Telegram. */
export async function viewerOf(ctx: AppContext, userId: string | null): Promise<Viewer & { chatId: string | null }> {
  if (!userId) return { ...FALLBACK, chatId: null };
  const [u, chatId] = await Promise.all([findUserById(ctx.db, userId), telegramChatOf(ctx.db, userId)]);
  return { locale: u?.locale ?? "ru", tz: u?.tz ?? "UTC", chatId };
}

const markup = (rows: InlineKeyboardButton[][]): ReplyMarkup => ({ inline_keyboard: rows });

/** Итог у автора («author») или в групповом чате («group»): статус, детали, «Отменить» пока открыто; в группе — «Беру» для «кто-то должен». */
export async function statusMarkup(
  ctx: AppContext,
  a: Assignment,
  home: Home,
  v: Viewer,
  role: "author" | "group",
): Promise<{ text: string; markup: ReplyMarkup }> {
  const { locale } = v;
  const when = whenOfAssignment(a, ctx.clock.now(), v.tz, locale);
  const p = { title: a.title, when, name: memberName(home, a.assigneeUserId) };
  const offer = t(a.assigneeUserId ? "assignOffer" : "assignOfferSomeone", locale, p);
  const body = assignmentText(offer, a, home, locale, { to: true, now: ctx.clock.now(), tz: v.tz });
  const cancel = [{ text: t("assignCancelButton", locale), callback_data: assignCallback(a.id, "cancel") }];
  switch (a.status) {
    case "pending": {
      const head = t(a.assigneeUserId ? "assignSent" : "assignSentAll", locale);
      const take = role === "group" && !a.assigneeUserId ? [[{ text: t("assignTakeButton", locale), callback_data: assignCallback(a.id, "take") }]] : [];
      return { text: `${head}\n\n${body}`, markup: markup([...take, cancel]) };
    }
    case "accepted":
      return { text: `${t("assignTakenBy", locale, p)}\n\n${body}`, markup: markup([cancel]) };
    case "declined":
      return { text: `${a.assigneeUserId ? t("assignDeclinedBy", locale, p) : t("assignNobody", locale, p)}\n\n${body}`, markup: markup([]) };
    case "done":
      return { text: t("assignDoneBy", locale, p), markup: markup([]) };
    case "cancelled":
      return { text: t("assignCancelledAuthor", locale, p), markup: markup([]) };
    case "expired":
      return { text: t("assignExpired", locale, p), markup: markup([]) };
  }
}

/** Сообщение исполнителю (или кандидату для «кто-то должен»): от статуса и его ответа. */
export function offerMarkup(
  ctx: AppContext,
  a: Assignment,
  home: Home,
  recipientId: string,
  v: Viewer,
  answer: string | null,
): { text: string; markup: ReplyMarkup } {
  const { locale } = v;
  const p = { title: a.title, when: whenOfAssignment(a, ctx.clock.now(), v.tz, locale), name: memberName(home, a.assigneeUserId) };
  const mine = a.assigneeUserId === recipientId;
  const details = (head: string) => assignmentText(head, a, home, locale, { from: true, now: ctx.clock.now(), tz: v.tz });
  switch (a.status) {
    case "pending":
      if (answer === "declined") return { text: t("assignDeclinedYou", locale, p), markup: markup([]) };
      // Автор передал поручение другому — у прежнего кнопки убираем
      if (a.assigneeUserId && !mine) return { text: t("assignPassedOther", locale, p), markup: markup([]) };
      return { text: details(t(a.assigneeUserId ? "assignOffer" : "assignOfferSomeone", locale, p)), markup: markup(offerButtons(a.id, locale)) };
    case "accepted":
      return mine
        ? { text: details(t("assignTakenYou", locale, p)), markup: markup(doneButtons(a.id, locale)) }
        : { text: t("assignTakenOther", locale, p), markup: markup([]) };
    case "declined":
      return { text: t("assignDeclinedYou", locale, p), markup: markup([]) };
    case "done":
      return { text: t("assignDoneYou", locale, p), markup: markup([]) };
    case "cancelled":
      return { text: t("assignCancelledAssignee", locale, p), markup: markup([]) };
    case "expired":
      // Без упрёков: срок прошёл; исполнитель всё ещё может отметить «Сделано»
      return { text: t("assignExpired", locale, p), markup: markup(mine ? doneButtons(a.id, locale) : []) };
  }
}

/** Обновить все сообщения поручения по текущему статусу (кнопки у остальных — убрать, у взявшего — «Сделано»). */
export async function refreshMessages(ctx: AppContext, a: Assignment, home: Home, except?: { chatId: string; messageId: number }): Promise<void> {
  const messages = await assignmentMessages(ctx.db, a.id);
  const author = await viewerOf(ctx, a.createdBy);
  for (const m of messages) {
    if (except && m.chatId === except.chatId && m.messageId === except.messageId) continue;
    const view = await renderMessage(ctx, a, home, m, author);
    await ctx.telegram.editMessageText(m.chatId, m.messageId, view.text, view.markup);
  }
}

export async function renderMessage(
  ctx: AppContext,
  a: Assignment,
  home: Home,
  m: AssignmentMessage,
  author: Viewer,
): Promise<{ text: string; markup: ReplyMarkup }> {
  if (m.role === "offer" && m.userId) return offerMarkup(ctx, a, home, m.userId, await viewerOf(ctx, m.userId), m.answer);
  return statusMarkup(ctx, a, home, author, m.role === "group" ? "group" : "author");
}

/**
 * Предложение исполнителю, а для «кто-то должен» — всем взрослым дома, кроме автора (US-91). Участник без Google —
 * тоже: всё идёт через Telegram. `only` — только этим (повторное предложение другому).
 */
export async function sendOffers(ctx: AppContext, a: Assignment, home: Home, only?: string[]): Promise<void> {
  const recipients = (a.assigneeUserId ? [a.assigneeUserId] : home.members.filter((m) => m.userId !== a.createdBy).map((m) => m.userId)).filter(
    (id) => !only || only.includes(id),
  );
  for (const userId of recipients) {
    const v = await viewerOf(ctx, userId);
    if (!v.chatId) continue;
    const view = offerMarkup(ctx, a, home, userId, v, null);
    const sent = await ctx.telegram.sendMessage(v.chatId, view.text, view.markup);
    await addAssignmentMessage(ctx.db, a.id, { chatId: v.chatId, messageId: sent.message_id, userId, role: "offer" });
  }
}

/** Отдельное сообщение участнику (автору: «Дима взял(а)», исполнителю: «Отменено»). */
export async function notifyMember(ctx: AppContext, userId: string, text: (v: Viewer) => string, rows: (v: Viewer) => InlineKeyboardButton[][] = () => []) {
  const v = await viewerOf(ctx, userId);
  if (!v.chatId) return null;
  return ctx.telegram.sendMessage(v.chatId, text(v), { inline_keyboard: rows(v) });
}
