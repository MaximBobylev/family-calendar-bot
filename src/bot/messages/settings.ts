// Тексты: /settings (US-04, US-06, US-07, US-42), утренняя сводка (US-70), подписи напоминаний.

import type { Messages } from "./types";

export const settingsMessages = {
  // --- Утренний дайджест (US-70) ---
  digestGreeting: { ru: "☀️ Доброе утро! Вот что сегодня:", en: "☀️ Good morning! Here is your day:" },
  settingsDigest: { ru: "☀️ Утренняя сводка: в {time}", en: "☀️ Morning summary: at {time}" },
  settingsDigestOff: { ru: "☀️ Утренняя сводка: выключена", en: "☀️ Morning summary: off" },
  settingsDigestButton: { ru: "☀️ Сводка", en: "☀️ Summary" },
  settingsChooseDigest: {
    ru: "☀️ <b>Утренняя сводка</b> — события на сегодня, каждый день в выбранное время ({tz}). Если встреч нет, так и напишу.",
    en: "☀️ <b>Morning summary</b> — today's events, every day at the chosen time ({tz}). If the day is free, I'll say so.",
  },
  settingsDigestDisable: { ru: "Выключить", en: "Turn off" },
  settingsOtherTime: { ru: "Другое время…", en: "Other time…" },
  settingsAskDigestTime: { ru: "Во сколько присылать сводку? Например: 7:45", en: "What time should I send it? E.g. 7:45" },
  settingsDigestSet: { ru: "Утренняя сводка — каждый день в {time}.", en: "Morning summary — every day at {time}." },
  settingsTimeUnknown: {
    ru: "Не понял время «{value}». Напишите, например, 7:45 — или выберите в /settings.",
    en: "I didn't get the time “{value}”. Type e.g. 7:45, or pick one in /settings.",
  },
  // --- /settings (US-04, US-06, US-07, US-42) ---
  settingsTitle: { ru: "⚙️ <b>Настройки</b>", en: "⚙️ <b>Settings</b>" },
  settingsCalendar: { ru: "🗓 Календарь по умолчанию: {value}", en: "🗓 Default calendar: {value}" },
  settingsTz: { ru: "🌍 Часовой пояс: {value} (сейчас {time})", en: "🌍 Time zone: {value} (now {time})" },
  settingsDuration: { ru: "⏱ Длительность встречи: {value}", en: "⏱ Event length: {value}" },
  settingsReminders: { ru: "🔔 Напоминания: {value}", en: "🔔 Reminders: {value}" },
  settingsAllDayReminders: { ru: "🔔 Для событий на весь день: {value}", en: "🔔 For all-day events: {value}" },
  settingsLanguage: { ru: "🗣 Язык: русский", en: "🗣 Language: English" },
  settingsHint: {
    ru: "Напоминания применяются к событиям, которые создаю я; настройки Google не меняются.",
    en: "Reminders apply to events I create; your Google settings stay as they are.",
  },
  settingsCalendarsButton: { ru: "🗓 Календари", en: "🗓 Calendars" },
  settingsTzButton: { ru: "🌍 Пояс", en: "🌍 Time zone" },
  settingsDurationButton: { ru: "⏱ Длительность", en: "⏱ Length" },
  settingsRemindersButton: { ru: "🔔 Напоминания", en: "🔔 Reminders" },
  settingsAllDayButton: { ru: "🔔 Весь день", en: "🔔 All-day" },
  settingsLanguageButton: { ru: "🗣 English", en: "🗣 Русский" },
  settingsBack: { ru: "← Назад", en: "← Back" },
  settingsSaved: { ru: "Сохранено", en: "Saved" },
  settingsNone: { ru: "нет", en: "none" },
  settingsChooseCalendar: {
    ru: "🗓 <b>Календари</b>\n\nВыберите календарь, чтобы сделать его основным или дать ему другие названия («общий», «семейный»).",
    en: "🗓 <b>Calendars</b>\n\nPick a calendar to make it the default or give it other names (“family”, “shared”).",
  },
  settingsCalendarPage: { ru: "🗓 <b>{name}</b>\n\nДругие названия: {aliases}", en: "🗓 <b>{name}</b>\n\nOther names: {aliases}" },
  settingsIsDefault: { ru: "Это календарь по умолчанию.", en: "This is the default calendar." },
  settingsMakeDefault: { ru: "Сделать основным", en: "Make default" },
  settingsAddAlias: { ru: "Добавить название", en: "Add a name" },
  settingsClearAliases: { ru: "Убрать названия", en: "Remove names" },
  settingsAskAlias: {
    ru: "Как ещё называть календарь «{name}»? Можно несколько через запятую: общий, семейный",
    en: "What else should I call “{name}”? Several are fine, comma-separated: family, shared",
  },
  settingsAliasesAdded: {
    ru: "Готово: «{name}» теперь также {aliases}. Скажите, например, «поставь в {first} ужин в субботу в 19».",
    en: "Done: “{name}” is now also {aliases}. Try “dinner in {first} on Saturday at 7pm”.",
  },
  settingsAliasEmpty: { ru: "Не понял название — попробуйте ещё раз из /settings.", en: "I didn't get the name — try again from /settings." },
  settingsChooseTz: {
    ru: "🌍 <b>Часовой пояс</b>\n\nСейчас: {value}. Выберите город или напишите пояс, например Europe/Berlin или UTC+4.",
    en: "🌍 <b>Time zone</b>\n\nNow: {value}. Pick a city or type a zone, e.g. Europe/Berlin or UTC+4.",
  },
  settingsOtherTz: { ru: "Другой…", en: "Other…" },
  settingsAskTz: { ru: "Напишите пояс: Europe/Berlin, Asia/Dubai или UTC+4.", en: "Type a time zone: Europe/Berlin, Asia/Dubai or UTC+4." },
  settingsTzSet: { ru: "Часовой пояс: {value}, сейчас {time}.", en: "Time zone: {value}, it's {time} now." },
  settingsTzUnknown: {
    ru: "Не узнал пояс «{value}». Напишите, например, Europe/Berlin или UTC+4 — или выберите город в /settings.",
    en: "I don't know the zone “{value}”. Type e.g. Europe/Berlin or UTC+4, or pick a city in /settings.",
  },
  settingsChooseDuration: { ru: "⏱ <b>Длительность новой встречи</b>, если не сказано иначе:", en: "⏱ <b>Length of a new event</b> unless you say otherwise:" },
  settingsChooseReminders: { ru: "🔔 <b>Напоминания</b> для встреч, которые создаю я:", en: "🔔 <b>Reminders</b> for events I create:" },
  settingsChooseAllDay: {
    ru: "🔔 <b>Напоминания для событий на весь день</b> (дни рождения, отпуск):",
    en: "🔔 <b>Reminders for all-day events</b> (birthdays, vacations):",
  },
  remindersGoogle: { ru: "как в Google", en: "as in Google" },
  remindersNone: { ru: "без напоминаний", en: "no reminders" },
  reminderBefore: { ru: "за {value}", en: "{value} before" },
  reminderDayBefore: { ru: "накануне в {time}", en: "the day before at {time}" },
  reminderDaysBefore: { ru: "за {days} дн. в {time}", en: "{days} days before at {time}" },
  settingsMemberHint: {
    ru: "Календари — общие календари дома. Свой Google Календарь можно подключить кнопкой ниже; удалить свои данные — /disconnect.",
    en: "Calendars are the household's shared calendars. You can connect your own Google Calendar below; delete your data — /disconnect.",
  },
  settingsConnectOwnButton: { ru: "🔗 Подключить свой Google", en: "🔗 Connect my Google" },
  settingsDisconnectHint: { ru: "Отключить календарь и удалить данные — /disconnect.", en: "Disconnect the calendar and delete your data: /disconnect." },
} as const satisfies Messages;
