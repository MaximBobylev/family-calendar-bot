// kind=recurrence: «каждый понедельник в 10», «по будням до конца года», «в последнюю пятницу месяца».

import { parts, formatDate, type Day } from "./calendar";
import { MONTHS, NUMBER_WORDS, WEEKDAYS, WEEKDAYS_PLURAL_DATIVE } from "./lexicon";
import { resolveAbsDate, readClockTime, resolveHour } from "./point";
import type { ParseResult, Recurrence, Weekday } from "./types";
import type { Token } from "./tokenize";

const WEEKDAYS_WORK: Weekday[] = ["MO", "TU", "WE", "TH", "FR"];
const WEEKEND: Weekday[] = ["SA", "SU"];

const EVERY = new Set(["каждый", "каждую", "каждое", "каждые", "каждого", "every", "each"]);
const LIST_JOINERS = new Set(["и", "and", "по"]);

const word = (tok: Token | undefined) => (tok?.t === "word" ? tok.w : undefined);

export function parseRecurrence(tokens: Token[], today: Day): ParseResult {
  const r: Partial<Recurrence> = {};
  const days: Weekday[] = [];
  let i = 0;

  const addDays = (list: Weekday[]) => {
    for (const d of list) if (!days.includes(d)) days.push(d);
  };

  while (i < tokens.length) {
    const tok = tokens[i]!;
    const w = word(tok);
    const next = word(tokens[i + 1]);

    // Частота словом
    if (w === "ежедневно" || w === "daily") { r.freq = "daily"; i++; continue; }
    if (w === "еженедельно" || w === "weekly") { r.freq = "weekly"; i++; continue; }
    if (w === "ежемесячно" || w === "monthly") { r.freq = "monthly"; i++; continue; }
    if (w === "ежегодно" || w === "yearly" || w === "annually") { r.freq = "yearly"; i++; continue; }

    // «раз в две недели», «every 2 weeks»
    if (w === "раз" && word(tokens[i + 1]) === "в") {
      const n = tokens[i + 2]?.t === "num" ? (tokens[i + 2] as { v: number }).v : 1;
      const unitIdx = tokens[i + 2]?.t === "num" ? i + 3 : i + 2;
      const unit = word(tokens[unitIdx]);
      if (unit && /^недел/.test(unit)) { r.freq = "weekly"; r.interval = n; i = unitIdx + 1; continue; }
      if (unit && /^месяц/.test(unit)) { r.freq = "monthly"; r.interval = n; i = unitIdx + 1; continue; }
      if (unit && /^(день|дня|дней)$/.test(unit)) { r.freq = "daily"; r.interval = n; i = unitIdx + 1; continue; }
      return { error: "unparseable" };
    }
    // «every other Friday», «каждую вторую среду» (без «месяца») — раз в две недели
    const mentionsMonth = tokens.slice(i).some((t) => word(t) === "месяца" || word(t) === "month");
    if ((w === "other" || (tok.t === "num" && tok.form === "ordNom" && tok.v === 2)) && !mentionsMonth) {
      r.interval = 2;
      i++;
      continue;
    }

    if (w && EVERY.has(w)) {
      // «каждый день / каждую неделю / каждый месяц / каждый год»
      if (next && /^(день|day)$/.test(next)) { r.freq = "daily"; i += 2; continue; }
      if (next && /^(неделю|week)$/.test(next)) { r.freq = "weekly"; i += 2; continue; }
      if (next && /^(месяц|month)$/.test(next)) { r.freq = "monthly"; i += 2; continue; }
      if (next && /^(год|year)$/.test(next)) { r.freq = "yearly"; i += 2; continue; }
      // «каждые две недели», «every 3 days»
      const n = tokens[i + 1];
      const unit = word(tokens[i + 2]);
      if (n?.t === "num" && (n.form === "card" || n.form === "digit") && unit) {
        const freq = /^(недел|week)/.test(unit) ? "weekly" : /^(дн|day)/.test(unit) ? "daily" : /^(месяц|month)/.test(unit) ? "monthly" : undefined;
        if (freq) { r.freq = freq; r.interval = n.v; i += 3; continue; }
      }
      i++;
      continue;
    }

    // «по будням», «по выходным», «по четвергам», «weekdays», «weekends»
    if (w === "будням" || w === "будни" || w === "weekday" || w === "weekdays") { addDays(WEEKDAYS_WORK); i++; continue; }
    if (w === "выходным" || w === "выходные" || w === "weekend" || w === "weekends") { addDays(WEEKEND); i++; continue; }
    if (w && (WEEKDAYS_PLURAL_DATIVE.has(w) || WEEKDAYS.has(w))) {
      addDays([(WEEKDAYS_PLURAL_DATIVE.get(w) ?? WEEKDAYS.get(w))!]);
      i++;
      continue;
    }

    // «в первый понедельник месяца», «в последнюю пятницу месяца», «каждую вторую среду месяца»
    if (tok.t === "num" && tok.form === "ordNom") {
      const wd = WEEKDAYS.get(word(tokens[i + 1]) ?? "");
      if (wd) {
        r.freq = "monthly";
        r.by_set_pos = tok.v;
        addDays([wd]);
        i += 2;
        continue;
      }
      // «в последний день месяца»
      if (tok.v === -1 && word(tokens[i + 1]) === "день") {
        r.freq = "monthly";
        r.by_month_day = -1;
        i += 2;
        continue;
      }
    }
    if (w === "месяца" || w === "month") { r.freq ??= "monthly"; i++; continue; }

    // «каждое 15 число», «31 числа каждого месяца»
    if (tok.t === "num" && (word(tokens[i + 1]) === "число" || word(tokens[i + 1]) === "числа")) {
      r.freq = "monthly";
      r.by_month_day = tok.v;
      i += 2;
      continue;
    }
    if (w === "каждого" && word(tokens[i + 1]) === "месяца") { r.freq = "monthly"; i += 2; continue; }

    // «3 марта» в «каждый год 3 марта»
    if (tok.t === "num" && MONTHS.has(word(tokens[i + 1]) ?? "")) {
      r.by_month = MONTHS.get(word(tokens[i + 1])!)!;
      r.by_month_day = tok.v;
      r.freq ??= "yearly";
      i += 2;
      continue;
    }

    // «10 раз», «10 times»
    if (tok.t === "num" && /^(раз|times)$/.test(word(tokens[i + 1]) ?? "")) {
      r.count = tok.v;
      i += 2;
      continue;
    }

    // «до конца года», «до 1 декабря», «until Dec 1»
    if (w === "до" || w === "until") {
      if (word(tokens[i + 1]) === "конца" && word(tokens[i + 2]) === "года") {
        r.until = `${parts(today).year}-12-31`;
        i += 3;
        continue;
      }
      if (tokens[i + 1]?.t === "num" && MONTHS.has(word(tokens[i + 2]) ?? "")) {
        const res = resolveAbsDate({ d: (tokens[i + 1] as { v: number }).v, m: MONTHS.get(word(tokens[i + 2])!)! }, today);
        if ("error" in res) return res;
        r.until = formatDate(res.day);
        i += 3;
        continue;
      }
      return { error: "unparseable" };
    }

    // Время: «в 10», «at 9», «в 15:30», «в 3» → 15:00
    if (w === "в" || w === "at" || w === "on") { i++; continue; }
    const time = readClockTime(tokens, i, true);
    if (time) {
      if ("error" in time) return time;
      const h = resolveHour(time.time);
      r.time = `${String(h.hour).padStart(2, "0")}:${String(time.time.m).padStart(2, "0")}`;
      i += time.n;
      continue;
    }
    if (w && LIST_JOINERS.has(w)) { i++; continue; }
    if (w && NUMBER_WORDS.has(w)) { i++; continue; }

    return { error: "unparseable" };
  }

  if (days.length) {
    r.by_day = days;
    r.freq ??= "weekly";
  }
  if (!r.freq) return { error: "unparseable" };
  if (r.freq === "monthly" && r.by_month_day !== undefined && r.by_month_day > 28) r.warning = "skips_short_months";
  return { recurrence: r as Recurrence };
}
