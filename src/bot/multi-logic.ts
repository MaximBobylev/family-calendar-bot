// Строки карточки-списка из кусков делителя и ответа LLM, переключатели, лимиты — без ввода-вывода (ADR-0008).
// Даты каждой строки — наш разбор куска; от LLM — название, календарь и второе мнение о дате.

import { findCalendarByName, titleScore } from "../calendar/match";
import type { CalendarEvent, CalendarInfo, EventRef } from "../calendar/model";
import { parseDateFragment } from "../dates";
import { type Day, formatDate, formatMoment, localToUtc, minutesBetween, type Moment, parseLocal } from "../dates/calendar";
import { cleanTitle, looksAllDay } from "../dates/extract";
import type { CreateEventIntent, Intent } from "../nlu/intents";
import type { EventFamily } from "./assign/logic";
import {
  type CalendarResolution,
  type CreateDraft,
  type CreateOption,
  llmDateCheck,
  namedByAlias,
  resolveCalendar,
  resolveDraft,
  type StartAgreement,
  type LlmDateSide,
  withConversationDay,
} from "./create-logic";
import type { Piece } from "./multi-split";

export const MULTI_CARD = "multi";
export const MAX_OWN = 5;
export const MAX_FORWARD = 10;

export const BIRTHDAY = /день рождени|(?<!\p{L})др(?!\p{L})|годовщин|юбиле|birthday|anniversary/iu;

export interface MultiItem {
  title: string;
  /** Переключатель; у строки без готового события — не используется. */
  sel: "on" | "off";
  option?: CreateOption;
  /** Нет готового события: спросить после создания остальных (по одному); день — если известен. */
  ask?: { question: "askWhen" | "askTime" | "inPast" | "askZoneTime" | "pick"; draft: CreateDraft; options?: CreateOption[]; day?: Day };
  birthday?: true;
  /** ⚠️ Похожее уже есть в этот день в этом календаре — по умолчанию не создаём. */
  dup?: { title: string; day: Day; start?: Moment };
  /** ⏰ Пересечения — создаём, но показываем. */
  overlap?: { title: string; start: Moment; end: Moment }[];
  family?: EventFamily;
  done?: { ref: EventRef; link?: string; etag?: string } | { failed: true };
}

export interface MultiCardPayload {
  chatId: number;
  items: MultiItem[];
  /** Есть строки birthday — «🔁 Каждый год: да» по умолчанию. */
  yearly?: boolean;
  /** Пересланное: «📝 Из пересланного сообщения от …»; "" — без имени. */
  forwardedFrom?: string;
  viaAlias?: boolean;
  showCalendar?: boolean;
  /** Куски-не-создания своего сообщения, как сказаны: не выполняем, а называем (⏭). */
  notDone?: string[];
}

const NOT_DONE_LEN = 200;
/** Своё сообщение: «удали …», «перенеси …», «покажи …» рядом с созданиями не выполняются, а называются. */
export const notDoneOf = (pieces: Piece[]) =>
  pieces.filter((p) => p.action === "other").map((p) => (p.text.length > NOT_DONE_LEN ? `${p.text.slice(0, NOT_DONE_LEN)}…` : p.text));

export const isCreatePiece = (p: Piece) => p.action === "create" && !!(p.point || p.recurrence || p.unsure || p.undated);
export const createPieces = (pieces: Piece[]) => pieces.filter(isCreatePiece);

export function llmCalls(intent: Intent | undefined): CreateEventIntent[] {
  if (!intent) return [];
  if (intent.name === "create_event") return [intent];
  if (intent.name === "multiple") return (intent.parts ?? []).filter((p): p is CreateEventIntent => p.name === "create_event");
  return [];
}

const normWords = (s: string) =>
  s
    .toLowerCase()
    .replace(/ё/g, "е")
    .split(/[^\p{L}\p{N}:.]+/u)
    .map((w) => w.replace(/^[.:]+|[.:]+$/g, ""))
    .filter(Boolean);

