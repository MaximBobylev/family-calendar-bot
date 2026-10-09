// Схема и правила «структуры даты» для LLM (ревью парсера дат, шаг 4): модель раскладывает слова даты по полям, даты
// считает наш код (src/dates/structured.ts, ADR-0005 п.3). Один текст — и для поля `when` в create_event, и для замера
// scripts/eval-llm-dates.ts (режим B), чтобы замер мерил то, что в проде.

import { TYPOS } from "../dates/lexicon";
import { STRUCT_ERRORS, STRUCT_PARTS, STRUCT_WEEKDAYS, STRUCT_WHICH } from "../dates/structured";

const TIME = {
  type: "object",
  properties: {
    hour: { type: "integer" },
    minute: { type: "integer" },
    meridiem: { type: "string", enum: ["am", "pm", "day", "night"] },
    special: { type: "string", enum: ["noon", "midnight"] },
  },
  required: ["hour", "minute"],
};
const ABS = { type: "object", properties: { day: { type: "integer" }, month: { type: "integer" }, year: { type: "integer" } }, required: ["day"] };

/** Одна трактовка (без вложенных alternatives). */
const ONE_PROPERTIES = {
  error: { type: "string", enum: [...STRUCT_ERRORS] },
  day: {
    type: "object",
    properties: {
      type: { type: "string", enum: ["relative_days", "relative_months", "weekday", "date", "nth_weekday", "last_day"] },
      days: { type: "integer" },
      months: { type: "integer" },
      weekday: { type: "string", enum: [...STRUCT_WEEKDAYS] },
      which: { type: "string", enum: [...STRUCT_WHICH] },
      day: { type: "integer" },
      month: { type: "integer" },
      year: { type: "integer" },
      n: { type: "integer" },
      offset_days: { type: "integer" },
    },
    required: ["type"],
  },
  time: TIME,
  part_of_day: { type: "string", enum: [...STRUCT_PARTS] },
  in_minutes: { type: "integer" },
  interval: { type: "object", properties: { start: TIME, end: TIME }, required: ["start", "end"] },
  alt_time: TIME,
  date_range: { type: "object", properties: { from: ABS, to: ABS }, required: ["from", "to"] },
  period: {
    type: "object",
    properties: {
      type: { type: "string", enum: ["week", "weekend", "month", "next_days", "segment"] },
      which: { type: "string", enum: ["this", "next", "auto"] },
      month: { type: "integer" },
      days: { type: "integer" },
      unit: { type: "string", enum: ["week", "month"] },
      segment: { type: "string", enum: ["begin", "middle", "end"] },
    },
    required: ["type"],
  },
  by: { type: "boolean" },
  timezone: { type: "string" },
};

/** JSON-схема структуры (параметр tool). */
export const DATE_STRUCTURE_SCHEMA = {
  type: "object",
  properties: { ...ONE_PROPERTIES, alternatives: { type: "array", items: { type: "object", properties: ONE_PROPERTIES } } },
};

const typoList = [...TYPOS].map(([bad, good]) => `${bad}=${good}`).join(", ");

