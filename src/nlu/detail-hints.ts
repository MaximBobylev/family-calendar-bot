// Детали события из фразы (US-41, US-42): место, описание, напоминания. Детерминированно: маленькая LLM
// такие поля заполняет ненадёжно, а «за час», «за сутки» считает парсер длительностей, не модель (ADR-0005 п.3).
// rest — фраза без деталей: по ней ищут само событие и его день («до встречи в среду» → «встречи в среду»).

import { type EventReminders, MAX_REMINDER_MIN, MAX_REMINDERS } from "../calendar/model";
import { parseDateFragment } from "../dates";
import { durationToMinutes } from "../dates/duration";

type ReminderOverride = EventReminders["overrides"][number];

export type RemindersHint = { overrides: ReminderOverride[] } | { error: "tooMany" | "tooFar" };

export interface DetailHints {
  /** Новое место; "" — убрать. */
  location?: string;
  /** «Встреча будет в офисе на Лесной» — место по догадке: если LLM дала своё, берём его. */
  locationGuess?: string;
  /** Новое описание; text "" — убрать; append — «добавь описание» к существующему. */
  description?: { text: string; append: boolean };
  reminders?: RemindersHint;
  /** Фраза без деталей — для поиска события. */
  rest: string;
}

const L = "\\p{L}";
const re = (src: string, flags = "iu") => new RegExp(src, flags);
// «поставь встречу с описанием …» / «с напоминанием за час» — это создание с деталями, не изменение
const NOT_WITH = `(?<!(?:с|со|with)\\s)`;

const DESC_WORD = `(?:описани${L}*|заметк${L}*|комментари${L}*|description|notes?)`;
const LOC_WORD = `(?:мест[оа]|адрес|location|place)`;
// «Напоминай про танцы за час» (QA R1 NLU, D) — тоже напоминание
const REMINDER_WORD = `(?:напоминани${L}*|напомни(?:ть)?|напомина(?:й|йте|ть)|remind(?:ers?)?)`;
const REMOVE_VERB = `(?:убери|убрать|удали|удалить|сотри|стереть|очисти|сними|снять|отключи|отключить|выключи|выключить|отмени|отменить|remove|clear|delete|disable)`;

const DESC_REMOVE = re(`(?<!${L})${REMOVE_VERB}\\s+(?:${L}+\\s+)?${DESC_WORD}(?!${L})`);
const DESC_SET = re(`${NOT_WITH}(?<!${L})${DESC_WORD}(?!${L})(\\s*[:—–]\\s*|\\s+)(.+)$`);
const APPEND_VERB = re(`(?<!${L})(добавь|добавить|допиши|дописать|add)(?!${L})`);
const REPLACE_VERB = re(`(?<!${L})(измени|изменить|поменяй|поменять|замени|заменить|смени|сменить|change)(?!${L})`);

const LOC_REMOVE = re(`(?<!${L})${REMOVE_VERB}\\s+${LOC_WORD}(?!${L})`);
/** «место: кафе Пушкин», «место встречи с Машей: кафе». */
const LOC_COLON = re(`${NOT_WITH}(?<!${L})${LOC_WORD}(?!${L})([^:]*?)\\s*:\\s*(.+)$`);
/** «поменяй место встречи с Машей на кафе Пушкин». */
const LOC_CHANGE = re(`(?<!${L})(?:поменяй|измени|смени|замени|change)\\s+${LOC_WORD}(?!${L})\\s*(.*?)\\s+(?:на|to)\\s+(.+)$`);
/** «добавь место кафе Пушкин». */
const LOC_ADD = re(`(?<!${L})(?:добавь|добавить|укажи|указать|поставь|запиши|set|add)\\s+${LOC_WORD}\\s+(.+)$`);
/** «встреча в среду будет в офисе на Лесной» — догадка: проверяем, что это не время («будет в 15»). */
const LOC_WILL_BE = re(`(?<!${L})(?:будет|пройд[её]т|состоится|will be)\\s+((?:в|во|на|у|at|in)\\s+.+)$`);

