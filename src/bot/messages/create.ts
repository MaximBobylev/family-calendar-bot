// Тексты: создание события (US-30/31/32) — карточка, серии, вопросы «когда?», «во сколько?», «как назвать?».

import type { Messages } from "./types";

export const createMessages = {
  calendarNotFound: {
    ru: "Не нашёл календарь «{name}». Ваши календари: {list}.",
    en: "I couldn't find the calendar “{name}”. Your calendars: {list}.",
  },
  createConfirm: { ru: "Создать событие?", en: "Create this event?" },
  createSeriesConfirm: { ru: "Создать повторяющееся событие?", en: "Create this recurring event?" },
  seriesNext: { ru: "Ближайшие: {list}", en: "Next: {list}" },
  seriesMonthly: { ru: "Каждый месяц {day}-го", en: "Every month on day {day}" },
  seriesShortMonthsQuestion: {
    ru: "Не во всех месяцах есть {day}-е число. Как быть в такие месяцы?",
    en: "Not every month has day {day}. What about those months?",
  },
  seriesSkipOption: { ru: "пропускать", en: "skip" },
  seriesLastDayOption: { ru: "в последний день месяца", en: "on the last day" },
  seriesSkipButton: { ru: "Пропускать", en: "Skip them" },
  seriesLastDayButton: { ru: "В последний день", en: "Last day of month" },
  seriesNoDates: {
    ru: "По этому правилу не выходит ни одной даты. Проверьте, до какого числа повторять.",
    en: "This rule gives no dates. Check the end date.",
  },
  createChoose: { ru: "Когда именно?", en: "When exactly?" },
  createButton: { ru: "Создать", en: "Create" },
  created: { ru: "✅ Создано", en: "✅ Created" },
  openInCalendar: { ru: "Открыть в календаре", en: "Open in Calendar" },
  askTitle: { ru: "Как назвать встречу? Ответьте на это сообщение.", en: "What should I call it? Reply to this message." },
  renamed: { ru: "Готово, назвал «{title}».", en: "Done, renamed to “{title}”." },
  askWhen: { ru: "Когда поставить? Например: «завтра в 15».", en: "When? For example: “tomorrow at 3pm”." },
  askTime: { ru: "Во сколько?", en: "What time?" },
  inPast: { ru: "Это время уже прошло. Когда поставить?", en: "That time has already passed. When should I schedule it?" },
  durationUnparseable: { ru: "Не понял длительность. Например: «на полчаса», «на два часа».", en: "I didn't get the duration. For example: “for 30 minutes”." },
  calendarReadOnly: { ru: "В календарь «{name}» нельзя записывать.", en: "The calendar “{name}” is read-only." },
  overlap: { ru: "⚠️ Пересекается: {list}", en: "⚠️ Overlaps: {list}" },
  defaultTitle: { ru: "Встреча", en: "Meeting" },
  allDayLower: { ru: "весь день", en: "all day" },
} as const satisfies Messages;
