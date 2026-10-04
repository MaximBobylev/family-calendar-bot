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
  connectPrompt: {
    ru: "Чтобы начать, подключите Google Календарь — это займёт пару кликов.",
    en: "To get started, connect your Google Calendar — it takes a couple of clicks.",
  },
  connectButton: {
    ru: "Подключить Google Календарь",
    en: "Connect Google Calendar",
  },
  connected: {
    ru: "Календарь {email} подключён. Часовой пояс: {tz}.\n\nТеперь можно писать или говорить, что сделать.",
    en: "Calendar {email} is connected. Time zone: {tz}.\n\nNow just tell me what to do.",
  },
  accessDenied: {
    ru: "Доступ к календарю не выдан. Без него я ничего не смогу сделать — попробуйте ещё раз.",
    en: "Calendar access was not granted. I can't do anything without it — please try again.",
  },
  oauthDonePage: {
    ru: "Готово! Вернитесь в Telegram.",
    en: "Done! Go back to Telegram.",
  },
  oauthBadLinkPage: {
    ru: "Ссылка устарела или уже использована. Вернитесь в Telegram и нажмите «Подключить» ещё раз.",
    en: "This link has expired or was already used. Go back to Telegram and tap “Connect” again.",
  },
  oauthFailedPage: {
    ru: "Не получилось подключить календарь. Вернитесь в Telegram и попробуйте ещё раз.",
    en: "Couldn't connect the calendar. Go back to Telegram and try again.",
  },
  notImplemented: {
    ru: "Пока я умею только здороваться — остальное в разработке.",
    en: "For now I can only say hello — the rest is in development.",
  },
} as const satisfies Record<string, Record<Locale, string>>;

export type MessageKey = keyof typeof messages;

export function t(key: MessageKey, locale: string, params: Record<string, string> = {}): string {
  return messages[key][locale === "en" ? "en" : "ru"].replace(/\{(\w+)\}/g, (_, k: string) => params[k] ?? `{${k}}`);
}
