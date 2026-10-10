// Голосовые (распознавание, переслушивание) и пересланные сообщения.

import type { Messages } from "./types";

export const inputMessages = {
  heard: { ru: "🎙 <i>{text}</i>", en: "🎙 <i>{text}</i>" },
  voiceTooLong: {
    ru: "Голосовое длиннее минуты — запишите покороче, пожалуйста.",
    en: "The voice message is longer than a minute — please record a shorter one.",
  },
  notHeard: { ru: "Не расслышал, повторите, пожалуйста.", en: "I didn't catch that, please repeat." },
  reheard: { ru: "🎙 Переслушал: <i>{text}</i>", en: "🎙 Listened again: <i>{text}</i>" },
  reheardFailed: {
    ru: "Не получилось переслушать — скажите иначе или напишите текстом.",
    en: "I couldn't listen again — please rephrase or type it.",
  },
  reheardAlready: {
    ru: "Я уже переслушал это сообщение — скажите иначе или напишите текстом.",
    en: "I've already listened to that one again — please rephrase or type it.",
  },
  sttUnavailable: {
    ru: "Не могу распознать голос сейчас — напишите, пожалуйста, текстом.",
    en: "I can't recognize voice right now — please type it.",
  },
  voiceDownloadFailed: { ru: "Не смог получить голосовое, пришлите ещё раз.", en: "I couldn't get the voice message, please send it again." },
  forwardedConfirm: {
    ru: "Это пересланное сообщение: «{text}». Выполнить как команду?",
    en: "This is a forwarded message: “{text}”. Run it as a command?",
  },
  forwardRunButton: { ru: "Выполнить", en: "Run" },
  forwardSkipButton: { ru: "Не выполнять", en: "Don't run" },
  forwardRunning: { ru: "▶️ Выполняю: «{text}»", en: "▶️ Running: “{text}”" },
  forwardSkipped: { ru: "Не выполняю.", en: "Not running it." },
} as const satisfies Messages;
