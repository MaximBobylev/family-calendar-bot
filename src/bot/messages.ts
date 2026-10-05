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
  today: { ru: "Сегодня", en: "Today" },
  tomorrow: { ru: "Завтра", en: "Tomorrow" },
  allDay: { ru: "Весь день", en: "All day" },
  until: { ru: "до", en: "until" },
  nextDayShort: { ru: "след. день", en: "next day" },
  free: { ru: "свободно", en: "free" },
  noEvents: { ru: "Встреч нет 🎉", en: "No events 🎉" },
  unsupported: {
    ru: "Я умею только работать с календарём. Например: «Что у меня завтра?»",
    en: "I can only work with your calendar. For example: “What's on tomorrow?”",
  },
  oneAtATime: {
    ru: "Давайте по одной команде за раз.",
    en: "Let's do one command at a time.",
  },
  llmUnavailable: {
    ru: "Не могу разобрать команду сейчас, попробуйте чуть позже.",
    en: "I can't process commands right now, please try again a bit later.",
  },
  googleUnavailable: {
    ru: "Google Календарь не отвечает, попробуйте позже.",
    en: "Google Calendar isn't responding, please try again later.",
  },
  googleRevoked: {
    ru: "Доступ к Google Календарю отозван. Подключите его заново.",
    en: "Access to Google Calendar was revoked. Please connect it again.",
  },
  rangeUnparseable: {
    ru: "Не понял, за какой период показать. Например: «завтра», «на этой неделе», «в пятницу».",
    en: "I didn't get the period. For example: “tomorrow”, “this week”, “on Friday”.",
  },
  rangeAmbiguous: {
    ru: "Уточните, какой период: {options}?",
    en: "Which period do you mean: {options}?",
  },
  or: { ru: "или", en: "or" },
  calendarNotFound: {
    ru: "Не нашёл календарь «{name}». Ваши календари: {list}.",
    en: "I couldn't find the calendar “{name}”. Your calendars: {list}.",
  },
  createConfirm: { ru: "Создать событие?", en: "Create this event?" },
  createChoose: { ru: "Когда именно?", en: "When exactly?" },
  createButton: { ru: "Создать", en: "Create" },
  cancelButton: { ru: "Отмена", en: "Cancel" },
  cancelled: { ru: "Отменено.", en: "Cancelled." },
  created: { ru: "✅ Создано", en: "✅ Created" },
  openInCalendar: { ru: "Открыть в календаре", en: "Open in Calendar" },
  askTitle: { ru: "Как назвать встречу? Ответьте на это сообщение.", en: "What should I call it? Reply to this message." },
  renamed: { ru: "Готово, назвал «{title}».", en: "Done, renamed to “{title}”." },
  askWhen: { ru: "Когда поставить? Например: «завтра в 15».", en: "When? For example: “tomorrow at 3pm”." },
  askTime: { ru: "Во сколько?", en: "What time?" },
  inPast: { ru: "Это время уже прошло. Когда поставить?", en: "That time has already passed. When should I schedule it?" },
  durationUnparseable: { ru: "Не понял длительность. Например: «на полчаса», «на два часа».", en: "I didn't get the duration. For example: “for 30 minutes”." },
  calendarReadOnly: { ru: "В календарь «{name}» нельзя записывать.", en: "The calendar “{name}” is read-only." },
  overlap: { ru: "⚠️ Пересекается: {list}", en: "⚠️ Overlaps: {list}" },
  alreadyDone: { ru: "Уже сделано.", en: "Already done." },
  cardExpired: { ru: "Карточка устарела — повторите команду.", en: "This card has expired — please repeat the command." },
  defaultTitle: { ru: "Встреча", en: "Meeting" },
  allDayLower: { ru: "весь день", en: "all day" },
  heard: { ru: "🎙 <i>{text}</i>", en: "🎙 <i>{text}</i>" },
  voiceTooLong: {
    ru: "Голосовое длиннее минуты — запишите покороче, пожалуйста.",
    en: "The voice message is longer than a minute — please record a shorter one.",
  },
  notHeard: { ru: "Не расслышал, повторите, пожалуйста.", en: "I didn't catch that, please repeat." },
  sttUnavailable: {
    ru: "Не могу распознать голос сейчас — напишите, пожалуйста, текстом.",
    en: "I can't recognize voice right now — please type it.",
  },
  voiceDownloadFailed: { ru: "Не смог получить голосовое, пришлите ещё раз.", en: "I couldn't get the voice message, please send it again." },
  notImplemented: {
    ru: "Это я пока не умею — в разработке.",
    en: "I can't do that yet — it's in development.",
  },
} as const satisfies Record<string, Record<Locale, string>>;

export type MessageKey = keyof typeof messages;

export function t(key: MessageKey, locale: string, params: Record<string, string> = {}): string {
  return messages[key][locale === "en" ? "en" : "ru"].replace(/\{(\w+)\}/g, (_, k: string) => params[k] ?? `{${k}}`);
}
