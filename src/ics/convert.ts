// Событие из .ics → что создаём (US-67): время в поясе пользователя, конец по DTEND/DURATION или длительности по умолчанию.

import { addMinutes, type Day, localToUtc, type Moment, parseLocal, utcToLocal } from "../dates/calendar";
import type { IcsEvent, IcsTime } from "./parse";

/** Локальное время — в поясе пользователя `tz`. */
export interface IcsItem {
  title?: string;
  allDay: boolean;
  startDay: Day;
  /** Для «весь день» — включительно. */
  endDay: Day;
  start?: Moment;
  end?: Moment;
  tz: string;
  location?: string;
  description?: string;
  rrule?: string;
  uid?: string;
}

const MAX_TEXT = 1000;

function utcOf(t: Exclude<IcsTime, { kind: "date" }>, userTz: string): number {
  const m = parseLocal(t.local);
  if (t.kind === "utc") return localToUtc(m, "UTC");
  return localToUtc(m, t.kind === "zoned" ? t.tz : userTz);
}

const dayOf = (date: string) => parseLocal(`${date}T00:00`).day;

export function icsToItem(e: IcsEvent, userTz: string, defaultDurationMin: number): IcsItem {
  const common = {
    tz: userTz,
    ...(e.summary ? { title: e.summary.slice(0, 200) } : {}),
    ...(e.location ? { location: e.location.slice(0, 300) } : {}),
    ...(e.description ? { description: e.description.slice(0, MAX_TEXT) } : {}),
    ...(e.rrule ? { rrule: e.rrule } : {}),
    ...(e.uid ? { uid: e.uid } : {}),
  };
  if (e.start.kind === "date") {
    const startDay = dayOf(e.start.date);
    let endDay = startDay;
    // DTEND для дат — исключающая
    if (e.end?.kind === "date") endDay = Math.max(startDay, dayOf(e.end.date) - 1);
    else if (e.durationMin && e.durationMin >= 1440) endDay = startDay + Math.ceil(e.durationMin / 1440) - 1;
    return { ...common, allDay: true, startDay, endDay };
  }
  const startUtc = utcOf(e.start, userTz);
  const start = utcToLocal(startUtc, userTz);
  let end: Moment | undefined;
  if (e.end && e.end.kind !== "date") {
    const endUtc = utcOf(e.end, userTz);
    if (endUtc > startUtc) end = utcToLocal(endUtc, userTz);
  } else if (e.durationMin && e.durationMin > 0) {
    end = utcToLocal(startUtc + e.durationMin * 60_000, userTz);
  }
  end ??= addMinutes(start, defaultDurationMin);
  return { ...common, allDay: false, start, end, startDay: start.day, endDay: end.day };
}
