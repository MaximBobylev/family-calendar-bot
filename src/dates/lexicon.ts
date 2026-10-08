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
    WE: ["среда", "среду", "среды", "среде", "ср", "wednesday", "wed", "weds", "wednesdays"],
    TH: ["четверг", "четверга", "четвергу", "четверги", "чт", "thursday", "thu", "thur", "thurs", "thursdays"],
    FR: ["пятница", "пятницу", "пятницы", "пятнице", "пт", "friday", "fri", "fridays"],
    SA: ["суббота", "субботу", "субботы", "субботе", "сб", "saturday", "sat", "saturdays"],
    SU: ["воскресенье", "воскресенья", "воскресенью", "вс", "sunday", "sun", "sundays"],
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
    1: ["январь", "января", "январе", "янв", "jan", "january"],
    2: ["февраль", "февраля", "феврале", "фев", "февр", "feb", "february"],
    3: ["март", "марта", "марте", "мар", "mar", "march"],
    4: ["апрель", "апреля", "апреле", "апр", "apr", "april"],
    5: ["май", "мая", "мае", "may"],
    6: ["июнь", "июня", "июне", "июн", "jun", "june"],
    7: ["июль", "июля", "июле", "июл", "jul", "july"],
    8: ["август", "августа", "августе", "авг", "aug", "august"],
    9: ["сентябрь", "сентября", "сентябре", "сен", "сент", "sep", "sept", "september"],
    10: ["октябрь", "октября", "октябре", "окт", "oct", "october"],
    11: ["ноябрь", "ноября", "ноябре", "ноя", "нояб", "nov", "november"],
    12: ["декабрь", "декабря", "декабре", "дек", "dec", "december"],
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
  // собирательные — «через двое суток»
  двое: 2, трое: 3, четверо: 4,
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
  четвертый: 4, четвертую: 4, четвертое: 4, последний: -1, последнюю: -1, последнее: -1,
  // «первое ноября», «двадцать пятое октября» — средний род только для чисел месяца
  пятое: 5, шестое: 6, седьмое: 7, восьмое: 8, девятое: 9, десятое: 10, одиннадцатое: 11, двенадцатое: 12,
  тринадцатое: 13, четырнадцатое: 14, пятнадцатое: 15, шестнадцатое: 16, семнадцатое: 17, восемнадцатое: 18,
  девятнадцатое: 19, двадцатое: 20, тридцатое: 30,
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
  ["утречком", "morning"], ["поутру", "morning"],
  ["днем", "day"],
  ["вечером", "evening"], ["вечерком", "evening"], ["evening", "evening"], ["tonight", "evening"],
  // «завтра ночью» — ночь ПОСЛЕ названного дня (point.ts); английское night — поздний вечер, как tonight
  ["ночью", "night"], ["night", "evening"],
  ["afternoon", "afternoon"],
]);

/** Границы частей суток в минутах (date-rules.md). */
export const DAY_PART_BOUNDS: Record<DayPart, [number, number]> = {
  morning: [6 * 60, 12 * 60],
  day: [12 * 60, 18 * 60],
  afternoon: [13 * 60, 18 * 60],
  late_afternoon: [16 * 60, 20 * 60],
  evening: [18 * 60, 24 * 60],
  night: [0, 6 * 60],
};

/** day24 — «сутки»: 24 реальных часа, а не календарный день. */
export type Unit = "minute" | "hour" | "day24" | "day" | "week" | "fortnight" | "month" | "year";
export const UNITS = index<Unit>(
  {
    minute: ["минута", "минуты", "минут", "минуту", "мин", "минутку", "минутки", "минуток", "minute", "minutes", "min", "mins"],
    hour: ["час", "часа", "часов", "ч", "часик", "часика", "часиков", "часок", "hour", "hours", "h", "hr", "hrs"],
    day24: ["сутки", "суток"],
    day: ["день", "дня", "дней", "денек", "денька", "деньков", "day", "days"],
    week: ["неделя", "неделю", "недели", "недель", "недельку", "недельки", "неделек", "week", "weeks"],
    fortnight: ["fortnight", "fortnights"],
    month: ["месяц", "месяца", "месяцев", "month", "months"],
    year: ["год", "года", "лет", "year", "years"],
  },
  (k) => k as Unit,
);

/** Служебные слова, которые можно пропускать. */
export const FILLERS = new Set(["в", "во", "на", "at", "on", "the", "к", "of", "for", "to"]);

/**
 * Явно названные пояса: «в 15 по Киеву», «по киевскому времени», «по времени Киева», «3pm London time» (tech-debt #26).
 * Формы — дательный (после «по»), родительный («по времени …»), прилагательное и английское имя; `ru` / `en` — подпись в
 * карточке («по Киеву» / «Kyiv time»). Пояс — IANA-имя, которое знает любой ICU (Europe/Kiev, а не Europe/Kyiv).
 */
