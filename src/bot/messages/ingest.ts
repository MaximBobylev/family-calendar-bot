// Тексты: событие из чужого контента — пересланное (US-65), фото/скриншот (US-66), файл .ics (US-67);
// сводки «Завтра» и «Неделя» (US-70, R1).

import type { Messages } from "./types";

export const ingestMessages = {
  // --- Пересланное → событие (US-65) ---
  forwardEventButton: { ru: "📅 Создать событие из этого", en: "📅 Create an event from this" },
  forwardEventStarted: { ru: "📅 Создаю событие из пересланного…", en: "📅 Creating an event from the forwarded message…" },
  forwardedLooksEvent: {
    ru: "📅 Похоже на событие: «{text}». Создать?",
    en: "📅 Looks like an event: “{text}”. Create it?",
  },
  forwardRunAsCommandButton: { ru: "Выполнить как команду", en: "Run as a command" },
  forwardNoButton: { ru: "Не надо", en: "No, thanks" },
  ingestFromForwardBy: { ru: "Из пересланного сообщения от {name}", en: "From a forwarded message by {name}" },
  ingestFromForward: { ru: "Из пересланного сообщения", en: "From a forwarded message" },
  ingestFromImage: { ru: "Из изображения", en: "From an image" },
  ingestLink: { ru: "Ссылка: {url}", en: "Link: {url}" },
  ingestAskWhen: {
    ru: "Не нашёл в сообщении даты и времени. Когда поставить «{title}»? Например: «завтра в 15».",
    en: "I didn't find a date or time in it. When should I schedule “{title}”? For example: “tomorrow at 3pm”.",
  },
  // --- Фото / скриншот (US-66) ---
  imageTooBig: { ru: "Картинка слишком большая — пришлите поменьше (до 5 МБ).", en: "The image is too large — please send a smaller one (up to 5 MB)." },
  imageUnavailable: {
    ru: "Сейчас не могу читать картинки — перешлите текст сообщения или напишите событие словами.",
    en: "I can't read images right now — please forward the text or describe the event in words.",
  },
  imageFailed: {
    ru: "Не получилось прочитать изображение — попробуйте ещё раз или пришлите текстом.",
    en: "I couldn't read the image — please try again or send it as text.",
  },
  imageNoEvent: {
    ru: "Не нашёл на изображении ничего похожего на событие с датой.",
    en: "I didn't find anything that looks like an event with a date in the image.",
  },
  imageWrongFormat: { ru: "Читаю картинки JPEG, PNG и WebP.", en: "I can read JPEG, PNG and WebP images." },
  // --- Файл .ics (US-67) ---
  icsConfirmOne: { ru: "Добавить в календарь?", en: "Add to your calendar?" },
  icsConfirmMany: { ru: "Добавить в календарь событий: {n}?", en: "Add {n} events to your calendar?" },
  icsAddButton: { ru: "Добавить", en: "Add" },
  icsAddAllButton: { ru: "Добавить все ({n})", en: "Add all ({n})" },
  icsAdded: { ru: "✅ Добавлено", en: "✅ Added" },
  icsAddedMany: { ru: "✅ Добавлено событий: {n}", en: "✅ Events added: {n}" },
  icsRepeats: { ru: "🔁 повторяется (правило из файла)", en: "🔁 repeats (rule from the file)" },
  icsUnknownTz: {
    ru: "⚠️ Часовой пояс «{tz}» не распознан — время показано как в файле, в вашем поясе.",
    en: "⚠️ Unknown time zone “{tz}” — the time is shown as in the file, in your time zone.",
  },
  icsMalformed: {
    ru: "Не смог прочитать файл .ics — похоже, он повреждён или это не приглашение в календарь.",
    en: "I couldn't read the .ics file — it seems damaged or isn't a calendar invitation.",
  },
  icsNoEvents: { ru: "В файле нет событий, которые можно добавить.", en: "There are no events in the file I could add." },
  icsTooMany: {
    ru: "В файле событий: {n} — это слишком много, добавляю не больше {max} за раз.",
    en: "The file has {n} events — too many, I add at most {max} at a time.",
  },
  icsTooBig: { ru: "Файл слишком большой для приглашения (больше 256 КБ).", en: "The file is too large for an invitation (over 256 KB)." },
  icsDownloadFailed: { ru: "Не смог получить файл, пришлите ещё раз.", en: "I couldn't get the file, please send it again." },
  // --- Сводки «Завтра» и «Неделя» (US-70, R1) ---
  digestTomorrowGreeting: { ru: "🌙 Что завтра:", en: "🌙 Here is tomorrow:" },
  digestTomorrowEmpty: { ru: "🌙 Завтра встреч нет.", en: "🌙 No events tomorrow." },
  digestWeekGreeting: { ru: "🗓 Ваша неделя:", en: "🗓 Your week:" },
  digestWeekEmpty: { ru: "🗓 На неделе встреч нет.", en: "🗓 No events this week." },
  settingsTomorrowDigest: { ru: "🌙 Сводка на завтра: в 21:00", en: "🌙 Tomorrow summary: at 21:00" },
  settingsTomorrowDigestOff: { ru: "🌙 Сводка на завтра: выключена", en: "🌙 Tomorrow summary: off" },
  settingsWeekDigestSun: { ru: "🗓 Сводка на неделю: вс в 20:00", en: "🗓 Week summary: Sun at 20:00" },
  settingsWeekDigestMon: { ru: "🗓 Сводка на неделю: пн в 08:00", en: "🗓 Week summary: Mon at 08:00" },
  settingsWeekDigestOff: { ru: "🗓 Сводка на неделю: выключена", en: "🗓 Week summary: off" },
  settingsTomorrowButton: { ru: "🌙 Завтра в 21:00", en: "🌙 Tomorrow at 21:00" },
  settingsWeekOffButton: { ru: "🗓 Неделя: нет", en: "🗓 Week: off" },
  settingsWeekSunButton: { ru: "вс 20:00", en: "Sun 20:00" },
  settingsWeekMonButton: { ru: "пн 08:00", en: "Mon 08:00" },
  settingsDigestMore: {
    ru: "🌙 <b>Завтра</b> — вечером события на следующий день. 🗓 <b>Неделя</b> — в воскресенье вечером на предстоящую неделю или в понедельник утром на текущую.",
    en: "🌙 <b>Tomorrow</b> — next day's events in the evening. 🗓 <b>Week</b> — on Sunday evening for the coming week or on Monday morning for this week.",
  },
} as const satisfies Messages;
