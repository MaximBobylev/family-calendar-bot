// Несколько событий в одном сообщении (US-62): карточка-список, итог, отмена пачки, пересланное.

import type { Messages } from "./types";

export const multiMessages = {
  multiHeader: { ru: "Создать эти события?", en: "Create these events?" },
  multiFromForwardBy: { ru: "📝 Из пересланного сообщения от {name}", en: "📝 From a forwarded message by {name}" },
  multiFromForward: { ru: "📝 Из пересланного сообщения", en: "📝 From a forwarded message" },
  multiCreateAll: { ru: "Создать все ({n})", en: "Create all ({n})" },
  multiCreateSelected: { ru: "Создать выбранные ({n})", en: "Create selected ({n})" },
  multiSelectOne: { ru: "Отметьте хотя бы одно событие", en: "Select at least one event" },
  multiLineOff: { ru: "не создаю", en: "not creating" },
  multiLineSayApart: {
    ru: "не понял день или время — скажите его отдельным сообщением",
    en: "couldn't get the day or time — send it as a separate message",
  },
  multiEveryYear: { ru: "🔁 каждый год", en: "🔁 every year" },
  multiYearlyOn: { ru: "🔁 Каждый год: да", en: "🔁 Every year: yes" },
  multiYearlyOff: { ru: "🔁 Каждый год: нет", en: "🔁 Every year: no" },
  multiResponsible: { ru: "👤 Отводит: {name}", en: "👤 Takes: {name}" },
  multiCreatedPartial: { ru: "Создано {ok} из {n}", en: "Created {ok} of {n}" },
  multiFailedLine: { ru: "Google не ответил", en: "Google didn't respond" },
  multiNothingCreated: { ru: "Google не отвечает — ничего не создал", en: "Google isn't responding — nothing was created" },
  multiRetry: { ru: "🔁 Повторить ({n})", en: "🔁 Retry ({n})" },
  multiUndoAll: { ru: "↩ Отменить все ({n})", en: "↩ Undo all ({n})" },
  multiSkipped: { ru: "Не создавал: {list}", en: "Skipped: {list}" },
  multiSayApartLater: { ru: "❓ {title} — скажите его отдельным сообщением", en: "❓ {title} — send it as a separate message" },
  multiTooManyOwn: {
    ru: "В сообщении {n} событий — за раз добавляю до {max}. Продиктуйте частями.",
    en: "There are {n} events in the message — I add up to {max} at a time. Please send them in parts.",
  },
  multiTooManyForward: {
    ru: "Слишком много событий в одном сообщении ({n}) — добавьте их вручную или частями.",
    en: "Too many events in one message ({n}) — add them manually or in parts.",
  },
  multiOrdinalHint: {
    ru: "Чтобы поменять событие в списке, снимите галочку и скажите его отдельным сообщением.",
    en: "To change an event in the list, untick it and send it as a separate message.",
  },
  forwardLooksEvents: { ru: "📅 Похоже на события: «{text}». Создать?", en: "📅 Looks like events: “{text}”. Create them?" },
  forwardEventsButton: { ru: "📅 Создать события из этого", en: "📅 Create events from this" },
  undoneMany: { ru: "↩ Отменил: удалил {count}.", en: "↩ Undone: deleted {count}." },
  undoKeptChanged: { ru: "Не удалил «{title}» — его уже изменили.", en: "Didn't delete “{title}” — it was changed after." },
  eventsOne: { ru: "{n} событие", en: "{n} event" },
  eventsFew: { ru: "{n} события", en: "{n} events" },
  eventsMany: { ru: "{n} событий", en: "{n} events" },
} satisfies Messages;