/** Делитель главнее: лишние вызовы LLM отбрасываются, потерянные — строка с черновым названием. */
export function alignCalls(pieces: Piece[], calls: CreateEventIntent[]): (CreateEventIntent | undefined)[] {
  let j = 0;
  return pieces.map((p) => {
    if (p.borrowFrom !== undefined || !isCreatePiece(p)) return undefined;
    const words = new Set(normWords(p.text));
    const dateWords = new Set(normWords([p.point, p.recurrence].filter(Boolean).join(" ")));
    for (let k = j; k < calls.length; k++) {
      const c = calls[k]!;
      const byTitle = !!c.title && titleScore(c.title, p.text) >= 0.5;
      const start = normWords(c.start ?? "");
      const byStart = start.length > 0 && start.every((w) => words.has(w)) && start.some((w) => dateWords.has(w));
      if (byTitle || byStart) {
        j = k + 1;
        return c;
      }
    }
    return undefined;
  });
}

export interface BuiltItem {
  item: MultiItem;
  /** Для карточки одного события, если строка осталась одна. */
  draft: CreateDraft;
  check?: { agreement: StartAgreement; llm: LlmDateSide; contextDay: boolean };
}

export interface BuildInput {
  pieces: Piece[];
  calls: (CreateEventIntent | undefined)[];
  families: { family?: EventFamily; remove: string[] }[];
  now: Moment;
  /** Пересланное: от даты сообщения (US-65). */
  refNow?: Moment;
  tz: string;
  locale: string;
  durationMin: number;
  calendars: CalendarInfo[];
  /** День разговора (US-60) — только для первой строки. */
  conversationDay?: string;
  llmFirst?: boolean;
  description?: string;
}

export type BuildResult = { items: BuiltItem[]; viaAlias: boolean } | { calendarError: Exclude<CalendarResolution, CalendarInfo> };

// «…, всё в семейный календарь» — календарь для всех строк без своего (US-62, общий календарь)
const SHARED_CALENDAR = /^(?:и\s+)?(?:(всё|все|оба|обе|both|all|everything)\s+)?(?:в|во|to|into|in)\s+(.+)$/iu;
/** «отводит папа на оба / везде» — ответственный для всех строк (US-62). */
export const RESPONSIBLE_FOR_ALL = /(?<!\p{L})(?:на\s+(?:оба|обе|все|всех)|везде|for\s+both|for\s+all)(?!\p{L})/iu;

function sharedCalendar(pieces: Piece[], calls: (CreateEventIntent | undefined)[], calendars: CalendarInfo[]): { name?: string; clause?: string } {
  const creates = pieces.map((p, i) => [p, i] as const).filter(([p]) => isCreatePiece(p));
  const lastIdx = creates.at(-1)?.[1];
  for (const [p, i] of creates) {
    for (const chunk of p.text.split(/\s*,\s*/).slice(1)) {
      const m = SHARED_CALENDAR.exec(chunk.trim());
      if (!m || !(m[1] || i === lastIdx)) continue;
      const cal = findCalendarByName(calendars, m[2]!);
      if (cal) return { name: cal.title, clause: chunk.trim() };
    }
  }
  const named = [...new Set(calls.flatMap((c) => (c?.calendar ? [c.calendar] : [])))];
  return named.length === 1 ? { name: named[0] } : {};
}

function withResponsibleForAll(pieces: Piece[], families: BuildInput["families"]): BuildInput["families"] {
  const lead = pieces.findIndex((p, i) => isCreatePiece(p) && RESPONSIBLE_FOR_ALL.test(p.text) && families[i]?.family?.responsibleUserId);
  const who = lead >= 0 ? families[lead]!.family! : undefined;
  if (!who) return families;
  return families.map((f, i) =>
    !isCreatePiece(pieces[i]!) || f.family?.responsibleUserId
      ? f
      : { ...f, family: { ...f.family, responsibleUserId: who.responsibleUserId!, ...(who.responsibleName ? { responsibleName: who.responsibleName } : {}) } },
  );
}

