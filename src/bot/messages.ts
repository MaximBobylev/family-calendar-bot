// Тексты бота. Пока простой словарь RU/EN; позже — каталог i18n с ICU plural (ADR-0003).

export type Locale = "ru" | "en";

const messages = {
  welcome: {
    ru: "Привет! Я помогу вести Google Календарь прямо из Telegram — голосом или текстом.\n\nНапример:\n• «Поставь встречу в среду в 12»\n• «Что у меня завтра?»\n• «Перенеси созвон на час позже»",
    en: "Hi! I'll help you manage Google Calendar right from Telegram — by voice or text.\n\nFor example:\n• “Schedule a meeting on Wednesday at 12”\n• “What's on tomorrow?”\n• “Move the call one hour later”",
  },
  notAllowed: {
    ru: "Извините, бот пока работает в закрытом режиме.",
    en: "Sorry, the bot is in private mode for now.",
  },
  privateOnly: {
    ru: "Напишите мне в личные сообщения.",
    en: "Please message me directly.",
  },
  notImplemented: {
    ru: "Пока я умею только здороваться — остальное в разработке.",
    en: "For now I can only say hello — the rest is in development.",
  },
} as const satisfies Record<string, Record<Locale, string>>;

export type MessageKey = keyof typeof messages;

export function t(key: MessageKey, locale: string): string {
  return messages[key][locale === "en" ? "en" : "ru"];
}
