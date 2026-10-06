// Тексты: inline-карточка «📅 Добавить себе» (US-95) — результат inline-запроса, нажатие, гостевые ссылки.

import type { Messages } from "./types";

export const inlineMessages = {
  inlineAddButton: { ru: "📅 Добавить себе", en: "📅 Add to my calendar" },
  inlineToday: { ru: "сегодня", en: "today" },
  inlineTomorrow: { ru: "завтра", en: "tomorrow" },
  inlineAdded: { ru: "✅ Добавили себе: {n}", en: "✅ Added by {n}" },
  inlineCardSent: { ru: "Карточка — в личном чате с ботом", en: "The card is in your private chat with the bot" },
  inlineExpired: { ru: "Карточка устарела — попросите прислать новую", en: "This card has expired — ask for a new one" },
  inlineGuestIntro: { ru: "Добавить в свой календарь:", en: "Add to your calendar:" },
  inlineGoogleButton: { ru: "Google Календарь", en: "Google Calendar" },
  inlineIcsButton: { ru: "Скачать .ics", en: "Download .ics" },
  inlineIcsHint: {
    ru: "Файл .ics открывается Apple Календарём, Outlook и другими приложениями.",
    en: "The .ics file opens in Apple Calendar, Outlook and other apps.",
  },
  inlineGuestClosed: {
    ru: "Сам бот-помощник пока работает по приглашениям — напоминать в Telegram он будет, когда откроется доступ.",
    en: "The assistant bot itself is invite-only for now — Telegram reminders will be available once it opens up.",
  },
  inlineMemberNoGoogle: {
    ru: "Подключите свой Google Календарь (/connect) — и такие карточки будут добавляться одним нажатием.",
    en: "Connect your Google Calendar (/connect) — and such cards will be added in one tap.",
  },
} as const satisfies Messages;