export function buildItems(a: BuildInput): BuildResult {
  const base = a.refNow ?? a.now;
  const shared = sharedCalendar(a.pieces, a.calls, a.calendars);
  const families = withResponsibleForAll(a.pieces, a.families);
  const items: BuiltItem[] = [];
  const seen = new Set<string>();
  let viaAlias = false;
  let prevDay: string | undefined;
  let first = true;
  for (const [i, piece] of a.pieces.entries()) {
    if (!isCreatePiece(piece)) continue;
    const source = piece.borrowFrom !== undefined ? (a.pieces[piece.borrowFrom] ?? piece) : piece;
    const call = a.calls[piece.borrowFrom ?? i];
    const fam = families[i] ?? { remove: [] };
    const famText = fam.remove.reduce((s, r) => s.replace(r, " "), piece.text);
    const fragments = [
      shared.clause,
      piece.point,
      ...(piece.pointParts ?? []),
      source.point,
      piece.recurrence,
      ...(piece.recurrenceRemove ?? []),
      piece.duration,
      piece.unknownZone,
    ];
    const fromCall = cleanTitle(
      call?.title,
      [...fragments, call?.start, ...fam.remove].filter((x): x is string => !!x),
    );
    const heuristic = cleanTitle(source.title ? fam.remove.reduce((s, r) => s.replace(r, " "), source.title) : undefined, []);
    const title = fromCall ?? heuristic;

    const dayContext = first ? a.conversationDay : prevDay;
    const inContext = piece.point && dayContext ? withConversationDay(piece.point, dayContext, base.day) : undefined;
    const point = inContext ?? piece.point;
    const llm =
      piece.unknownZone || inContext || piece.undated || piece.borrowFrom !== undefined || !call
        ? {}
        : { start: call.start, ...(call.when ? { when: call.when } : {}) };
    const check = piece.recurrence || piece.undated ? undefined : llmDateCheck(famText, point, llm, base, a.tz, a.llmFirst);
    const pick = check?.pick ?? {};
    const draft: CreateDraft = {
      ...pick,
      ...(piece.undated && prevDay ? { startText: dotted(prevDay) } : {}),
      ...(piece.recurrence ? { recurrenceText: piece.recurrence } : {}),
      ...(title ? { title } : {}),
      ...((piece.duration ?? call?.duration) ? { durationText: piece.duration ?? call?.duration } : {}),
      ...(call?.allDay || looksAllDay(famText) || (title && BIRTHDAY.test(title)) ? { allDay: true } : {}),
      ...((call?.calendar ?? shared.name) ? { calendar: call?.calendar ?? shared.name } : {}),
      ...(call?.location ? { location: call.location } : {}),
      ...(a.description ? { description: a.description } : {}),
      ...(fam.family ? { family: fam.family } : {}),
      ...(piece.unknownZone ? { unknownZone: piece.unknownZone } : {}),
    };
    first = false;

    const cal = resolveCalendar(a.calendars, draft.calendar);
    if ("error" in cal) return { calendarError: cal };
    if (namedByAlias(cal, draft.calendar)) viaAlias = true;

    const t0 = title ?? "";
    let item: MultiItem;
    if (piece.undated) {
      const d = prevDay ? askDraft(draft, true, dotted(prevDay)) : askDraft(draft, false);
      item = { title: t0, sel: "on", ask: prevDay ? { question: "askTime", draft: d, day: dayOfIso(prevDay) } : { question: "askWhen", draft: d } };
    } else {
      const res = resolveDraft(draft, base, a.tz, cal, a.locale, a.durationMin);
      const past = (o: CreateOption) => (o.start ? minutesBetween(o.start, a.now) <= 0 : o.endDay < a.now.day);
      if (res.kind === "options" && a.refNow && res.options.every(past))
        item = { title: t0, sel: "on", ask: { question: "inPast", draft: askDraft(draft, false) } };
      else if (res.kind === "options" && res.options.length === 1) {
        const o = res.options[0]!;
        item = { title: o.title, sel: "on", option: o };
        if (!o.series && o.allDay && o.startDay === o.endDay && BIRTHDAY.test(`${o.title} ${famText}`)) item.birthday = true;
        prevDay = o.series ? undefined : formatDate(o.startDay);
      } else if (res.kind === "options") item = { title: res.options[0]!.title, sel: "on", ask: { question: "pick", draft, options: res.options } };
      else if (res.kind === "ask") {
        const d = askDraft(draft, res.keepStart, res.startText);
        const day = res.question === "askTime" && d.startText ? dayOfText(d.startText, base, a.tz) : undefined;
        item = { title: t0, sel: "on", ask: { question: res.question, draft: d, ...(day !== undefined ? { day } : {}) } };
      } else {
        const { durationText: _d, ...rest } = askDraft(draft, false);
        item = { title: t0, sel: "on", ask: { question: "askWhen", draft: rest } };
      }
    }
    if (fam.family) item.family = fam.family;
    if (!item.option) prevDay = piece.undated ? prevDay : undefined;

    const key = item.option ? `${normWords(item.title).join(" ")}|${item.option.startDay}|${item.option.start?.minutes ?? ""}` : undefined;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    items.push({ item, draft, ...(check ? { check: { agreement: check.agreement, llm: check.llm, contextDay: !!inContext } } : {}) });
  }
  return { items, viaAlias };
}

