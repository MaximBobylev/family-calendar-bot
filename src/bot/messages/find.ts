// Поиск события для изменения и удаления: не нашёл, уточните, выберите.

import type { Messages } from "./types";

export const findMessages = {
  eventNotFound: { ru: "Не нашёл встречу «{query}». Уточните день или название.", en: "I couldn't find “{query}”. Please specify the day or the name." },
  eventNotFoundGeneric: { ru: "Не понял, какую встречу изменить — назовите её или время.", en: "Which event? Please name it or its time." },
  tooManyCandidates: { ru: "Подходящих встреч {n} — уточните день или время.", en: "There are {n} matching events — please specify the day or time." },
  foundOtherDay: {
    ru: "В этот день «{query}» нет. Нашёл в другие дни — эту?",
    en: "There's no “{query}” on that day. Found it on other days — this one?",
  },
  notFoundSuggest: { ru: "Не нашёл «{query}». Может, одна из этих?", en: "I couldn't find “{query}”. Maybe one of these?" },
  whichEvent: { ru: "Какую встречу?", en: "Which event?" },
  picked: { ru: "Выбрано", en: "Selected" },
  eventGone: { ru: "Эта встреча уже удалена.", en: "This event has already been deleted." },
  notOrganizer: {
    ru: "Вы не организатор встречи «<b>{title}</b>» — перенести или переименовать её может только организатор.",
    en: "You're not the organizer of “<b>{title}</b>” — only the organizer can move or rename it.",
  },
} as const satisfies Messages;
