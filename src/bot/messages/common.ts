// Тексты: общие — «пока не умею», лимиты (tech-debt #4), недоступность Google/LLM, кнопки и состояния карточек.

import type { Messages } from "./types";

export const commonMessages = {
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
  // --- Лимиты на пользователя (tech-debt #4) ---
  llmLimitHour: {
    ru: "Слишком много команд за последний час — лимит {limit}. Продолжим через {minutes} мин.",
    en: "Too many commands in the last hour — the limit is {limit}. Let's continue in {minutes} min.",
  },
  llmLimitDay: {
    ru: "Слишком много команд за сутки — лимит {limit}. Продолжим через {hours} ч.",
    en: "Too many commands in the last 24 hours — the limit is {limit}. Let's continue in {hours} h.",
  },
  sttLimitHour: {
    ru: "Слишком много голосовых за последний час — лимит {limit}. Напишите текстом или подождите {minutes} мин.",
    en: "Too many voice messages in the last hour — the limit is {limit}. Please type, or wait {minutes} min.",
  },
  sttLimitDay: {
    ru: "Слишком много голосовых за сутки — лимит {limit}. Напишите текстом или подождите {hours} ч.",
    en: "Too many voice messages in the last 24 hours — the limit is {limit}. Please type, or wait {hours} h.",
  },
  googleUnavailable: {
    ru: "Google Календарь не отвечает, попробуйте позже.",
    en: "Google Calendar isn't responding, please try again later.",
  },
  calendarForbidden: {
    ru: "Google Календарь не разрешил это действие — похоже, нет прав на этот календарь или встречу.",
    en: "Google Calendar didn't allow this — looks like you have no permission for this calendar or event.",
  },
  googleRevoked: {
    ru: "Доступ к Google Календарю отозван. Подключите его заново.",
    en: "Access to Google Calendar was revoked. Please connect it again.",
  },
  cancelButton: { ru: "Отмена", en: "Cancel" },
  cancelled: { ru: "Отменено.", en: "Cancelled." },
  alreadyDone: { ru: "Уже сделано.", en: "Already done." },
  cardExpired: { ru: "Карточка устарела — повторите команду.", en: "This card has expired — please repeat the command." },
  confirmButton: { ru: "Подтвердить", en: "Confirm" },
  internalError: { ru: "Что-то пошло не так. Попробуйте ещё раз.", en: "Something went wrong. Please try again." },
  actionFailed: { ru: "⚠️ Не получилось — ничего не изменено. Повторите команду.", en: "⚠️ That failed — nothing was changed. Please repeat the command." },
  notImplemented: {
    ru: "Это я пока не умею — в разработке.",
    en: "I can't do that yet — it's in development.",
  },
} as const satisfies Messages;