const REMINDERS_REMOVE = re(`(?<!${L})${REMOVE_VERB}\\s+(?:(?:все|всё|all|the)\\s+)?${REMINDER_WORD}(?!${L})|(?<!${L})без\\s+напоминани${L}*`);
const HAS_REMINDER_WORD = re(`${NOT_WITH}(?<!${L})${REMINDER_WORD}(?!${L})`);
const EMAIL = re(`(?<!${L})(?:на\\s+почту|по\\s+почте|на\\s+e-?mail|по\\s+e-?mail|e-?mail|письм${L}*|на\\s+мейл|по\\s+мейлу)(?!${L})`);
const BEFORE_RU = re(`(?<!${L})за\\s+`, "giu");
const BEFORE_EN = re(`(?<!${L})((?:\\d+|an?|one|two|three|four|five|six|twelve)\\s+(?:minutes?|mins?|hours?|days?|weeks?))\\s+(?:before|ahead)(?!${L})`, "giu");

/** Служебные слова команды — после того как детали вырезаны, в поиск события не идут. */
const REST_NOISE = re(
  `^(?:и|до|перед|мне|нам|ей|ему|добавь|добавить|допиши|укажи|указать|поставь|поставить|установи|установить|сделай|включи|настрой|` +
    `измени|изменить|поменяй|поменять|смени|замени|убери|убрать|удали|удалить|сними|снять|отключи|выключи|сотри|очисти|отмени|` +
    `будет|пройдёт|пройдет|состоится|напоминани${L}*|напомни|напомнить|напоминай|напоминайте|напоминать|set|add|change|remove|clear|and|before|for)$`,
);

/** Время ли это: «в 15», «в среду» — да; «в офисе», «кафе Пушкин» — нет. */
function isDateFragment(text: string): boolean {
  const r = parseDateFragment({ text, kind: "point", now: "2026-01-01T00:00", tz: "UTC" });
  return !("error" in r) || r.error === "in_past";
}

/** Длительность «час», «сутки», «15 минут», «два дня» → минуты; месяцы — Infinity (больше 4 недель). */
function readMinutes(words: string[]): { minutes: number; n: number } | null {
  for (let n = Math.min(4, words.length); n >= 1; n--) {
    const text = words
      .slice(0, n)
      .join(" ")
      .replace(/[.,;!?]+$/, "");
    const r = parseDateFragment({ text, kind: "duration", now: "2026-01-01T00:00", tz: "UTC" });
    if ("duration" in r && r.duration !== "all_day") return { minutes: durationToMinutes(r.duration) ?? Number.POSITIVE_INFINITY, n };
  }
  return null;
}

function parseReminders(text: string): { hint?: RemindersHint; cut: [number, number][] } {
  const cut: [number, number][] = [];
  const removal = REMINDERS_REMOVE.exec(text);
  if (removal) return { hint: { overrides: [] }, cut: [[removal.index, removal.index + removal[0].length]] };
  // «на почту за день до встречи» — напоминание и без слова «напомни»
  if (!HAS_REMINDER_WORD.test(text) && !EMAIL.test(text)) return { cut };

  const method: ReminderOverride["method"] = EMAIL.test(text) ? "email" : "popup";
  const minutes: number[] = [];
  for (const m of text.matchAll(BEFORE_RU)) {
    const start = m.index;
    const after = text.slice(start + m[0].length);
    const words = after.split(/\s+/).filter(Boolean);
    const d = readMinutes(words);
    if (!d) continue;
    minutes.push(d.minutes);
    // Конец съеденного куска: «за» + n слов
    const consumed = words.slice(0, d.n).join(" ");
    const end = start + m[0].length + after.indexOf(consumed) + consumed.length;
    cut.push([start, end]);
  }
  for (const m of text.matchAll(BEFORE_EN)) {
    const d = readMinutes(m[1]!.split(/\s+/));
    if (!d) continue;
    minutes.push(d.minutes);
    cut.push([m.index, m.index + m[0].length]);
  }
  if (minutes.length === 0) return { cut: [] };
  const email = EMAIL.exec(text);
  if (email) cut.push([email.index, email.index + email[0].length]);

  const unique = [...new Set(minutes)].sort((a, b) => a - b);
  if (unique.some((x) => x > MAX_REMINDER_MIN)) return { hint: { error: "tooFar" }, cut };
  if (unique.length > MAX_REMINDERS) return { hint: { error: "tooMany" }, cut };
  return { hint: { overrides: unique.map((x) => ({ method, minutes: x })) }, cut };
}

