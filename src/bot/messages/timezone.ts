// Тексты: часовой пояс и поездки (US-07, R2).

import type { Messages } from "./types";

export const timezoneMessages = {
  tzWhere: { ru: "🌍 Часовой пояс: {tz} (сейчас {time}).", en: "🌍 Time zone: {tz} (now {time})." },
  tzWhereTrip: {
    ru: "🧳 Сейчас поездка: {tz} (там {time}){until}. Дом — {home}.",
    en: "🧳 You're on a trip: {tz} (now {time} there){until}. Home — {home}.",
  },
  tzUntilPart: { ru: " до {day}", en: " until {day}" },
  tzAskMode: {
    ru: "Пояс {tz}, там сейчас {time}. Это поездка или переезд?",
    en: "Time zone {tz}, it's {time} there now. Is this a trip or a move?",
  },
  tzTripButton: { ru: "🧳 На время поездки", en: "🧳 For the trip" },
  tzMoveButton: { ru: "🏠 Навсегда", en: "🏠 Permanently" },
  tzTripSet: {
    ru: "🧳 Включил пояс поездки {tz} (сейчас {time}): даты, сводки и напоминания — по нему. Дом — {home}; вернуть — «я вернулся».",
    en: "🧳 Trip time zone {tz} is on (now {time}): dates, summaries and reminders follow it. Home — {home}; say “I'm back” to return.",
  },
  tzTripUntilNote: { ru: "{day} спрошу, вернулись ли вы.", en: "On {day} I'll ask whether you're back." },
  tzAskUntil: {
    ru: "До какого числа поездка? Напишите дату — например, «до воскресенья».",
    en: "Until when is the trip? Send a date — e.g. “until Sunday”.",
  },
  tzUntilUnknownButton: { ru: "Не знаю", en: "Not sure" },
  tzUntilUnknown: { ru: "Хорошо, через неделю спрошу, вернулись ли вы.", en: "OK, I'll ask in a week whether you're back." },
  tzUntilSet: {
    ru: "Запомнил: поездка до {day}. В этот день спрошу, вернулись ли вы.",
    en: "Got it: trip until {day}. I'll ask that day whether you're back.",
  },
  tzMoved: { ru: "🏠 Домашний пояс теперь {tz} (сейчас {time}).", en: "🏠 Your home time zone is now {tz} (now {time})." },
  tzReturned: { ru: "🏠 С возвращением! Вернул {home} (сейчас {time}).", en: "🏠 Welcome back! Switched back to {home} (now {time})." },
  tzAlreadyHome: { ru: "Вы и так дома: {home} (сейчас {time}).", en: "You're already home: {home} (now {time})." },
  tzReturnAsk: {
    ru: "Вернулись из поездки? Сейчас пояс {tz}, дом — {home}.",
    en: "Back from the trip? Current time zone is {tz}, home — {home}.",
  },
  tzBackButton: { ru: "Вернулись — вернуть {home}", en: "Back — switch to {home}" },
  tzNotYetButton: { ru: "Ещё нет", en: "Not yet" },
  tzKeepButton: { ru: "Оставить {tz} навсегда", en: "Keep {tz} for good" },
  tzNotYet: { ru: "Хорошо, спрошу ещё через неделю.", en: "OK, I'll ask again in a week." },
  tzDigestTrip: { ru: "🧳 Поездка: {tz} (дом — {home})", en: "🧳 Trip: {tz} (home — {home})" },
  settingsTzTrip: {
    ru: "🧳 Поездка: {tz} (сейчас {time}){until}; дом — {home}",
    en: "🧳 Trip: {tz} (now {time}){until}; home — {home}",
  },
} as const satisfies Messages;
