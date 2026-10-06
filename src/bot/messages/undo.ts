// Тексты: отмена последнего действия (US-61).

import type { Messages } from "./types";

export const undoMessages = {
  undoButton: { ru: "↩ Отменить", en: "↩ Undo" },
  undone: { ru: "↩ Отменено", en: "↩ Undone" },
  undoOnlyLast: { ru: "Отменить можно только последнее действие.", en: "Only the last action can be undone." },
  undoChangedAfter: {
    ru: "Встречу уже изменили после этого — отменять не буду, чтобы не затереть правку.",
    en: "The event was changed after that — I won't undo so as not to overwrite the change.",
  },
  nothingToUndo: { ru: "Нечего отменять.", en: "Nothing to undo." },
  alreadyUndone: { ru: "Уже отменено.", en: "Already undone." },
  undoDeleteImpossible: {
    ru: "Удаление отменить нельзя — встречу пришлось бы создать заново.",
    en: "Deletion can't be undone — the event would have to be recreated.",
  },
  undoDeclineImpossible: {
    ru: "Отклонение приглашения отменить нельзя — примите приглашение в Google Календаре.",
    en: "Declining can't be undone here — accept the invitation in Google Calendar.",
  },
} as const satisfies Messages;