function removeRanges(text: string, ranges: [number, number][]): string {
  let out = text;
  for (const [s, e] of [...ranges].sort((a, b) => b[0] - a[0])) out = `${out.slice(0, s)} ${out.slice(e)}`;
  return out;
}

export function detailHints(text: string): DetailHints {
  const h: DetailHints = { rest: text };
  let rest = text.trim();

  // Описание — до конца фразы: в нём могут быть любые слова, включая «место» и время
  const descRemove = DESC_REMOVE.exec(rest);
  const desc = descRemove ? null : DESC_SET.exec(rest);
  if (descRemove) {
    h.description = { text: "", append: false };
    rest = removeRanges(rest, [[descRemove.index, descRemove.index + descRemove[0].length]]);
  } else if (desc) {
    const before = rest.slice(0, desc.index);
    let value = desc[2]!.trim();
    let eventPart = "";
    // «измени описание встречи на …» — без двоеточия «на» отделяет событие от нового текста
    if (!/[:—–]/.test(desc[1]!) && REPLACE_VERB.test(before)) {
      const m = /^(.*?)\s+на\s+(.+)$/iu.exec(value);
      if (m) {
        eventPart = m[1]!;
        value = m[2]!.trim();
      }
    }
    h.description = { text: value, append: APPEND_VERB.test(before) };
    rest = `${before} ${eventPart}`;
  }

  const locRemove = LOC_REMOVE.exec(rest);
  const loc = locRemove ? null : (LOC_COLON.exec(rest) ?? LOC_CHANGE.exec(rest));
  const locAdd = locRemove || loc ? null : LOC_ADD.exec(rest);
  if (locRemove) {
    h.location = "";
    rest = removeRanges(rest, [[locRemove.index, locRemove.index + locRemove[0].length]]);
  } else if (loc) {
    h.location = loc[2]!.trim();
    rest = `${rest.slice(0, loc.index)} ${loc[1]}`;
  } else if (locAdd) {
    h.location = locAdd[1]!.trim();
    rest = rest.slice(0, locAdd.index);
  } else {
    const willBe = LOC_WILL_BE.exec(rest);
    if (willBe && !isDateFragment(willBe[1]!)) {
      // С предлогом: «в офисе на Лесной» читается как место, а «офисе на Лесной» — нет
      h.locationGuess = willBe[1]!.trim().replace(/[.!]+$/, "");
      rest = rest.slice(0, willBe.index);
    }
  }

  const rem = parseReminders(rest);
  if (rem.hint) {
    h.reminders = rem.hint;
    rest = removeRanges(rest, rem.cut);
  }

  const found = h.description || h.location !== undefined || h.locationGuess || h.reminders;
  if (!found) return h;
  h.location = h.location?.replace(/[.!]+$/, "");
  if (h.location === undefined) delete h.location;
  if (h.description) h.description.text = h.description.text.replace(/\s+$/, "");
  h.rest = rest
    .replace(/[:—–]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !REST_NOISE.test(w))
    .join(" ");
  return h;
}

/** Изменение деталей существующего события — даже если LLM решила, что это удаление («убери напоминания»). */
export function isDetailChange(text: string): boolean {
  const h = detailHints(text);
  return !!(h.description || h.location !== undefined || h.reminders);
}
