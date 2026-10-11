// Фразы о настройках — без LLM, до шага NLU, как пояс (timezone-command.ts). Команда узнаётся, только если кроме
// значения во фразе одни служебные слова: «поставь встречу на 30 минут» — создание, а не длительность. Кейсы — testdata/nlu/settings.yaml.

import { normalizeWords } from "../calendar/match";
import { parseDateFragment } from "../dates";
import { parseHhmm } from "../dates/daily";
import { durationToMinutes } from "../dates/duration";
import { detailHints } from "./detail-hints";

export type DigestKind = "today" | "tomorrow" | "week";

export type SettingsCommand =
  | { kind: "duration"; minutes: number }
  /** null — как в Google, [] — без напоминаний. */
  | { kind: "reminders"; minutes: number[] | null }
  /** 0 — не напоминать. */
  | { kind: "tg_reminder"; minutes: number }
  /** Без кавычек граница «календарь | название» неизвестна — text делит бот по списку календарей. */
  | { kind: "alias"; calendar: string; alias: string }
  | { kind: "alias"; text: string }
  | { kind: "default_calendar"; name: string }
  | { kind: "digest"; digest: DigestKind; on: boolean; time?: string; day?: "sun" | "mon" }
  | { kind: "language"; locale: "ru" | "en" }
  | { kind: "change_notify"; on: boolean };

const L = String.raw`\p{L}`;
const re = (src: string) => new RegExp(src, "iu");
const word = (src: string) => `(?<!${L})(?:${src})(?!${L})`;

const FILLER = new Set(
  (
    "мне нам пожалуйста плиз теперь всегда обычно все всё по умолчанию стандартно для у меня мои мой моих в на о об " +
    "please now always by default for my all the a to me"
  ).split(" "),
);

function onlyFiller(text: string, cut: RegExp[], extra: string[] = []): boolean {
  let rest = text;
  for (const r of cut) rest = rest.replace(new RegExp(r.source, "giu"), " ");
  const allowed = new Set([...FILLER, ...extra]);
  return normalizeWords(rest).every((w) => allowed.has(w));
}

const DEFAULT = re(word(String.raw`по\s+умолчанию|by\s+default|default`));
const DURATION_WORD = re(word(`длительност${L}*|продолжительност${L}*|duration|length`));
const REMINDER_WORD = re(word(`напомина${L}*|напомни${L}*|remind${L}*`));
const TG = re(word(String.raw`(?:в\s+)?(?:телеграм${L}*|телег${L}|telegram)|(?:in\s+)?telegram|сообщением|в\s+чат`));
const GOOGLE_DEFAULT = re(word(String.raw`как\s+в\s+(?:гугл${L}*|google)|as\s+in\s+google|google\s+defaults?`));
const NOT_REMIND = re(word(String.raw`не\s+напоминай|не\s+надо\s+напоминать|не\s+напоминать|don'?t\s+remind|stop\s+reminding`));

const OFF = re(
  word(
    String.raw`не\s+(?:присылай|присылать|отправляй|шли|надо|нужн${L}*)|выключи${L}*|отключи${L}*|убери|отмени|хватит|stop|turn\s+off|switch\s+off|disable|no\s+more|don'?t\s+send`,
  ),
);
const ON = re(word(String.raw`присылай|присылать|отправляй|шли|включи${L}*|верни|хочу|send|turn\s+on|switch\s+on|enable`));

const DURATION_FILLER = (
  "ставь ставить поставь делай делать сделай создавай создавать пусть будут длятся длится встречи встреч события событий " +
  "длительность продолжительность на по make set meetings events last should be duration length"
).split(" ");

function findDuration(s: string): { minutes: number; span: string } | null {
  const words = s.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    for (let n = Math.min(4, words.length - i); n >= 1; n--) {
      const span = words.slice(i, i + n).join(" ");
      const r = parseDateFragment({ text: span.replace(/^(?:на|по|for)\s+/i, ""), kind: "duration", now: "2026-01-01T00:00", tz: "UTC" });
      if (!("duration" in r) || r.duration === "all_day") continue;
      const minutes = durationToMinutes(r.duration);
      if (minutes !== null) return { minutes, span };
    }
  }
  return null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function parseDuration(s: string): SettingsCommand | null {
  if (!DEFAULT.test(s) && !DURATION_WORD.test(s)) return null;
  const d = findDuration(s);
  if (!d || d.minutes < 5 || d.minutes > 12 * 60) return null;
  if (!onlyFiller(s, [new RegExp(escapeRe(d.span)), DEFAULT], DURATION_FILLER)) return null;
  return { kind: "duration", minutes: d.minutes };
}

