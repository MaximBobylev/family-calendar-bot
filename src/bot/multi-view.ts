// Текст и кнопки карточки-списка и её итога (макеты М1–М7, М11 в research/multi-event-scenarios.md), без ввода-вывода.
// Состояние строки в тексте повторяет кнопку: ✅ — создам, ⬜ — не создаю, ❓ — не понял, скажите отдельно.

import type { Day } from "../dates/calendar";
import type { InlineKeyboardButton } from "../telegram/types";
import { escapeHtml, hhmm, pluralForm, weekdayShort, whenOf } from "./format";
import { callbackData } from "./callback-data";
import { t } from "./messages";
import { isCreated, mainButton, type MultiCardPayload, type MultiItem, toAsk } from "./multi-logic";

const BUTTON_TITLE = 20;

const ASK_LINE = {
  askWhen: "multiLineAskWhen",
  askZoneTime: "multiLineAskWhen",
  askTime: "multiLineAskTime",
  pick: "multiLinePick",
  inPast: "multiLineInPast",
} as const;

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

export const notDoneLines = (notDone: string[] | undefined, locale: string) =>
  notDone?.length ? `\n\n${notDone.map((text) => t("multiNotDone", locale, { text: escapeHtml(text) })).join("\n")}` : "";

export function multiCardText(p: MultiCardPayload, today: Day, locale: string): string {
  const shared = sharedCalendar(p);
  const blocks = p.items.map((it, i) => {
    const n = i + 1;
    if (!it.option) {
      const on = it.sel === "on";
      return `${on ? "❓" : "⬜"} ${n}. <b>${escapeHtml(titleOf(it, locale))}</b>\n${on ? t(ASK_LINE[it.ask?.question ?? "askWhen"], locale) : t("multiLineOff", locale)}`;
    }
    const mark = it.sel === "on" ? "✅" : "⬜";
    const lines = [`${mark} ${n}. <b>${escapeHtml(titleOf(it, locale))}</b>`];
    const off = it.sel === "off" && !it.dup;
    lines.push(off ? `${whenLine(it, p, today, locale)} — ${t("multiLineOff", locale)}` : `${whenLine(it, p, today, locale)}${responsible(it, locale)}`);
    if (p.showCalendar && !shared) lines.push(`🗓 ${escapeHtml(it.option.calendarTitle)}`);
    if (it.overlap?.length)
      lines.push(
        t("multiOverlap", locale, { list: it.overlap.map((x) => `${escapeHtml(x.title)}, ${hhmm(x.start.minutes)}–${hhmm(x.end.minutes)}`).join("; ") }),
      );
    if (it.dup) {
      const when = `${weekdayShort(it.dup.day, locale)}${it.dup.start ? ` ${hhmm(it.dup.start.minutes)}` : ""}`;
      lines.push(t(it.sel === "on" ? "multiDupOn" : "multiDupOff", locale, { title: escapeHtml(it.dup.title), when }));
    }
    return lines.join("\n");
  });
  return [...head(t("multiHeader", locale), p, locale), "", blocks.join("\n\n")].join("\n") + notDoneLines(p.notDone, locale);
}

const shortTitle = (s: string) => (s.length > BUTTON_TITLE ? `${s.slice(0, BUTTON_TITLE - 1)}…` : s);

export function multiCardButtons(p: MultiCardPayload, actionId: string, locale: string): InlineKeyboardButton[][] {
  const rows: InlineKeyboardButton[][] = p.items.flatMap((it, i) =>
    it.option || it.ask
      ? [
          [
            {
              text: `${it.sel === "off" ? "⬜" : it.option ? "✅" : "❓"} ${i + 1} · ${shortTitle(titleOf(it, locale))}`,
              callback_data: callbackData(actionId, `t${i}`),
            },
          ],
        ]
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
    first = t(created.length ? "created" : "multiNothingReady", locale);
    rows = created.map((it, i) => `${i + 1}. ${line(it)}`);
  } else {
    first = created.length ? t("multiCreatedPartial", locale, { ok: String(created.length), n: String(attempted.length) }) : t("multiNothingCreated", locale);
    rows = attempted.map((it, i) =>
      isCreated(it)
        ? `${i + 1}. ✅ ${line(it)}`
        : `${i + 1}. ❌ ${escapeHtml(titleOf(it, locale))} — ${whenLine(it, p, today, locale)} — ${t("multiFailedLine", locale)}`,
    );
  }
  const skipped = p.items
    .filter((it) => it.sel === "off")
    .map((it) => (it.dup ? t("multiAlreadyExists", locale, { title: escapeHtml(titleOf(it, locale)) }) : escapeHtml(titleOf(it, locale))));
  const unclear = toAsk(p).map((it) => t("multiAskLater", locale, { title: escapeHtml(titleOf(it, locale)) }));
  const tail = [...(skipped.length ? [t("multiSkipped", locale, { list: skipped.join(", ") })] : []), ...unclear];
  return (
    [...head(first, p, locale), ...(rows.length ? ["", rows.join("\n")] : []), ...(tail.length ? ["", ...tail] : [])].join("\n") +
    notDoneLines(p.notDone, locale)
  );
}

export function multiUndoText(deleted: number, kept: string[], locale: string): string {
  return [
    t("undoneMany", locale, { count: eventsCount(deleted, locale) }),
    ...kept.map((title) => t("undoKeptChanged", locale, { title: escapeHtml(title) })),
  ].join("\n");
}
