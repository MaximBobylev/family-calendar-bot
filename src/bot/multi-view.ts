// Текст и кнопки карточки-списка и её итога (макеты М1–М7, М11 в research/multi-event-scenarios.md), без ввода-вывода.
// Состояние строки в тексте повторяет кнопку: ✅ — создам, ⬜ — не создаю, ❓ — не понял, скажите отдельно.

import type { Day } from "../dates/calendar";
import type { InlineKeyboardButton } from "../telegram/types";
import { escapeHtml, hhmm, pluralForm, whenOf } from "./format";
import { callbackData } from "./callback-data";
import { t } from "./messages";
import { isCreated, mainButton, type MultiCardPayload, type MultiItem } from "./multi-logic";

const BUTTON_TITLE = 20;

const titleOf = (it: MultiItem, locale: string) => it.title || t("defaultTitle", locale);

function whenLine(it: MultiItem, p: MultiCardPayload, today: Day, locale: string): string {
  const o = it.option!;
  if (o.series) {
    const time = o.allDay ? t("allDayLower", locale) : `${hhmm(o.start!.minutes)}–${hhmm(o.end!.minutes)}`;
    return `🔁 ${escapeHtml(o.series.text)}, ${time}`;
  }
  const when = whenOf(o, today, locale);
  return it.birthday && p.yearly ? `${when}, ${t("multiEveryYear", locale)}` : when;
}

const responsible = (it: MultiItem, locale: string) =>
  it.family?.responsibleName ? ` · ${t("multiResponsible", locale, { name: escapeHtml(it.family.responsibleName) })}` : "";

/** Один календарь у всех — строкой под заголовком; разные — у каждой строки. */
function sharedCalendar(p: MultiCardPayload): string | undefined {
  if (!p.showCalendar) return undefined;
  const titles = new Set(p.items.flatMap((it) => (it.option ? [it.option.calendarTitle] : [])));
  return titles.size === 1 ? [...titles][0] : undefined;
}

function head(first: string, p: MultiCardPayload, locale: string): string[] {
  const shared = sharedCalendar(p);
  const lines = [first];
  if (shared) lines.push(`🗓 ${escapeHtml(shared)}`);
  if (p.forwardedFrom !== undefined)
    lines.push(p.forwardedFrom ? t("multiFromForwardBy", locale, { name: escapeHtml(p.forwardedFrom) }) : t("multiFromForward", locale));
  return lines;
}

export function multiCardText(p: MultiCardPayload, today: Day, locale: string): string {
  const shared = sharedCalendar(p);
  const blocks = p.items.map((it, i) => {
    const n = i + 1;
    if (!it.option) return `❓ ${n}. <b>${escapeHtml(titleOf(it, locale))}</b>\n${t("multiLineSayApart", locale)}`;
    const mark = it.sel === "on" ? "✅" : "⬜";
    const lines = [`${mark} ${n}. <b>${escapeHtml(titleOf(it, locale))}</b>`];
    lines.push(
      it.sel === "on" ? `${whenLine(it, p, today, locale)}${responsible(it, locale)}` : `${whenLine(it, p, today, locale)} — ${t("multiLineOff", locale)}`,
    );
    if (p.showCalendar && !shared) lines.push(`🗓 ${escapeHtml(it.option.calendarTitle)}`);
    return lines.join("\n");
  });
  return [...head(t("multiHeader", locale), p, locale), "", blocks.join("\n\n")].join("\n");
}

const shortTitle = (s: string) => (s.length > BUTTON_TITLE ? `${s.slice(0, BUTTON_TITLE - 1)}…` : s);

export function multiCardButtons(p: MultiCardPayload, actionId: string, locale: string): InlineKeyboardButton[][] {
  const rows: InlineKeyboardButton[][] = p.items.flatMap((it, i) =>
    it.option
      ? [[{ text: `${it.sel === "on" ? "✅" : "⬜"} ${i + 1} · ${shortTitle(titleOf(it, locale))}`, callback_data: callbackData(actionId, `t${i}`) }]]
      : [],
  );
  if (p.items.some((it) => it.birthday))
    rows.push([{ text: t(p.yearly ? "multiYearlyOn" : "multiYearlyOff", locale), callback_data: callbackData(actionId, "y") }]);
  const main = mainButton(p);
  rows.push([
    { text: t(main.key, locale, { n: String(main.n) }), callback_data: callbackData(actionId, "c") },
    { text: t("cancelButton", locale), callback_data: callbackData(actionId, "x") },
  ]);
  return rows;
}

export function eventsCount(n: number, locale: string): string {
  const form = pluralForm(n, locale);
  return t(form === "one" ? "eventsOne" : form === "few" ? "eventsFew" : "eventsMany", locale, { n: String(n) });
}

/** Итог на месте карточки: все создано — «✅ Создано» с новыми номерами (US-60); есть сбои — по строкам ✅ / ❌. */
export function multiSummaryText(p: MultiCardPayload, today: Day, locale: string): string {
  const attempted = p.items.filter((it) => it.option && it.sel === "on");
  const created = attempted.filter(isCreated);
  const failed = attempted.length - created.length;
  const titleLink = (it: MultiItem) => {
    const d = it.done && "ref" in it.done ? it.done : undefined;
    const title = escapeHtml(titleOf(it, locale));
    return d?.link ? `<a href="${escapeHtml(d.link)}">${title}</a>` : `<b>${title}</b>`;
  };
  const line = (it: MultiItem) => `${titleLink(it)} — ${whenLine(it, p, today, locale)}${responsible(it, locale)}`;
  let first: string;
  let rows: string[];
  if (failed === 0) {
    first = t("created", locale);
    rows = created.map((it, i) => `${i + 1}. ${line(it)}`);
  } else {
    first = created.length ? t("multiCreatedPartial", locale, { ok: String(created.length), n: String(attempted.length) }) : t("multiNothingCreated", locale);
    rows = attempted.map((it, i) =>
      isCreated(it)
        ? `${i + 1}. ✅ ${line(it)}`
        : `${i + 1}. ❌ ${escapeHtml(titleOf(it, locale))} — ${whenLine(it, p, today, locale)} — ${t("multiFailedLine", locale)}`,
    );
  }
  const skipped = p.items.filter((it) => it.option && it.sel === "off").map((it) => escapeHtml(titleOf(it, locale)));
  const unclear = p.items.filter((it) => !it.option).map((it) => t("multiSayApartLater", locale, { title: escapeHtml(titleOf(it, locale)) }));
  const tail = [...(skipped.length ? [t("multiSkipped", locale, { list: skipped.join(", ") })] : []), ...unclear];
  return [...head(first, p, locale), "", rows.join("\n"), ...(tail.length ? ["", ...tail] : [])].join("\n");
}

export function multiUndoText(deleted: number, kept: string[], locale: string): string {
  return [
    t("undoneMany", locale, { count: eventsCount(deleted, locale) }),
    ...kept.map((title) => t("undoKeptChanged", locale, { title: escapeHtml(title) })),
  ].join("\n");
}
