// Изменение события: карточка «Было → Стало», серии, детали.

import type { Messages } from "./types";

export const modifyMessages = {
  modify_nothingToChange: {
    ru: "Что изменить? Например: «на час позже», «на пятницу», «переименуй в …».",
    en: "What should I change? For example: “one hour later”, “to Friday”.",
  },
  modify_notUnderstood: {
    ru: "Не понял, на когда перенести. Например: «на пятницу», «на 11», «на час позже».",
    en: "I didn't get the new time. For example: “to Friday”, “to 11”, “one hour later”.",
  },
  modify_inPast: { ru: "Это время уже прошло — выберите другое.", en: "That time has already passed — please pick another." },
  modify_allDayTime: { ru: "Встречу на весь день пока можно только переименовать.", en: "All-day events can only be renamed for now." },
  seriesMoveUnsupported: {
    ru: "Всю серию на другой день пока перенести не могу — только одну встречу из неё.",
    en: "I can't move the whole series to another day yet — only a single occurrence.",
  },
  modifyMoveConfirm: { ru: "Перенести?", en: "Move this event?" },
  modifyConfirm: { ru: "Изменить?", en: "Change this event?" },
  was: { ru: "Было", en: "Was" },
  now: { ru: "Стало", en: "Now" },
  newTitle: { ru: "Название", en: "Title" },
  onlyThisOccurrence: { ru: "↻ Изменится только эта встреча из серии.", en: "↻ Only this occurrence will change." },
  attendeesNotified: { ru: "👥 Участники получат уведомление.", en: "👥 Attendees will be notified." },
  onlyThis: { ru: "Только эту", en: "Only this" },
  wholeSeries: { ru: "Всю серию", en: "Whole series" },
  eventChangedMeanwhile: { ru: "Встречу уже изменили — проверьте и повторите команду.", en: "The event was changed meanwhile — please check and try again." },
  modified: { ru: "✅ Изменено", en: "✅ Updated" },
  wholeSeriesChanged: { ru: "↻ Изменена вся серия.", en: "↻ The whole series was updated." },
  placeLabel: { ru: "Место", en: "Place" },
  descriptionLabel: { ru: "Описание", en: "Description" },
  remindersLabel: { ru: "Напоминания", en: "Reminders" },
  remindersCalendarDefault: { ru: "как в календаре", en: "calendar default" },
  reminderByEmail: { ru: "(на почту)", en: "(email)" },
  remindersTooMany: {
    ru: "Google позволяет не больше 5 напоминаний у события — назовите поменьше.",
    en: "Google allows at most 5 reminders per event — please name fewer.",
  },
  remindersTooFar: {
    ru: "Google не ставит напоминания раньше чем за 4 недели до события — назовите срок поменьше.",
    en: "Google doesn't allow reminders more than 4 weeks before an event — please pick a shorter time.",
  },
  moveToCalendarUnsupported: {
    ru: "Переносить событие в другой календарь пока не умею.",
    en: "I can't move events to another calendar yet.",
  },
} as const satisfies Messages;
