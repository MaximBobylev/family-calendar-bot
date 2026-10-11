// Сообщение → куски-дела по нашим датам (ADR-0008): число дел и дата каждого — отсюда, от LLM — только названия.
// Делим только там, где у куска своя дата и своё название (или «ещё / также»); остальное приклеивается к соседу.

import { parseDateFragment } from "../dates";
import { type ExtractedSpans, extractDateSpans, extractRecurrenceSpan, type RecurrenceSpan, removeFragments } from "../dates/extract";
import { FILLERS, WEEKDAYS } from "../dates/lexicon";
import { fragmentParts } from "../dates/point";
import { tokenize } from "../dates/tokenize";
import { DELETE_VERBS, MODIFY_VERBS } from "../nlu/modify-hints";
import { CREATE_VERB } from "./assign/logic";
import { BARE_DAY_SPAN, CHAT_TIMESTAMP, LEADS, MAX_TEXT, mergeLayoutLines, SENTENCE_END, withoutOpeningHours } from "./ingest-logic";

export interface Piece {
  text: string;
  point?: string;
  pointParts?: string[];
  recurrence?: string;
  recurrenceRemove?: string[];
  duration?: string;
  unsure?: true;
  unknownZone?: string;
  /** "other" — свой или унаследованный глагол изменения / удаления / показа: не создаём. */
  action: "create" | "other";
  /** «и ещё созвон с Олегом» — дело без даты. */
  undated?: true;
  /** «в пятницу и в субботу в 10 футбол»: название и время — у куска с этим индексом. */
  borrowFrom?: number;
  /** Черновое название без LLM. */
  title?: string;
}

