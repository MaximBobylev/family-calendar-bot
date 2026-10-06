// US-67: разбор файла приглашения .ics (RFC 5545) детерминированно, без LLM. VEVENT: UID, SUMMARY, LOCATION,
// DESCRIPTION, DTSTART/DTEND/DURATION (UTC, TZID, «плавающее», DATE), RRULE — как есть. Чистый модуль (юнит-тесты):
// время возвращается как в файле, перевод в пояс пользователя — src/bot/ics-import.ts.

export type IcsTime =
  /** Событие на весь день: «2026-10-15». */
  | { kind: "date"; date: string }
  /** Момент в UTC (…Z): «2026-10-15T09:30». */
  | { kind: "utc"; local: string }
  /** Локальное время в поясе (IANA, уже приведён): «2026-10-15T09:30». */
  | { kind: "zoned"; local: string; tz: string }
  /** Без пояса — в поясе пользователя. */
  | { kind: "floating"; local: string };

export interface IcsEvent {
  uid?: string;
  summary?: string;
  location?: string;
  description?: string;
  start: IcsTime;
  end?: IcsTime;
  /** DURATION вместо DTEND, минуты. */
  durationMin?: number;
  /** Правило повторения как в файле: «RRULE:FREQ=WEEKLY;BYDAY=MO». */
  rrule?: string;
  /** TZID есть, но такого пояса мы не знаем — время считаем в поясе пользователя. */
  unknownTz?: string;
}

export type IcsResult = { events: IcsEvent[] } | { error: "not_calendar" | "no_events" };

/** Самые частые не-IANA пояса (Outlook/Exchange пишут Windows-имена). */
const WINDOWS_TZ: Record<string, string> = {
  "russian standard time": "Europe/Moscow",
  "russia time zone 3": "Europe/Samara",
  "ekaterinburg standard time": "Asia/Yekaterinburg",
  "n. central asia standard time": "Asia/Novosibirsk",
  "kaliningrad standard time": "Europe/Kaliningrad",
  "w. europe standard time": "Europe/Berlin",
  "central europe standard time": "Europe/Budapest",
  "romance standard time": "Europe/Paris",
  "gmt standard time": "Europe/London",
  "fle standard time": "Europe/Kiev",
  "turkey standard time": "Europe/Istanbul",
  "georgian standard time": "Asia/Tbilisi",
  "caucasus standard time": "Asia/Yerevan",
  "azerbaijan standard time": "Asia/Baku",
  "central asia standard time": "Asia/Almaty",
  "eastern standard time": "America/New_York",
  "central standard time": "America/Chicago",
  "pacific standard time": "America/Los_Angeles",
  utc: "UTC",
  "coordinated universal time": "UTC",
};

function isIana(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** TZID → IANA: как есть, Windows-имя или хвост «/mozilla.org/…/Europe/Moscow»; не знаем — undefined. */
export function resolveTzid(tzid: string): string | undefined {
  const raw = tzid.trim().replace(/^"|"$/g, "");
  if (!raw) return undefined;
  if (/^[A-Za-z_]+\/[A-Za-z_+\-/]+$/.test(raw) && isIana(raw)) return raw;
  const win = WINDOWS_TZ[raw.toLowerCase()];
  if (win) return win;
  const segs = raw.split("/").filter(Boolean);
  for (let i = Math.max(0, segs.length - 3); i < segs.length - 1; i++) {
    const tail = segs.slice(i).join("/");
    if (/^[A-Za-z]/.test(tail) && isIana(tail)) return tail;
  }
  return undefined;
}

/** Склейка свёрнутых строк: продолжение начинается с пробела или табуляции (RFC 5545 §3.1). */
export function unfold(text: string): string[] {
  return text
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n")
    .filter((l) => l.trim() !== "");
}

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

/** «NAME;P1=v;P2="a:b":value» — двоеточие внутри кавычек не разделитель. */
function parseLine(line: string): Prop | undefined {
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === ":" && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return undefined;
  const [name = "", ...rawParams] = line.slice(0, colon).split(";");
  const params: Record<string, string> = {};
  for (const p of rawParams) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: name.toUpperCase(), params, value: line.slice(colon + 1) };
}

