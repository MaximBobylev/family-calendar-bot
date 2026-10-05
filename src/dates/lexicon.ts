// Словари RU / EN. Все слова — в нормализованном виде: нижний регистр, «ё» → «е».

import type { DayPart, Weekday } from "./types";

function index<T>(groups: Record<string, string[]>, map: (key: string) => T): Map<string, T> {
  const out = new Map<string, T>();
  for (const [key, words] of Object.entries(groups)) for (const w of words) out.set(w, map(key));
  return out;
}

export const WEEKDAYS = index<Weekday>(
  {
    MO: ["понедельник", "понедельника", "понедельнику", "понедельники", "пн", "monday", "mon", "mondays"],
    TU: ["вторник", "вторника", "вторнику", "вторники", "вт", "tuesday", "tue", "tues", "tuesdays"],
    WE: ["среда", "среду", "среды", "среде", "ср", "wednesday", "wed", "wednesdays"],
    TH: ["четверг", "четверга", "четвергу", "четверги", "чт", "thursday", "thu", "thur", "thurs", "thursdays"],
    FR: ["пятница", "пятницу", "пятницы", "пятнице", "пт", "friday", "fri", "fridays"],
    SA: ["суббота", "субботу", "субботы", "субботе", "сб", "saturday", "sat", "saturdays"],
    SU: ["воскресенье", "воскресенья", "вс", "sunday", "sun", "sundays"],
  },
  (k) => k as Weekday,
);

/** «по понедельникам», «по средам» — только в повторениях. */
export const WEEKDAYS_PLURAL_DATIVE = index<Weekday>(
  {
    MO: ["понедельникам"],
    TU: ["вторникам"],
    WE: ["средам"],
    TH: ["четвергам"],
    FR: ["пятницам"],
    SA: ["субботам"],
    SU: ["воскресеньям"],
  },
  (k) => k as Weekday,
);

export const WEEKDAY_INDEX: Record<Weekday, number> = { MO: 0, TU: 1, WE: 2, TH: 3, FR: 4, SA: 5, SU: 6 };

export const MONTHS = index<number>(
  {
    1: ["январь", "января", "январе", "jan", "january"],
    2: ["февраль", "февраля", "феврале", "feb", "february"],
    3: ["март", "марта", "марте", "mar", "march"],
    4: ["апрель", "апреля", "апреле", "apr", "april"],
    5: ["май", "мая", "мае", "may"],
    6: ["июнь", "июня", "июне", "jun", "june"],
    7: ["июль", "июля", "июле", "jul", "july"],
    8: ["август", "августа", "августе", "aug", "august"],
    9: ["сентябрь", "сентября", "сентябре", "sep", "sept", "september"],
    10: ["октябрь", "октября", "октябре", "oct", "october"],
    11: ["ноябрь", "ноября", "ноябре", "nov", "november"],
    12: ["декабрь", "декабря", "декабре", "dec", "december"],
  },
  Number,
);

/** Предложный падеж месяца: «в ноябре» — это период, а не дата. */
export const MONTHS_PREPOSITIONAL = new Set([
  "январе", "феврале", "марте", "апреле", "мае", "июне", "июле", "августе", "сентябре", "октябре", "ноябре", "декабре",
]);

export type NumberForm = "card" | "gen" | "ordGen" | "ordNom";