const CUT = /;|,(?!\d)|(?<!\p{L})(?:а\s+потом|а\s+затем|and\s+then|и|а|потом|затем|плюс|and|then|plus)(?!\p{L})/giu;
const SENTENCE_CUT = new RegExp(SENTENCE_END.source, "giu");
const ENUM_SEP = /^[ \t,]*(?:и|and)?[ \t,]*$/iu;
const MARKER = /^(?:ещё|еще|также|also)(?!\p{L})[,:]?\s*/iu;
const LEAD =
  /^(?:(?:не\s+)?забуд\p{L}*|напоминаем|напомина[юе]\p{L}*|напомни(?:те)?(?:\s+(?:мне|нам|себе))?|запиши(?:те)?|поставь(?:те)?|добавь(?:те)?|создай(?:те)?|запланируй(?:те)?|внеси(?:те)?|пожалуйста|please|don'?t\s+forget|remember|schedule|add|create|book|put|reminder)(?!\p{L})[,:!]?\s*/iu;
const SHOW = /^(?:покажи|что\s+у\s+меня|что\s+в|когда\s+у\s+меня|какие|show|what'?s|what\s+is|list)(?!\p{L})/iu;
const CREATE_WORD = /(?<!\p{L})(?:постав\p{L}*|запиш\p{L}*|добав\p{L}*|созда\p{L}*|запланир\p{L}*|schedule|add|create|book)(?!\p{L})/iu;
// Слова, из которых не бывает названия: «…, а в субботу если получится» — уточнение, а не второе дело
const NOT_TITLE = new Set(
  (
    "в во на к ко с со у по до от за и а о об из для при the a an at on in to of for by " +
    "если получится может быть наверное тоже также ещё еще обязательно пожалуйста ну вот это там тут примерно около лучше или or maybe please also too " +
    "потом затем then часов часа утра вечера дня ночи"
  ).split(" "),
);

// «со дня рождения» — не время «дня» (как «2 часа дня»)
const BIRTHDAY_DAY = /(?<!\p{L})(?:день|дня|дню|днём|днем)(?=\s+рождени)/giu;

interface Info {
  body: string;
  marker: boolean;
  rec?: RecurrenceSpan;
  spans: ExtractedSpans;
  hasDate: boolean;
  dayOnly: boolean;
  /** Своя дата (день), а не только время. */
  dated: boolean;
  hasTime: boolean;
  residue: string;
  titled: boolean;
  verb?: "create" | "other";
  startsWithOther: boolean;
}

export function splitMessage(text: string, now: string, tz: string, opts: { foreign?: boolean } = {}): Piece[] {
  const src = opts.foreign ? foreignText(text) : text.slice(0, MAX_TEXT);
  const raws = rawPieces(src, now, tz);
  if (raws.length === 0) return [];
  const infos = raws.map((r) => analyze(src.slice(r.start, r.end), now, tz));

  const groups: { start: number; end: number }[] = [];
  const borrowOf = new Map<number, number>();
  let pendingStart: number | undefined;
  for (const [i, r] of raws.entries()) {
    const info = infos[i]!;
    const source = enumerationSource(i, raws, infos);
    const last = groups.at(-1);
    const standalone =
      source !== undefined ||
      (info.titled &&
        (info.hasDate || info.marker || info.startsWithOther) &&
        !(last && refines(analyze(src.slice(last.start, last.end), now, tz), info, now, tz)));
    if (standalone) {
      if (source !== undefined) borrowOf.set(groups.length, source);
      groups.push({ start: pendingStart ?? r.start, end: r.end });
      pendingStart = undefined;
    } else if (groups.length) groups.at(-1)!.end = r.end;
    else pendingStart ??= r.start;
  }
  if (pendingStart !== undefined) {
    if (groups.length) groups[0]!.start = pendingStart;
    else groups.push({ start: pendingStart, end: raws.at(-1)!.end });
  }

  const rawToGroup = (rawIdx: number) => groups.findIndex((g) => g.start <= raws[rawIdx]!.start && raws[rawIdx]!.end <= g.end);
  const pieces: Piece[] = [];
  let prevAction: Piece["action"] = "create";
  let prev: { info: Info; title?: string } | undefined;
  for (const [gi, g] of groups.entries()) {
    const info = analyze(src.slice(g.start, g.end), now, tz);
    const action: Piece["action"] = info.verb ?? prevAction;
    prevAction = action;
    const title = heuristicPieceTitle(info.residue, prev);
    const piece: Piece = { text: info.body, action, ...(title ? { title } : {}) };
    if (info.rec) {
      piece.recurrence = info.rec.span;
      if (info.rec.remove) piece.recurrenceRemove = info.rec.remove;
    } else if (info.spans.point) {
      piece.point = info.spans.point;
      piece.pointParts = info.spans.pointParts ?? [info.spans.point];
    }
    if (info.spans.duration) piece.duration = info.spans.duration;
    if (info.spans.unsure) piece.unsure = true;
    if (info.spans.unknownZone) piece.unknownZone = info.spans.unknownZone;
    if (info.marker && !info.hasDate) piece.undated = true;
    const srcRaw = borrowOf.get(gi);
    if (srcRaw !== undefined) piece.borrowFrom = rawToGroup(srcRaw);
    pieces.push(piece);
    prev = { info, ...(title ? { title } : {}) };
  }
  for (const p of pieces) if (p.borrowFrom !== undefined) borrow(p, pieces[p.borrowFrom], now, tz);
  return pieces;
}

function foreignText(text: string): string {
  return mergeLayoutLines(text.slice(0, MAX_TEXT))
    .split("\n")
    .filter((l) => !CHAT_TIMESTAMP.test(l.trim()) && !BARE_DAY_SPAN.test(l.trim()))
    .map((l) =>
      l
        .split(SENTENCE_END)
        .map((x) => withoutOpeningHours(x))
        .join(" "),
    )
    .join("\n");
}

function protectedRanges(text: string, now: string, tz: string): [number, number][] {
  const out: [number, number][] = [];
  let from = 0;
  for (let n = 0; n < 5 && from < text.length; n++) {
    const rest = text.slice(from);
    const rec = extractRecurrenceSpan(rest, now, tz);
    if (!rec || rec.remove) break;
    const at = locateWords(rest, rec.span);
    if (!at) break;
    out.push([from + at[0], from + at[1]]);
    from += at[1];
  }
  return out;
}

const bare = (w: string) => w.replace(/^[«"(,.!?]+|[»"),.!?]+$/g, "").toLowerCase();

function locateWords(text: string, span: string): [number, number] | undefined {
  const want = span.split(/\s+/).map(bare);
  const tokens = [...text.matchAll(/\S+/g)].map((m) => ({ w: bare(m[0]), start: m.index, end: m.index + m[0].length }));
  for (let i = 0; i + want.length <= tokens.length; i++) {
    if (want.every((w, k) => tokens[i + k]!.w === w)) return [tokens[i]!.start, tokens[i + want.length - 1]!.end];
  }
  return undefined;
}

function rawPieces(text: string, now: string, tz: string): { start: number; end: number; sep: string }[] {
  const guarded = protectedRanges(text, now, tz);
  const cuts: [number, number][] = [];
  for (const re of [CUT, SENTENCE_CUT]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const s = m.index;
      const e = s + m[0].length;
      if (e === s) continue;
      if (guarded.some(([a, b]) => s < b && e > a)) continue;
      cuts.push([s, e]);
    }
  }
  cuts.sort((a, b) => a[0] - b[0]);
  const out: { start: number; end: number; sep: string }[] = [];
  let pos = 0;
  let sep = "";
  for (const [s, e] of [...cuts, [text.length, text.length] as [number, number]]) {
    if (s < pos) continue;
    const chunk = text.slice(pos, s);
    const lead = chunk.length - chunk.trimStart().length;
    const trimmed = chunk.trim();
    if (/[\p{L}\p{N}]/u.test(trimmed)) {
      out.push({ start: pos + lead, end: pos + lead + trimmed.length, sep });
      sep = "";
    } else sep += chunk;
    sep += text.slice(s, e);
    pos = e;
  }
  return out;
}

