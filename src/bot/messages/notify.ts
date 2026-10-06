// Тексты: уведомления об изменениях в календаре (US-72), напоминания в Telegram (US-71), их настройки в /settings.

import type { Messages } from "./types";

export const notifyMessages = {
  // --- Уведомления об изменениях (US-72) ---
  noticeCreated: { ru: "➕ Новое: «{title}» — {when}", en: "➕ New: “{title}” — {when}" },
  noticeMoved: { ru: "🔁 Перенесено: «{title}» — {when} (было {was})", en: "🔁 Moved: “{title}” — {when} (was {was})" },
  noticeMovedNoWas: { ru: "🔁 Перенесено: «{title}» — {when}", en: "🔁 Moved: “{title}” — {when}" },
  noticeCancelled: { ru: "❌ Отменено: «{title}» — {when}", en: "❌ Cancelled: “{title}” — {when}" },
  noticeAuthor: { ru: "👤 {name}", en: "👤 {name}" },
  noticeOrganizer: { ru: "👤 Организатор: {name}", en: "👤 Organizer: {name}" },
  noticeSummary: { ru: "📋 Изменения в календаре ({count}):", en: "📋 Calendar changes ({count}):" },
  noticeSummaryMore: { ru: "…и ещё {count}", en: "…and {count} more" },
  // --- Напоминание в Telegram (US-71) ---
  tgReminder: { ru: "⏰ Через {minutes} мин: <b>{title}</b>\n🕒 {when}", en: "⏰ In {minutes} min: <b>{title}</b>\n🕒 {when}" },
  tgReminderPlace: { ru: "📍 {place}", en: "📍 {place}" },
  tgReminderLink: { ru: "🔗 {url}", en: "🔗 {url}" },
  // --- /settings → «Уведомления» ---
  settingsNotifyButton: { ru: "📣 Уведомления", en: "📣 Notifications" },
  settingsNotifyOn: { ru: "📣 Об изменениях в календаре: включены", en: "📣 Calendar change alerts: on" },
  settingsNotifyOff: { ru: "📣 Об изменениях в календаре: выключены", en: "📣 Calendar change alerts: off" },
  settingsTgReminderOn: { ru: "⏰ Напоминать в Telegram: за {minutes} мин", en: "⏰ Telegram reminders: {minutes} min before" },
  settingsTgReminderOff: { ru: "⏰ Напоминать в Telegram: нет", en: "⏰ Telegram reminders: off" },
  settingsChooseNotify: {
    ru: "📣 <b>Уведомления</b>\n\n<b>Об изменениях</b>: напишу, если событие в общем календаре добавили, перенесли или отменили — в другом чате или прямо в Google. С 23:00 до 08:00 — молчу, присылаю утром.\n\n<b>Напоминания в Telegram</b> — за N минут до встреч со временем (кроме событий на весь день и отклонённых), независимо от напоминаний Google.",
    en: "📣 <b>Notifications</b>\n\n<b>Change alerts</b>: I'll tell you when an event in a shared calendar is added, moved or cancelled — from another chat or right in Google. Quiet from 23:00 to 08:00 — you get them in the morning.\n\n<b>Telegram reminders</b> — N minutes before timed events (not all-day or declined ones), independent of Google reminders.",
  },
  settingsNotifyToggleOn: { ru: "✓ Об изменениях: вкл", en: "✓ Change alerts: on" },
  settingsNotifyToggleOff: { ru: "Об изменениях: выкл", en: "Change alerts: off" },
  settingsTgReminderNone: { ru: "Не напоминать", en: "No reminders" },
  settingsTgReminderMin: { ru: "за {minutes} мин", en: "{minutes} min" },
} satisfies Messages;
