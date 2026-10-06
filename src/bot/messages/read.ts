// Тексты: расписание и списки событий (US-20), «следующая встреча» (US-21), пометки о незагруженных календарях.

import type { Messages } from "./types";

export const readMessages = {
  today: { ru: "Сегодня", en: "Today" },
  tomorrow: { ru: "Завтра", en: "Tomorrow" },
  allDay: { ru: "Весь день", en: "All day" },
  until: { ru: "до", en: "until" },
  nextDayShort: { ru: "след. день", en: "next day" },
  free: { ru: "свободно", en: "free" },
  noEvents: { ru: "Встреч нет 🎉", en: "No events 🎉" },
  calendarFailed: { ru: "⚠️ Календарь {list} не загрузился — его встречи не показаны.", en: "⚠️ Calendar {list} didn't load — its events are not shown." },
  calendarsFailed: { ru: "⚠️ Календари {list} не загрузились — их встречи не показаны.", en: "⚠️ Calendars {list} didn't load — their events are not shown." },
  rangeUnparseable: {
    ru: "Не понял, за какой период показать. Например: «завтра», «на этой неделе», «в пятницу».",
    en: "I didn't get the period. For example: “tomorrow”, “this week”, “on Friday”.",
  },
  rangeAmbiguous: {
    ru: "Уточните, какой период: {options}?",
    en: "Which period do you mean: {options}?",
  },
  or: { ru: "или", en: "or" },
  // --- Следующая / конкретная встреча (US-21) ---
  lookupNext: { ru: "Следующая встреча:", en: "Next event:" },
  lookupRunning: { ru: "Сейчас идёт: <b>{title}</b> (до {until})", en: "Happening now: <b>{title}</b> (until {until})" },
  lookupNoneAhead: { ru: "В ближайшие {days} дней встреч нет.", en: "No events in the next {days} days." },
  lookupFoundOne: { ru: "Ближайшее:", en: "Coming up:" },
  lookupFound: { ru: "Ближайшие:", en: "Coming up:" },
  lookupNotFound: { ru: "В ближайшие {days} дней «{query}» не нашёл.", en: "Couldn't find “{query}” in the next {days} days." },
} as const satisfies Messages;