export interface ZoneCity { tz: string; ru: string; en: string; forms: string[] }
export const ZONE_CITIES: ZoneCity[] = [
  { tz: "Europe/Moscow",      ru: "Москве",       en: "Moscow",       forms: ["москве", "москвы", "московскому", "мск", "msk", "moscow"] },
  { tz: "Europe/Kiev",        ru: "Киеву",        en: "Kyiv",         forms: ["киеву", "киева", "киевскому", "kyiv", "kiev"] },
  { tz: "Europe/Minsk",       ru: "Минску",       en: "Minsk",        forms: ["минску", "минска", "минскому", "minsk"] },
  { tz: "Europe/Kaliningrad", ru: "Калининграду", en: "Kaliningrad",  forms: ["калининграду", "калининграда", "калининградскому", "kaliningrad"] },
  { tz: "Asia/Yekaterinburg", ru: "Екатеринбургу", en: "Yekaterinburg", forms: ["екатеринбургу", "екатеринбурга", "екатеринбургскому", "yekaterinburg"] },
  { tz: "Asia/Novosibirsk",   ru: "Новосибирску", en: "Novosibirsk",  forms: ["новосибирску", "новосибирска", "новосибирскому", "novosibirsk"] },
  { tz: "Asia/Tbilisi",       ru: "Тбилиси",      en: "Tbilisi",      forms: ["тбилиси", "тбилисскому", "tbilisi"] },
  { tz: "Asia/Yerevan",       ru: "Еревану",      en: "Yerevan",      forms: ["еревану", "еревана", "ереванскому", "yerevan"] },
  { tz: "Asia/Almaty",        ru: "Алматы",       en: "Almaty",       forms: ["алматы", "алма-ате", "алматинскому", "almaty"] },
  { tz: "Asia/Tashkent",      ru: "Ташкенту",     en: "Tashkent",     forms: ["ташкенту", "ташкента", "ташкентскому", "tashkent"] },
  { tz: "Asia/Baku",          ru: "Баку",         en: "Baku",         forms: ["баку", "бакинскому", "baku"] },
  { tz: "Europe/Warsaw",      ru: "Варшаве",      en: "Warsaw",       forms: ["варшаве", "варшавы", "варшавскому", "warsaw"] },
  { tz: "Europe/Berlin",      ru: "Берлину",      en: "Berlin",       forms: ["берлину", "берлина", "берлинскому", "berlin"] },
  { tz: "Europe/Prague",      ru: "Праге",        en: "Prague",       forms: ["праге", "праги", "пражскому", "prague"] },
  { tz: "Europe/Paris",       ru: "Парижу",       en: "Paris",        forms: ["парижу", "парижа", "парижскому", "paris"] },
  { tz: "Europe/London",      ru: "Лондону",      en: "London",       forms: ["лондону", "лондона", "лондонскому", "london"] },
  { tz: "Europe/Lisbon",      ru: "Лиссабону",    en: "Lisbon",       forms: ["лиссабону", "лиссабона", "лиссабонскому", "lisbon"] },
  { tz: "Europe/Belgrade",    ru: "Белграду",     en: "Belgrade",     forms: ["белграду", "белграда", "белградскому", "belgrade"] },
  { tz: "Europe/Istanbul",    ru: "Стамбулу",     en: "Istanbul",     forms: ["стамбулу", "стамбула", "стамбульскому", "istanbul"] },
  { tz: "Asia/Dubai",         ru: "Дубаю",        en: "Dubai",        forms: ["дубаю", "дубая", "дубайскому", "dubai"] },
  { tz: "America/New_York",   ru: "Нью-Йорку",    en: "New York",     forms: ["нью-йорку", "нью-йорка", "нью-йоркскому", "new york", "nyc"] },
  { tz: "America/Los_Angeles", ru: "Лос-Анджелесу", en: "Los Angeles", forms: ["лос-анджелесу", "лос-анджелеса", "los angeles"] },
  { tz: "America/Sao_Paulo",  ru: "Сан-Паулу",    en: "São Paulo",    forms: ["сан-паулу", "sao paulo", "são paulo"] },
  { tz: "America/Argentina/Buenos_Aires", ru: "Буэнос-Айресу", en: "Buenos Aires", forms: ["буэнос-айресу", "буэнос-айреса", "buenos aires"] },
];

/** Пояс без «по» / «time»: только сокращения («в 12 мск», «at 3pm UTC»). Название города без предлога — не пояс («Nobu London»). */
export const BARE_ZONE_WORDS = new Set(["мск", "msk", "utc", "gmt"]);

/** «по местному (времени)», «local time» — пояс пользователя: слово съедаем, ничего не пересчитываем. */
export const LOCAL_ZONE_WORDS = new Set(["местному", "нашему", "моему", "вашему", "local", "my", "our"]);

/**
 * Опечатки и искажения распознавания — только точные слова, которые не совпадают с настоящими
 * (никакого нечёткого поиска: «пятно» не должно стать «пятницей»).
 */
export const TYPOS = new Map<string, string>([
  ["завтро", "завтра"], ["завтре", "завтра"], ["послезавтро", "послезавтра"],
  ["сегоня", "сегодня"], ["седня", "сегодня"], ["севодня", "сегодня"], ["сиводня", "сегодня"], ["сегодни", "сегодня"],
  ["понедельнек", "понедельник"], ["понидельник", "понедельник"], ["панедельник", "понедельник"],
  ["вторнек", "вторник"], ["чтверг", "четверг"], ["четвег", "четверг"],
  ["пятнцу", "пятницу"], ["пятнецу", "пятницу"], ["пятнца", "пятница"],
  ["суботу", "субботу"], ["субота", "суббота"], ["суботы", "субботы"], ["суботе", "субботе"],
  ["воскресение", "воскресенье"], ["воскресения", "воскресенья"], ["васкресенье", "воскресенье"],
  ["tommorow", "tomorrow"], ["tomorow", "tomorrow"], ["tommorrow", "tomorrow"], ["tmrw", "tomorrow"], ["tmr", "tomorrow"],
  ["tonite", "tonight"], ["wensday", "wednesday"], ["wendsday", "wednesday"], ["wednsday", "wednesday"],
  ["tuseday", "tuesday"], ["thurday", "thursday"], ["febuary", "february"],
]);