const unescapeText = (s: string) => s.replace(/\\([\\;,nN])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));

function parseTime(p: Prop): { time: IcsTime; unknownTz?: string } | undefined {
  const v = p.value.trim();
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (date || p.params.VALUE === "DATE") {
    const d = date ?? /^(\d{4})(\d{2})(\d{2})/.exec(v);
    return d ? { time: { kind: "date", date: `${d[1]}-${d[2]}-${d[3]}` } } : undefined;
  }
  const dt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z?)$/i.exec(v);
  if (!dt) return undefined;
  const local = `${dt[1]}-${dt[2]}-${dt[3]}T${dt[4]}:${dt[5]}`;
  if (dt[7]) return { time: { kind: "utc", local } };
  if (p.params.TZID) {
    const tz = resolveTzid(p.params.TZID);
    return tz ? { time: { kind: "zoned", local, tz } } : { time: { kind: "floating", local }, unknownTz: p.params.TZID };
  }
  return { time: { kind: "floating", local } };
}

/** DURATION: P1D, PT1H30M, P1W, P1DT2H → минуты; отрицательная или битая — undefined. */
export function parseDuration(v: string): number | undefined {
  const m = /^\+?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(v.trim());
  if (!m || v.trim() === "P" || /^\+?PT?$/i.test(v.trim())) return undefined;
  const [, w, d, h, min] = m.map((x) => Number(x ?? 0));
  return (w! * 7 + d!) * 1440 + h! * 60 + min!;
}

export function parseIcs(text: string): IcsResult {
  const lines = unfold(text);
  if (!lines.some((l) => /^BEGIN:VCALENDAR$/i.test(l.trim()))) return { error: "not_calendar" };
  const events: IcsEvent[] = [];
  let cur: Prop[] | undefined;
  let depth = 0; // вложенные компоненты (VALARM) внутри VEVENT — пропускаем их свойства
  for (const line of lines) {
    const p = parseLine(line.trim());
    if (!p) continue;
    if (p.name === "BEGIN" && p.value.toUpperCase() === "VEVENT") {
      cur = [];
      depth = 0;
      continue;
    }
    if (!cur) continue;
    if (p.name === "BEGIN") depth++;
    else if (p.name === "END" && depth > 0) depth--;
    else if (p.name === "END" && p.value.toUpperCase() === "VEVENT") {
      const e = toEvent(cur);
      if (e) events.push(e);
      cur = undefined;
    } else if (depth === 0) cur.push(p);
  }
  return events.length ? { events } : { error: "no_events" };
}

function toEvent(props: Prop[]): IcsEvent | undefined {
  const get = (name: string) => props.find((p) => p.name === name);
  // Отменённые и исключения серии (RECURRENCE-ID — правка одного повторения) не импортируем
  if (get("STATUS")?.value.trim().toUpperCase() === "CANCELLED" || get("RECURRENCE-ID")) return undefined;
  const dtstart = get("DTSTART");
  const start = dtstart && parseTime(dtstart);
  if (!start) return undefined;
  const text = (name: string) => {
    const v = get(name)?.value;
    const s = v === undefined ? undefined : unescapeText(v).trim();
    return s ? { [name.toLowerCase()]: s } : {};
  };
  const dtend = get("DTEND");
  const end = dtend && parseTime(dtend);
  const dur = get("DURATION");
  const durationMin = dur ? parseDuration(dur.value) : undefined;
  const rrule = get("RRULE")?.value.trim();
  const uid = get("UID")?.value.trim();
  return {
    ...(uid ? { uid } : {}),
    ...text("SUMMARY"),
    ...text("LOCATION"),
    ...text("DESCRIPTION"),
    start: start.time,
    ...(end ? { end: end.time } : {}),
    ...(durationMin !== undefined ? { durationMin } : {}),
    ...(rrule ? { rrule: `RRULE:${rrule}` } : {}),
    ...(start.unknownTz ? { unknownTz: start.unknownTz } : {}),
  };
}
