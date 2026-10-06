// Тексты: приветствие, доступ, подключение Google и страницы OAuth, /disconnect (US-01, US-02, US-03).

import type { Messages } from "./types";

export const accountMessages = {
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
  reconnectPrompt: {
    ru: "Сейчас подключён {email}. Переподключить тот же аккаунт можно в любой момент — настройки, названия календарей и календарь по умолчанию сохранятся. Другой аккаунт заменит текущий.",
    en: "Connected: {email}. You can reconnect the same account any time — settings, calendar names and the default calendar are kept. Another account replaces the current one.",
  },
  settingsGoogleButton: { ru: "🔗 Google", en: "🔗 Google" },
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
  oauthConfirmPage: {
    ru: "Вы подключаете Google Календарь к Telegram-аккаунту {name}.",
    en: "You are connecting Google Calendar to the Telegram account {name}.",
  },
  oauthConfirmNoName: {
    ru: "Вы подключаете Google Календарь к Telegram-аккаунту, который получил эту ссылку от бота.",
    en: "You are connecting Google Calendar to the Telegram account that received this link from the bot.",
  },
  oauthConfirmWarning: {
    ru: "Если это не вы — закройте страницу: эту ссылку вам переслали, и календарь получил бы чужой человек.",
    en: "If this isn't you, close this page: the link was forwarded to you, and someone else would get your calendar.",
  },
  oauthConfirmButton: { ru: "Продолжить", en: "Continue" },
  oauthBindFailedPage: {
    ru: "Не удалось подтвердить, что вход начат в этом браузере. Начните заново из бота: нажмите «Подключить».",
    en: "Couldn't confirm that sign-in was started in this browser. Start over from the bot: tap “Connect”.",
  },
  oauthFailedPage: {
    ru: "Не получилось подключить календарь. Вернитесь в Telegram и попробуйте ещё раз.",
    en: "Couldn't connect the calendar. Go back to Telegram and try again.",
  },
  // --- /disconnect (US-03) ---
  disconnectConfirm: {
    ru: "Отключить Google Календарь и удалить все ваши данные?\n\nЯ отзову доступ к календарю и удалю настройки, названия календарей, черновики и журнал команд. События в самом Google Календаре останутся как есть.",
    en: "Disconnect Google Calendar and delete all your data?\n\nI'll revoke calendar access and delete your settings, calendar names, drafts and command log. Events in Google Calendar itself stay as they are.",
  },
  disconnectDissolves: {
    ru: "Дом «{name}» будет распущен: участники ({members}) потеряют доступ к общему календарю и поручениям.",
    en: "The household “{name}” will be dissolved: members ({members}) lose access to the shared calendar and tasks.",
  },
  disconnectButton: { ru: "Отключить и удалить", en: "Disconnect and delete" },
  disconnectDone: {
    ru: "✅ Готово: доступ к Google Календарю отозван, все ваши данные удалены.\n\nЧтобы начать заново — /start.",
    en: "✅ Done: Google Calendar access is revoked and all your data is deleted.\n\nTo start over, send /start.",
  },
  disconnectDoneNoAccount: {
    ru: "✅ Готово: все ваши данные удалены.\n\nЧтобы начать заново — /start.",
    en: "✅ Done: all your data is deleted.\n\nTo start over, send /start.",
  },
  disconnectRevokeFailed: {
    ru: "Ваши данные удалены, но отозвать доступ в Google не получилось. Уберите его вручную: https://myaccount.google.com/permissions\n\nЧтобы начать заново — /start.",
    en: "Your data is deleted, but I couldn't revoke access in Google. Please remove it manually: https://myaccount.google.com/permissions\n\nTo start over, send /start.",
  },
  disconnectRevokeShared: {
    ru: "✅ Ваши данные удалены. Доступ в Google не отзывал: этот Google-аккаунт подключён и у другого пользователя бота — отзыв отключил бы и его. Убрать доступ совсем: https://myaccount.google.com/permissions\n\nЧтобы начать заново — /start.",
    en: "✅ Your data is deleted. I didn't revoke Google access: this Google account is also connected by another bot user, and revoking would disconnect them too. To remove access completely: https://myaccount.google.com/permissions\n\nTo start over, send /start.",
  },
} as const satisfies Messages;