export const NUMBER_WORDS = new Map<string, { v: number; form: NumberForm }>();
function addNumbers(form: NumberForm, words: Record<string, number>) {
  for (const [w, v] of Object.entries(words)) NUMBER_WORDS.set(w, { v, form });
}
addNumbers("card", {
  ноль: 0, один: 1, одна: 1, одну: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7, восемь: 8,
  девять: 9, десять: 10, одиннадцать: 11, двенадцать: 12, тринадцать: 13, четырнадцать: 14, пятнадцать: 15,
  шестнадцать: 16, семнадцать: 17, восемнадцать: 18, девятнадцать: 19, двадцать: 20, тридцать: 30, сорок: 40,
  пятьдесят: 50,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  fifteen: 15, twenty: 20, thirty: 30,
});
addNumbers("gen", {
  двух: 2, трех: 3, четырех: 4, пяти: 5, шести: 6, семи: 7, восьми: 8, девяти: 9, десяти: 10, одиннадцати: 11,
  двенадцати: 12, пятнадцати: 15, двадцати: 20, тридцати: 30, сорока: 40, пятидесяти: 50,
  часу: 1, // «с часу до двух»
});
addNumbers("ordGen", {
  первого: 1, второго: 2, третьего: 3, четвертого: 4, пятого: 5, шестого: 6, седьмого: 7, восьмого: 8, девятого: 9,
  десятого: 10, одиннадцатого: 11, двенадцатого: 12, тринадцатого: 13, четырнадцатого: 14, пятнадцатого: 15,
  шестнадцатого: 16, семнадцатого: 17, восемнадцатого: 18, девятнадцатого: 19, двадцатого: 20, тридцатого: 30,
});
addNumbers("ordNom", {
  первый: 1, первую: 1, первое: 1, второй: 2, вторую: 2, второе: 2, третий: 3, третью: 3, третье: 3,
  четвертый: 4, четвертую: 4, последний: -1, последнюю: -1, последнее: -1,
  first: 1, second: 2, third: 3, fourth: 4, last: -1,
});
export const TENS = new Set([20, 30, 40, 50]);

/** Часть суток после времени: «в 7 вечера», «в 3 ночи», «9am». */
export type Meridiem = "am" | "pm" | "day" | "night";
export const MERIDIEM_WORDS = new Map<string, Meridiem>([
  ["утра", "am"], ["am", "am"], ["a.m", "am"],
  ["дня", "day"],
  ["вечера", "pm"], ["pm", "pm"], ["p.m", "pm"],
  ["ночи", "night"],
]);

/** Часть суток как самостоятельное указание: «завтра утром». */
export const DAY_PART_WORDS = new Map<string, DayPart>([
  ["утром", "morning"], ["morning", "morning"],
  ["днем", "day"],
  ["вечером", "evening"], ["evening", "evening"], ["tonight", "evening"],
  ["ночью", "night"], ["night", "night"],
  ["afternoon", "afternoon"],
]);

/** Границы частей суток в минутах (date-rules.md). */
export const DAY_PART_BOUNDS: Record<DayPart, [number, number]> = {
  morning: [6 * 60, 12 * 60],
  day: [12 * 60, 18 * 60],
  afternoon: [13 * 60, 18 * 60],
  evening: [18 * 60, 24 * 60],
  night: [0, 6 * 60],
};

export type Unit = "minute" | "hour" | "day" | "week" | "month" | "year";
export const UNITS = index<Unit>(
  {
    minute: ["минута", "минуты", "минут", "минуту", "мин", "minute", "minutes", "min", "mins"],
    hour: ["час", "часа", "часов", "ч", "hour", "hours", "h", "hr", "hrs"],
    day: ["день", "дня", "дней", "сутки", "суток", "day", "days"],
    week: ["неделя", "неделю", "недели", "недель", "week", "weeks"],
    month: ["месяц", "месяца", "месяцев", "month", "months"],
    year: ["год", "года", "лет", "year", "years"],
  },
  (k) => k as Unit,
);

/** Служебные слова, которые можно пропускать. */
export const FILLERS = new Set(["в", "во", "на", "at", "on", "the", "к", "of", "for", "to"]);

/** Явно названные пояса: «в 12 по Москве», «по МСК». */
export const TIMEZONE_WORDS = new Map<string, string>([
  ["москве", "Europe/Moscow"], ["мск", "Europe/Moscow"], ["московскому", "Europe/Moscow"], ["moscow", "Europe/Moscow"],
  ["тбилиси", "Asia/Tbilisi"], ["tbilisi", "Asia/Tbilisi"],
  ["берлину", "Europe/Berlin"], ["berlin", "Europe/Berlin"],
  ["лондону", "Europe/London"], ["london", "Europe/London"],
  ["utc", "UTC"], ["gmt", "UTC"],
]);
