// US-20 / US-21: «Что у меня завтра?», «Покажи неделю», «Что в пятницу в семейном?»

import type { CalendarInfo, CalendarProvider } from "../calendar/model";
import { DAY_PART_BOUNDS } from "../dates/lexicon";
import { formatMoment, localToUtc, parseLocal, utcToLocal, type Day, type Moment } from "../dates/calendar";
import { parseDateFragment, type ParseValue } from "../dates";
import { mergeDialogState } from "../db/conversations";
import type { AppContext } from "./context";
import { dayTitle, formatEvents } from "./format-events";
import { orderForDisplay } from "./format";
import { t } from "./messages";

interface Period {
  fromDay: Day;
  toDay: Day;
  from: Moment;
  /** Исключительно. */
  to: Moment;
}

function periodOf(v: ParseValue): Period | null {
  const day = (s: string) => parseLocal(`${s.slice(0, 10)}T00:00`).day;
  if ("range" in v) {
    const timed = v.range.from.includes("T");
    if (timed) {
      const from = parseLocal(v.range.from);
      const to = parseLocal(v.range.to);
      return { fromDay: from.day, toDay: to.minutes === 0 ? to.day - 1 : to.day, from, to };
    }
    const fromDay = day(v.range.from);
    const toDay = day(v.range.to);
    return { fromDay, toDay, from: { day: fromDay, minutes: 0 }, to: { day: toDay + 1, minutes: 0 } };
  }
  if ("date" in v) {
    const d = typeof v.date === "string" ? day(v.date) : day(v.date.date);
    if (typeof v.date !== "string") {
      const [s, e] = DAY_PART_BOUNDS[v.date.part];
      return { fromDay: d, toDay: d, from: { day: d, minutes: s }, to: { day: d, minutes: e } };
    }
    return { fromDay: d, toDay: d, from: { day: d, minutes: 0 }, to: { day: d + 1, minutes: 0 } };
  }
  if ("datetime" in v) {
    const m = parseLocal(v.datetime);
    return { fromDay: m.day, toDay: m.day, from: { day: m.day, minutes: 0 }, to: { day: m.day + 1, minutes: 0 } };
  }
  return null;
}

/** Календарь по имени или алиасу (US-06). LLM получает список календарей и должна вернуть точное имя. */
async function findCalendar(ctx: AppContext, userId: string, calendars: CalendarInfo[], name: string): Promise<CalendarInfo | null> {
  const needle = name.trim().toLowerCase();
  const alias = await ctx.db
    .prepare("SELECT calendar_id FROM calendar_aliases WHERE user_id = ? AND lower(alias) = ?")
    .bind(userId, needle)
    .first<{ calendar_id: string }>();
  if (alias) return calendars.find((c) => c.id === alias.calendar_id) ?? null;
  return calendars.find((c) => c.title.toLowerCase() === needle) ?? null;
}

export async function readEvents(
  ctx: AppContext,
  provider: CalendarProvider,
  args: { userId: string; chatId: number; conversationId: string; locale: string; tz: string; range: string; calendar?: string },
): Promise<void> {
  const { chatId, locale, tz } = args;
  const now = utcToLocal(ctx.clock.now(), tz);
  const parsed = parseDateFragment({ text: args.range, kind: "range", now: formatMoment(now), tz });

  if ("error" in parsed) {
    await ctx.telegram.sendMessage(chatId, t("rangeUnparseable", locale));
    return;
  }
  if ("ambiguous" in parsed) {
    const options = parsed.ambiguous
      .map(periodOf)
      .filter((p): p is Period => p !== null)
      .map((p) => (p.fromDay === p.toDay ? dayTitle(p.fromDay, now.day, locale) : `${dayTitle(p.fromDay, now.day, locale)} — ${dayTitle(p.toDay, now.day, locale)}`));
    await ctx.telegram.sendMessage(chatId, t("rangeAmbiguous", locale, { options: options.join(` ${t("or", locale)} `) }));
    return;
  }
  const period = periodOf(parsed);
  if (!period) {
    await ctx.telegram.sendMessage(chatId, t("rangeUnparseable", locale));
    return;
  }

  const calendars = await provider.calendars();
  let only: CalendarInfo | null = null;
  if (args.calendar) {
    only = await findCalendar(ctx, args.userId, calendars, args.calendar);
    if (!only) {
      await ctx.telegram.sendMessage(chatId, t("calendarNotFound", locale, { name: args.calendar, list: calendars.map((c) => `«${c.title}»`).join(", ") }));
      return;
    }
  }

  const events = (await provider.listEvents(localToUtc(period.from, tz), localToUtc(period.to, tz), tz)).filter(
    (e) => !only || e.ref.calendarId === only.id,
  );
  // Порядок как в выводе — для «перенеси вторую» (US-60)
  const ordered = orderForDisplay(events.filter((e) => e.endDay >= period.fromDay && Math.max(e.startDay, period.fromDay) <= period.toDay), period.fromDay);
  await mergeDialogState(ctx.db, args.conversationId, args.userId, { lastList: { refs: ordered.map((e) => e.ref), at: ctx.clock.now() } }, ctx.clock.now());
  const defaultId = calendars.find((c) => c.isDefault)?.id;
  const messages = formatEvents(events, period.fromDay, period.toDay, now.day, locale, (id) => !only && calendars.length > 1 && id !== defaultId);
  for (const text of messages) await ctx.telegram.sendMessage(chatId, text, undefined, { html: true });
}

