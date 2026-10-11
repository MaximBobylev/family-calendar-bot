// Строки карточки-списка из кусков делителя и ответа LLM, переключатели, лимиты — без ввода-вывода (ADR-0008).
// Даты каждой строки — наш разбор куска; от LLM — название, календарь и второе мнение о дате.

import { titleScore } from "../calendar/match";
import type { CalendarInfo, EventRef } from "../calendar/model";
import { formatDate, minutesBetween, type Moment } from "../dates/calendar";
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
  /** Нет готового события: день или время не поняли, варианты, прошлое — строка «скажите отдельно». */
  ask?: { question: "askWhen" | "askTime" | "inPast" | "askZoneTime" | "pick" };
  birthday?: true;
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

export function buildItems(a: BuildInput): BuildResult {
  const base = a.refNow ?? a.now;
  const items: BuiltItem[] = [];
  const seen = new Set<string>();
  let viaAlias = false;
  let prevDay: string | undefined;
  let first = true;
  for (const [i, piece] of a.pieces.entries()) {
    if (!isCreatePiece(piece)) continue;
    const source = piece.borrowFrom !== undefined ? (a.pieces[piece.borrowFrom] ?? piece) : piece;
    const call = a.calls[piece.borrowFrom ?? i];
    const fam = a.families[i] ?? { remove: [] };
    const famText = fam.remove.reduce((s, r) => s.replace(r, " "), piece.text);
    const fragments = [
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
      ...(call?.calendar ? { calendar: call.calendar } : {}),
      ...(call?.location ? { location: call.location } : {}),
      ...(a.description ? { description: a.description } : {}),
      ...(fam.family ? { family: fam.family } : {}),
      ...(piece.unknownZone ? { unknownZone: piece.unknownZone } : {}),
    };
    first = false;

    const cal = resolveCalendar(a.calendars, draft.calendar);
    if ("error" in cal) return { calendarError: cal };
    if (namedByAlias(cal, draft.calendar)) viaAlias = true;

    let item: MultiItem;
    if (piece.undated) item = { title: title ?? "", sel: "on", ask: { question: "askTime" } };
    else {
      const res = resolveDraft(draft, base, a.tz, cal, a.locale, a.durationMin);
      const past = (o: CreateOption) => (o.start ? minutesBetween(o.start, a.now) <= 0 : o.endDay < a.now.day);
      if (res.kind === "options" && a.refNow && res.options.every(past)) item = { title: title ?? "", sel: "on", ask: { question: "inPast" } };
      else if (res.kind === "options" && res.options.length === 1) {
        const o = res.options[0]!;
        item = { title: o.title, sel: "on", option: o };
        if (!o.series && o.allDay && o.startDay === o.endDay && BIRTHDAY.test(`${o.title} ${famText}`)) item.birthday = true;
        prevDay = o.series ? undefined : formatDate(o.startDay);
      } else if (res.kind === "options") item = { title: res.options[0]!.title, sel: "on", ask: { question: "pick" } };
      else if (res.kind === "ask") item = { title: title ?? "", sel: "on", ask: { question: res.question } };
      else item = { title: title ?? "", sel: "on", ask: { question: "askWhen" } };
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

const dotted = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
};

export const isReady = (it: MultiItem) => !!it.option;
export const doneOf = (it: MultiItem) => (it.done && "ref" in it.done ? it.done : undefined);
export const isCreated = (it: MultiItem) => !!doneOf(it);
/** Строки, которые создаст нажатие «Создать» / «Повторить». */
export const toCreate = (p: MultiCardPayload) => p.items.map((it, i) => [it, i] as const).filter(([it]) => it.option && it.sel === "on" && !isCreated(it));

export function mainButton(p: MultiCardPayload): { key: "multiCreateAll" | "multiCreateSelected"; n: number } {
  const ready = p.items.filter(isReady);
  const on = ready.filter((it) => it.sel === "on").length;
  return on > 0 && on === ready.length ? { key: "multiCreateAll", n: on } : { key: "multiCreateSelected", n: on };
}

/** null — выбор не про переключатель или строка не переключается. */
export function toggle(p: MultiCardPayload, choice: string): MultiCardPayload | null {
  if (choice === "y") return p.items.some((it) => it.birthday) ? { ...p, yearly: !p.yearly } : null;
  const m = /^t(\d)$/.exec(choice);
  const i = m ? Number(m[1]) : -1;
  const it = p.items[i];
  if (!it?.option || it.done) return null;
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