const REMINDER_FILLER = (
  "напоминай напоминать напомни напоминания напоминание напоминаний ставь ставить делай всех встречах встреч событиях событий " +
  "уведомления set remind reminders reminder events meetings"
).split(" ");

function reminderMinutes(s: string): number[] | null | undefined {
  const h = detailHints(s);
  if (!h.reminders || "error" in h.reminders) return undefined;
  if (!onlyFiller(h.rest, [DEFAULT, TG, NOT_REMIND], REMINDER_FILLER)) return undefined;
  return h.reminders.overrides.map((o) => o.minutes);
}

function parseReminders(s: string): SettingsCommand | null {
  if (!REMINDER_WORD.test(s)) return null;
  if (TG.test(s)) {
    if (NOT_REMIND.test(s) && onlyFiller(s, [NOT_REMIND, TG], REMINDER_FILLER)) return { kind: "tg_reminder", minutes: 0 };
    const m = reminderMinutes(s);
    if (m === undefined || m === null) return null;
    if (m.length === 0) return { kind: "tg_reminder", minutes: 0 };
    return m.length === 1 && m[0]! >= 1 && m[0]! <= 24 * 60 ? { kind: "tg_reminder", minutes: m[0]! } : null;
  }
  if (!DEFAULT.test(s)) return null;
  if (GOOGLE_DEFAULT.test(s) && onlyFiller(s, [GOOGLE_DEFAULT, DEFAULT], REMINDER_FILLER)) return { kind: "reminders", minutes: null };
  const m = reminderMinutes(s);
  return m === undefined || m === null ? null : { kind: "reminders", minutes: m };
}

const QUOTED_TAIL = /^(.+?)\s*(?:[—–:-]\s*|\s(?:как|as)\s+)?[«"“']([^«»"“”']+)[»"”']$/u;
const ALIAS_RU = [/^(?:назови|называй|зови)\s+(?:мой\s+)?календарь\s+(.+)$/iu, /^(?:добавь|дай)\s+календарю\s+(.+)$/iu];
const ALIAS_EN = [/^(?:call|name)\s+(?:the\s+|my\s+)?calendar\s+(.+)$/iu];
const ALIAS_SWAPPED = [
  /^календарь\s+(.+?)\s+(?:называй|зови)\s+(.+)$/iu,
  /^(?:call|name)\s+(?:the\s+|my\s+)?(?!the\s|my\s|calendar\s)(.+?)\s+calendar\s+(.+)$/iu,
];

/** «назови … семейным» — в названии нужна начальная форма. */
export function aliasForm(alias: string): string {
  return alias
    .trim()
    .replace(/ым$/u, "ый")
    .replace(/([нчщжшкгх])им$/u, "$1ий");
}

function parseAlias(s: string): SettingsCommand | null {
  for (const r of ALIAS_SWAPPED) {
    const m = r.exec(s);
    if (m) return { kind: "alias", calendar: m[1]!, alias: aliasForm(unquote(m[2]!)) };
  }
  for (const r of [...ALIAS_RU, ...ALIAS_EN]) {
    const m = r.exec(s);
    if (!m) continue;
    const body = m[1]!.replace(/\s+(?:название|имя|name)\s+/iu, " ");
    const q = QUOTED_TAIL.exec(body);
    if (q) return { kind: "alias", calendar: q[1]!, alias: aliasForm(q[2]!) };
    const dash = /^(.+?)\s+[—–-]\s+(.+)$/u.exec(body);
    if (dash) return { kind: "alias", calendar: dash[1]!, alias: aliasForm(dash[2]!) };
    return /\s/.test(body) ? { kind: "alias", text: body } : null;
  }
  return null;
}