// Как startCreate: второе мнение LLM — только для первой карточки, ответ на вопрос дополняет наш кусок
function askDraft(draft: CreateDraft, keepStart: boolean, startText?: string): CreateDraft {
  const { altStartText: _alt, altWhen: _when, llmFirst: _first, unknownZone: _zone, startText: own, ...rest } = draft;
  const kept = keepStart ? (startText ?? own) : undefined;
  return kept ? { ...rest, startText: kept } : rest;
}

const dayOfIso = (iso: string): Day => parseLocal(`${iso}T00:00`).day;

function dayOfText(text: string, now: Moment, tz: string): Day | undefined {
  const r = parseDateFragment({ text, kind: "point", now: formatMoment(now), tz });
  if ("error" in r) return undefined;
  const vs = "ambiguous" in r ? r.ambiguous : [r];
  const days = [...new Set(vs.flatMap((v) => ("date" in v ? [typeof v.date === "string" ? v.date : v.date.date] : [])))];
  return days.length === 1 ? dayOfIso(days[0]!) : undefined;
}

const dotted = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
};

// Правила связывания поручения (US-91, findEventToLink): тот же день, похожее название, со временем — не дальше 3 часов
const DUP_SCORE = 0.5;
const DUP_NEAR_MIN = 3 * 60;
const MAX_OVERLAPS = 3;

/** Строки, о которых надо спросить Google: готовые, не серии. */
export function daysToCheck(items: MultiItem[]): Day[] {
  return [...new Set(items.flatMap((it) => (it.option && !it.option.series ? [it.option.startDay] : [])))].sort((a, b) => a - b);
}

export function markExisting(items: MultiItem[], events: CalendarEvent[], defaultCalendarId: string | undefined): MultiItem[] {
  return items.map((it) => {
    const o = it.option;
    if (!o || o.series) return it;
    const sameDay = events.filter((e) => e.startDay <= o.startDay && o.startDay <= e.endDay);
    const near = (e: CalendarEvent) => !o.start || !e.start || Math.abs(localToUtc(e.start, o.tz) - localToUtc(o.start, o.tz)) <= DUP_NEAR_MIN * 60_000;
    const dup = sameDay
      .filter((e) => e.ref.calendarId === o.calendarId && near(e))
      .map((e) => ({ e, score: titleScore(o.title, e.title) }))
      .filter((x) => x.score >= DUP_SCORE)
      .sort((a, b) => b.score - a.score)[0]?.e;
    if (dup) return { ...it, sel: "off", dup: { title: dup.title, day: dup.startDay, ...(dup.start ? { start: dup.start } : {}) } };
    if (o.allDay || !o.start || !o.end) return it;
    const relevant = new Set([o.calendarId, defaultCalendarId]);
    const from = localToUtc(o.start, o.tz);
    const to = localToUtc(o.end, o.tz);
    const overlap = events
      .filter((e) => !e.allDay && !e.free && e.start && e.end && relevant.has(e.ref.calendarId))
      .filter((e) => localToUtc(e.start!, o.tz) < to && localToUtc(e.end!, o.tz) > from)
      .slice(0, MAX_OVERLAPS)
      .map((e) => ({ title: e.title, start: e.start!, end: e.end! }));
    return overlap.length ? { ...it, overlap } : it;
  });
}