function analyze(raw: string, now: string, tz: string): Info {
  let body = raw.trim();
  const marker = MARKER.exec(body);
  if (marker) body = body.slice(marker[0].length);
  const dateText = body.replace(BIRTHDAY_DAY, (m) => "§".repeat(m.length));
  const rec = extractRecurrenceSpan(dateText, now, tz);
  const spans = extractDateSpans(rec ? rec.rest : dateText, now, tz, "point");
  const parts = spans.point ? fragmentParts(tokenize(spans.point)) : null;
  const residue = stripLeads(removeFragments(body, [rec?.span, ...(rec?.remove ?? []), ...(spans.pointParts ?? []), spans.duration, spans.unknownZone]));
  const words = residue.split(/[^\p{L}\p{N}'-]+/u).filter(Boolean);
  const titled = words.some((w) => /\p{L}/u.test(w) && !NOT_TITLE.has(w.toLowerCase()));
  const lead = stripLeads(body);
  const other = DELETE_VERBS.test(body) || MODIFY_VERBS.test(body) || SHOW.test(lead);
  const verb = other ? "other" : CREATE_VERB.test(body) || CREATE_WORD.test(body) ? "create" : undefined;
  return {
    body,
    marker: !!marker,
    ...(rec ? { rec } : {}),
    spans,
    hasDate: !!(rec || spans.point || spans.unsure),
    dayOnly: !rec && !!parts && parts.hasDate && !parts.hasTime,
    dated: !!parts?.hasDate,
    hasTime: !!parts?.hasTime,
    residue,
    titled,
    ...(verb ? { verb } : {}),
    startsWithOther: /^\p{L}/u.test(lead) && (DELETE_VERBS.exec(lead)?.index === 0 || MODIFY_VERBS.exec(lead)?.index === 0),
  };
}

function stripLeads(s: string): string {
  let t = s.replace(/\s+/g, " ").trim();
  for (;;) {
    const next = t
      .replace(/^[\s,.:;!?—–-]+/u, "")
      .replace(LEAD, "")
      .replace(LEADS, "");
    if (next === t) break;
    t = next;
  }
  return t
    .replace(/[\s,.:;!?—–-]+$/u, "")
    .replace(/\s+[—–-]\s+/gu, " ")
    .trim();
}

// День без названия и времени перед делом с названием и временем: «в пятницу и в субботу в 10 футбол»
function enumerationSource(i: number, raws: { sep: string }[], infos: Info[]): number | undefined {
  if (!infos[i]!.dayOnly || infos[i]!.titled) return undefined;
  for (let k = i + 1; k < infos.length; k++) {
    if (!ENUM_SEP.test(raws[k]!.sep)) return undefined;
    const info = infos[k]!;
    if (info.titled) return info.hasTime && info.dated && !info.rec ? k : undefined;
    if (!info.dayOnly) return undefined;
  }
  return undefined;
}

// «Собрание в пятницу. Начало в 18:30», «на выходных? … В субботу в 12:30» — уточнение того же дела, а не второе
function refines(prev: Info, cur: Info, now: string, tz: string): boolean {
  if (!prev.hasDate || prev.hasTime || prev.rec || cur.rec || !cur.spans.point) return false;
  if (cur.hasTime && !cur.dated) return true;
  const before = daysOf(prev.spans.point, now, tz);
  const after = daysOf(cur.spans.point, now, tz);
  if (after.length > 0 && after.every((d) => before.includes(d))) return true;
  // «Saturday, Oct 24» — день недели уточняется датой
  const onlyWeekday = !!prev.spans.point && prev.spans.point.split(/\s+/).every((w) => WEEKDAYS.has(w.toLowerCase()) || FILLERS.has(w.toLowerCase()));
  return onlyWeekday && after.length === 1 && before.length === 1 && weekday(after[0]!) === weekday(before[0]!);
}

const weekday = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();

function daysOf(point: string | undefined, now: string, tz: string): string[] {
  if (!point) return [];
  const r = parseDateFragment({ text: point, kind: "point", now, tz });
  if ("error" in r) return [];
  return ("ambiguous" in r ? r.ambiguous : [r]).flatMap((v) =>
    "datetime" in v
      ? [v.datetime.slice(0, 10)]
      : "date" in v
        ? [typeof v.date === "string" ? v.date : v.date.date]
        : "interval" in v
          ? [v.interval.start.slice(0, 10)]
          : [],
  );
}

function borrow(p: Piece, source: Piece | undefined, now: string, tz: string): void {
  if (!source?.point || !p.point) {
    delete p.borrowFrom;
    return;
  }
  const words = source.point.split(/\s+/);
  for (let k = 1; k < words.length; k++) {
    const time = words.slice(k).join(" ");
    const fp = fragmentParts(tokenize(time));
    if (!fp?.hasTime || fp.hasDate) continue;
    const joined = `${p.point} ${time}`;
    const r = parseDateFragment({ text: joined, kind: "point", now, tz });
    if ("error" in r && r.error !== "in_past") break;
    p.point = joined;
    if (source.title) p.title = source.title;
    return;
  }
  delete p.borrowFrom;
}

const NAME = "\\p{Lu}[\\p{L}-]*";
const BIRTHDAY_OF = new RegExp(`^у\\s+(${NAME})\\s+(день\\s+рождения|др|юбилей|годовщина)$|^(день\\s+рождения|др|юбилей|годовщина)\\s+у\\s+(${NAME})$`, "iu");
const ONLY_NAME = new RegExp(`^(?:(у|с|со|для|к)\\s+)?(${NAME})$`, "u");

function heuristicPieceTitle(residue: string, prev: { info: Info; title?: string } | undefined): string | undefined {
  const r = residue
    .split(/\s*[,.;](?:\s|$)/u)[0]!
    .split(/:\s+/)
    .at(-1)!
    .replace(/\s+(в|во|на|к|с|у|at|on|in)$/iu, "")
    .trim();
  if (!r) return undefined;
  const bd = BIRTHDAY_OF.exec(r);
  if (bd) {
    const kind = (bd[2] ?? bd[3])!.toLowerCase();
    const name = (bd[1] ?? bd[4])!;
    return `${kind === "др" ? "День рождения" : capitalize(kind)} ${name}`;
  }
  const only = ONLY_NAME.exec(r);
  if (only && prev?.title) {
    const [, prep, name] = only;
    const prevName = prep
      ? new RegExp(`(?<!\\p{L})(?:${prep}|${capitalize(prep)})\\s+(${NAME})`, "u").exec(prev.info.residue)?.[1]
      : prev.title
          .split(/\s+/)
          .slice(1)
          .reverse()
          .find((w) => /^\p{Lu}/u.test(w));
    if (prevName && prev.title.includes(prevName)) return prev.title.replace(prevName, name!);
  }
  return capitalize(r);
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