const unquote = (s: string) => s.replace(/^[«"“']+|[»"”']+$/gu, "").trim();

const DEFAULT_CAL = [
  /^(?:сделай|поставь|назначь)\s+(.+?)\s+(?:календар(?:ем|ём)\s+)?(?:по\s+умолчанию|основным|главным)$/iu,
  /^(?:календарь\s+по\s+умолчанию|основной\s+календарь)(?:\s*[—:–-]\s*|\s+(?:будет|теперь|это)\s+|\s+)(.+)$/iu,
  /^(?:по\s+умолчанию\s+)?(?:пиши|записывай|ставь|создавай|добавляй)\s+(?:все\s+|всё\s+)?(?:встречи\s+|события\s+)?(?:по\s+умолчанию\s+)?(?:в|во)\s+(?!\d)(.+?)(?:\s+по\s+умолчанию)?$/iu,
  /^make\s+(.+?)\s+(?:(?:the|my)\s+default(?:\s+calendar)?|default\s+calendar)$/iu,
  /^set\s+(?:the\s+|my\s+)?default\s+calendar\s+to\s+(.+)$/iu,
  /^use\s+(.+?)\s+as\s+(?:(?:the|my)\s+default(?:\s+calendar)?|default\s+calendar)$/iu,
];

function parseDefaultCalendar(s: string): SettingsCommand | null {
  for (const [i, r] of DEFAULT_CAL.entries()) {
    if (i === 2 && !DEFAULT.test(s)) continue;
    const m = r.exec(s);
    if (m) return { kind: "default_calendar", name: unquote(m[1]!) };
  }
  return null;
}

const DIGEST_WORD = re(word(`сводк${L}*|дайджест${L}*|summary|digest`));
const TOMORROW = re(word(String.raw`вечерн${L}*|на\s+завтра|tomorrow|evening`));
const WEEK = re(word(String.raw`недельн${L}*|еженедельн${L}*|на\s+неделю|weekly|week`));
const SUN = re(word(String.raw`(?:по|в|on)\s+(?:воскресень${L}*|sundays?)`));
const MON = re(word(String.raw`(?:по|в|on)\s+(?:понедельник${L}*|mondays?)`));
const AT = re(String.raw`(?<!${L})(?:в|at)\s+(\d{1,2}(?:[:.]\d{2})?)(?:\s*(утра|вечера|am|pm))?(?!\d)`);
const DIGEST_FILLER = "утреннюю утренняя утренний ежедневную ежедневная утром утрам каждый день мою morning daily the every больше more".split(" ");

function parseDigest(s: string): SettingsCommand | null {
  if (!DIGEST_WORD.test(s)) return null;
  const digest: DigestKind = TOMORROW.test(s) ? "tomorrow" : WEEK.test(s) ? "week" : "today";
  const off = OFF.test(s);
  const at = digest === "today" ? AT.exec(s) : null;
  let time: string | undefined;
  if (at) {
    const minutes = parseHhmm(at[1]!);
    if (minutes === undefined) return null;
    const pm = /вечера|pm/i.test(at[2] ?? "") && minutes < 12 * 60;
    const total = minutes + (pm ? 12 * 60 : 0);
    time = `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
  }
  const day = digest === "week" ? (MON.test(s) ? "mon" : SUN.test(s) ? "sun" : undefined) : undefined;
  if (!off && !ON.test(s) && !time && !day) return null;
  if (!onlyFiller(s, [DIGEST_WORD, TOMORROW, WEEK, SUN, MON, AT, OFF, ON], DIGEST_FILLER)) return null;
  if (off) return { kind: "digest", digest, on: false };
  return { kind: "digest", digest, on: true, ...(time ? { time } : {}), ...(day ? { day } : {}) };
}

const ENGLISH = String.raw`(?:по-?\s?английски|на\s+английск${L}*|английск${L}*|english)`;
const RUSSIAN = String.raw`(?:по-?\s?русски|на\s+русск${L}*|русск${L}*|russian)`;
const LANG_VERB = String.raw`(?:отвечай|говори|пиши|разговаривай|общайся|переключись(?:\s+на)?|перейди(?:\s+на)?|смени\s+язык\s+на|язык|speak|reply\s+in|answer\s+in|talk(?:\s+to\s+me)?\s+in|switch\s+to|change\s+(?:the\s+)?language\s+to|language)`;
const LANG = (lang: string) => re(String.raw`^${LANG_VERB}\s+(?:со\s+мной\s+|мне\s+|with\s+me\s+)?${lang}(?:\s+(?:язык|language))?$`);

function parseLanguage(s: string): SettingsCommand | null {
  if (LANG(ENGLISH).test(s)) return { kind: "language", locale: "en" };
  if (LANG(RUSSIAN).test(s)) return { kind: "language", locale: "ru" };
  return null;
}

const NOTIFY_WORD = re(word(String.raw`уведомлени${L}*(?:\s+(?:об?|про)\s+изменени${L}*)?|(?:change\s+)?notifications?(?:\s+(?:about|of|on)\s+changes)?`));

function parseNotify(s: string): SettingsCommand | null {
  if (!NOTIFY_WORD.test(s)) return null;
  const off = OFF.test(s);
  if (!off && !ON.test(s)) return null;
  if (!onlyFiller(s, [NOTIFY_WORD, OFF, ON], ["календаре", "календарях", "calendar"])) return null;
  return { kind: "change_notify", on: !off };
}

export function parseSettingsCommand(text: string): SettingsCommand | null {
  const s = text
    .trim()
    .replace(/[.!?]+$/u, "")
    .replace(/[’`]/g, "'")
    .replace(/\s+/g, " ");
  if (!s || s.length > 120) return null;
  return parseLanguage(s) ?? parseAlias(s) ?? parseDefaultCalendar(s) ?? parseDigest(s) ?? parseNotify(s) ?? parseReminders(s) ?? parseDuration(s);
}