export const isReady = (it: MultiItem) => !!it.option;
export const doneOf = (it: MultiItem) => (it.done && "ref" in it.done ? it.done : undefined);
export const isCreated = (it: MultiItem) => !!doneOf(it);
/** Строки, которые создаст нажатие «Создать» / «Повторить». */
export const toCreate = (p: MultiCardPayload) => p.items.map((it, i) => [it, i] as const).filter(([it]) => it.option && it.sel === "on" && !isCreated(it));

export function mainButton(p: MultiCardPayload): { key: "multiCreateAll" | "multiCreateSelected" | "multiAskNext"; n: number } {
  const ready = p.items.filter(isReady);
  const on = ready.filter((it) => it.sel === "on").length;
  if (on > 0 && on === ready.length && toAsk(p).length === 0) return { key: "multiCreateAll", n: on };
  if (on === 0 && toAsk(p).length > 0) return { key: "multiAskNext", n: 0 };
  return { key: "multiCreateSelected", n: on };
}

/** Неясные строки, по которым спросим после создания (по одной). */
export const toAsk = (p: MultiCardPayload) => p.items.filter((it) => !it.option && it.ask && it.sel === "on");

/** null — выбор не про переключатель или строка не переключается. */
export function toggle(p: MultiCardPayload, choice: string): MultiCardPayload | null {
  if (choice === "y") return p.items.some((it) => it.birthday) ? { ...p, yearly: !p.yearly } : null;
  const m = /^t(\d)$/.exec(choice);
  const i = m ? Number(m[1]) : -1;
  const it = p.items[i];
  if (!it || it.done || (!it.option && !it.ask)) return null;
  return { ...p, items: p.items.map((x, k) => (k === i ? { ...x, sel: x.sel === "on" ? "off" : "on" } : x)) };
}

// «второе — в 13», «2-е на субботу», «first one at 5»; не «вторник», «пятница», «2 ноября», «третьего ноября»
const ORDINAL_WORD =
  "(?:перв|втор(?!ник)|трет|четв[её]рт(?!ок|г)|пят(?:ое|ый|ая|ую|ого|ой|ом)(?!\\p{L})|шест|седьм|восьм|девят(?:ое|ый|ая|ую|ого|ой|ом)(?!\\p{L})|десят(?:ое|ый|ая|ую|ого|ой|ом)(?!\\p{L})|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\\p{L}*";
const ORDINAL_NUM = "(?:\\d{1,2}(?:-?(?:е|й|ое|ый|ая|ую|st|nd|rd|th)(?!\\p{L})|[.)](?!\\d))|(?:номер|пункт|№|number|no\\.?)\\s*\\d{1,2})";
const MONTH_AFTER = /^\s*(?:январ|феврал|март|апрел|ма[яйе]|июн|июл|август|сентябр|октябр|ноябр|декабр|числ|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/iu;
const ORDINAL_START = new RegExp(`^(?:(?:а|и|ну|and|so)\\s+)?(${ORDINAL_WORD}|${ORDINAL_NUM})`, "iu");

export function ordinalLead(text: string): boolean {
  const m = ORDINAL_START.exec(text.trim());
  if (!m) return false;
  return !MONTH_AFTER.test(text.trim().slice(m[0].length));
}