/** Правила заполнения структуры (английский — так модели точнее; примеры фраз — по-русски и по-английски). */
export const DATE_STRUCTURE_RULES = `You do NOT compute dates: our code applies the calendar rules (hours without am/pm, past times, nearest weekday, ambiguity, time zones). Copy numbers as said. Omit fields that are not said.
- error: "unparseable" — vague («на днях», «скоро», «в середине недели», «после работы»); deadlines («до пятницы», «к обеду», «к утру», «к концу недели/дня», «by the end of the week», «к следующей неделе», «EOD»); «в начале/середине/конце месяца/недели» when kind=point; unknown words; real words that only look like dates («пятно», «завтрак»); English «night» alone as a name («Jazz Night»); an unknown city/zone.
  "unsupported" — a date construct these fields cannot express EXACTLY (relative to an unknown event: «после отпуска», «за два дня до Пасхи», «в день зарплаты»; «каждый второй…» in a single event). NEVER squeeze such a phrase into a near field.
  "empty" — no words at all. "invalid_time" — only if you cannot copy the numbers (otherwise copy them as said: «в 26:10» → hour 26, minute 10; our code rejects it).
- Typos from this closed list are the same word: ${typoList}; «ё» = «е» («четвёрг» = четверг). Other misspellings → unparseable. Latin look-alike letters inside Russian words are fine.
- Colloquial: «пара» = 2 («через пару недель» = 14 days, «a couple of weeks» = 14 days), «денёк/денька» = день, «часик» = час, «недельку» = неделю, «после завтра» = послезавтра, «след./будущая неделя» = следующая.
- day: {type: "relative_days", days} — сегодня 0, завтра 1, послезавтра 2, «через 3 дня» 3, «через неделю» 7, «через две недели» 14.
       {type: "relative_months", months} — «через месяц» 1.
       {type: "weekday", weekday: MO..SU, which} — which: none «в пятницу»; this «в эту/ближайшую пятницу», «this Friday»; next «в следующую пятницу», «next Friday»; next_week «в пятницу на следующей неделе», «next week Friday»; plus_week «в понедельник через неделю», «через неделю в понедельник».
       {type: "date", day, month?, year?, weekday?} — «14 октября», «14.10», «на 14-е» (no month), «в среду 14-го» (weekday WE).
       {type: "nth_weekday", n, weekday, month?} — n-th weekday of a month: «во вторую субботу декабря» n 2 SA month 12; «last Thursday of March» n -1 TH month 3; no month named («этого месяца», «of the month») → omit month.
       {type: "last_day", month?} — «в последний день месяца»; the N-th day from the end → last_day with offset_days -(N-1).
       Any day may carry offset_days (inside day) — days before/after it: «за два дня до 20 декабря» → {type: "date", day: 20, month: 12, offset_days: -2}; «через три дня после 5-го» → {type: "date", day: 5, offset_days: 3}.
- time: {hour, minute, meridiem?, special?} — hour exactly as said («в 3» → 3, «в 15» → 15, «9pm» → 9 + pm). A bare number after «в/на/к/at/by» is an HOUR, not a day: «на 4» → hour 4; «на 4-е», «4-го» → day 4. meridiem only from a word attached to the time: «утра»/am → am; «вечера»/pm → pm; «дня» → day; «ночи» → night. полдень/noon → special noon, hour 12; полночь/midnight → special midnight, hour 0. «полтретьего» → 2:30, «без пятнадцати три» → 2:45, «в пять минут восьмого» → 7:05, «в час» → 1:00, «в обед» → 13:00, «first thing», «первым делом», «с утра пораньше» → 9:00 am. «около/где-то/часов в» — just the time. «15-30», «15.30», «в 15 30» → 15:30.
- part_of_day: morning (утром, с утра, в первой половине дня, in the morning) | day (днём, во второй половине дня) | afternoon (после обеда, после полудня, afternoon) | late_afternoon (ближе к вечеру, к вечеру, под вечер, late afternoon) | evening (вечером, вечерком, tonight, English «night» with a day or «at night») | night (ночью, Russian only; «в ночь со среды на четверг» = weekday WE + night). With a time: «в пятницу вечером в 7» → part evening + hour 7 (no meridiem). «завтра в 2 ночи» → time 2 meridiem night (no part).
- in_minutes: a real-time offset from now without a named hour — «через час» 60, «через полтора часа» 90, «in 2 hours» 120. «сутки» are ALWAYS 24 real hours: «через сутки» 1440, «через N суток» N×1440 (in_minutes, never day). Only with a named hour «через сутки в 10» → day relative_days 1 + time.
- interval: {start, end} — «с 10 до 12», «10-12», «from 1 to 2pm» (meridiem only on end, as said), «с 23 до 2». Plus day if named.
- alt_time: only for «A-15» with A < 15 and no part-of-day word («в 9-15»): interval A–15 AND alt_time A:15. «в 16-15», «в 20-30» → plain time; «в 8-15 вечера» → plain time 8:15 pm (no interval).
- date_range: {from: {day, month?}, to: {day, month?}} — «с 10 по 20 ноября».
- period: week — «на этой неделе», «на неделе», «this week» (this); «до конца недели» and English equivalents (this); «на следующей неделе», «next week» (next).
          weekend — «в выходные», «на выходных», «this weekend» (this); «на следующих выходных» (next).
          month — «в этом месяце», «до конца месяца» and English equivalents (this); «в следующем месяце» (next); «в ноябре» (month 11).
          next_days — «ближайшие 3 дня» (days 3), «на две недели вперёд» (days 14).
          segment — unit week|month, segment begin|middle|end («в начале/середине/конце», «at the end of next week»), which auto (no qualifier) | this («этого/этой») | next («следующего/следующей») or month N («в конце ноября»).
          A weekday «на следующей неделе» → day weekday next_week, not a period. A period combines with a part of day: «на этой неделе утром» → period week + part morning.
- by: true — «к»/«by» + a date or hour: «к пятнице», «by Friday», «к 5 ноября», «к 18», «к вечеру» (+ part late_afternoon).
- timezone: IANA zone, only if a zone is named: «по Киеву» Europe/Kyiv, «по МСК»/«мск» Europe/Moscow, «London time» Europe/London, «по UTC+4» Etc/GMT-4. Known cities: Moscow, Kyiv, Minsk, Kaliningrad, Yekaterinburg, Novosibirsk, Tbilisi, Yerevan, Almaty, Tashkent, Baku, Warsaw, Berlin, Prague, Paris, London, Lisbon, Belgrade, Istanbul, Dubai, New York, Los Angeles, São Paulo, Buenos Aires; another city → error unparseable. «по местному», «local time» → omit.
- alternatives: only when the phrase itself names several options — «в среду или в четверг в 10» → {day WE, time 10} + alternatives [{day TH, time 10}]. Each alternative is a full structure.`;
