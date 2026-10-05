// /settings (US-04): меню с кнопками, сообщение правится на месте. Кнопки без состояния — «st:<раздел>:<значение>»:
// настройка идемпотентна, карточка в D1 не нужна; значения проверяются по белым спискам.
// Текстом вводятся только пояс («Другой…») и другие названия календаря (US-06) — через awaiting в диалоге.

import type { CalendarInfo } from "../calendar/model";
import { GoogleCalendarProvider } from "../calendar/google-provider";
import { utcToLocal } from "../dates/calendar";
import { parseTimeZone, TZ_PRESETS } from "../dates/timezone";
import { parseHhmm } from "../dates/daily";
import { mergeDialogState } from "../db/conversations";
import { rescheduleDigest } from "../jobs/digest";
import {
  addAliases, clearAliases, DEFAULT_DIGEST_TIME, DEFAULT_DURATION_MIN, setDefaultCalendar, setHomeTz, setLocale, updateSettings,
} from "../db/settings";
import type { User } from "../db/users";
import type { InlineKeyboardButton } from "../telegram/types";
import type { AppContext } from "./context";
import { escapeHtml, hhmm } from "./format";
import { t } from "./messages";

const AWAIT_TTL_MS = 15 * 60 * 1000;

const DURATIONS = [15, 30, 45, 60, 90, 120];
const DIGEST_TIMES = ["06:00", "06:30", "07:00", "07:30", "08:00", "08:30", "09:00", "09:30", "10:00"];

/** Пресеты напоминаний: ключ кнопки → минуты (null — как в Google). */
const REMINDER_PRESETS: Record<string, number[] | null> = {
  g: null, n: [], m10: [10], m15: [15], m30: [30], h1: [60], h1d1: [60, 1440], d1: [1440],
};
/** Для «весь день» минуты считаются до полуночи дня события: 900 = накануне в 9:00. */
const ALL_DAY_PRESETS: Record<string, number[]> = { n: [], e18: [360], e9: [900], e9d2: [900, 2340] };

// --- Подписи -------------------------------------------------------------------

function durationLabel(min: number, locale: string): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (locale === "en") return [h ? `${h} h` : "", m ? `${m} min` : ""].filter(Boolean).join(" ");
  return [h ? `${h} ч` : "", m ? `${m} мин` : ""].filter(Boolean).join(" ");
}

function beforeLabel(min: number, locale: string): string {
  if (min % 1440 === 0) return t("reminderBefore", locale, { value: locale === "en" ? `${min / 1440} d` : `${min / 1440} дн.` });
  return t("reminderBefore", locale, { value: durationLabel(min, locale) });
}

function allDayLabel(min: number, locale: string): string {
  const days = Math.ceil(min / 1440);
  const time = hhmm(days * 1440 - min).replace(/^0/, "");
  return days === 1 ? t("reminderDayBefore", locale, { time }) : t("reminderDaysBefore", locale, { days: String(days), time });
}

export function remindersLabel(r: number[] | undefined, locale: string): string {
  if (r === undefined) return t("remindersGoogle", locale);
  if (r.length === 0) return t("remindersNone", locale);
  return r.map((m) => beforeLabel(m, locale)).join(", ");
}

function allDayRemindersLabel(r: number[] | undefined, locale: string): string {
  if (!r || r.length === 0) return t("remindersNone", locale);
  return r.map((m) => allDayLabel(m, locale)).join(", ");
}

const nowIn = (ctx: AppContext, tz: string) => hhmm(utcToLocal(ctx.clock.now(), tz).minutes);

// --- Экраны ----------------------------------------------------------------------

interface Screen {
  text: string;
  buttons: InlineKeyboardButton[][];
}

const btn = (text: string, data: string): InlineKeyboardButton => ({ text, callback_data: `st:${data}` });
const rows = <T>(items: T[], size: number): T[][] => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, i * size + size));

function mainScreen(ctx: AppContext, user: User, calendars: CalendarInfo[]): Screen {
  const l = user.locale;
  const s = user.settings;
  const def = calendars.find((c) => c.isDefault && c.writable) ?? calendars.find((c) => c.writable);
  const text = [
    t("settingsTitle", l), "",
    t("settingsCalendar", l, { value: escapeHtml(def?.title ?? t("settingsNone", l)) }),
    t("settingsTz", l, { value: user.home_tz, time: nowIn(ctx, user.home_tz) }),
    t("settingsDuration", l, { value: durationLabel(s.durationMin ?? DEFAULT_DURATION_MIN, l) }),
    t("settingsReminders", l, { value: remindersLabel(s.reminders, l) }),
    t("settingsAllDayReminders", l, { value: allDayRemindersLabel(s.allDayReminders, l) }),
    s.digestOff ? t("settingsDigestOff", l) : t("settingsDigest", l, { time: s.digestTime ?? DEFAULT_DIGEST_TIME }),
    t("settingsLanguage", l), "",
    `<i>${t("settingsHint", l)}</i>`,
  ].join("\n");
  return {
    text,
    buttons: [
      [btn(t("settingsCalendarsButton", l), "cals"), btn(t("settingsTzButton", l), "tz")],
      [btn(t("settingsDurationButton", l), "dur"), btn(t("settingsRemindersButton", l), "rem")],
      [btn(t("settingsAllDayButton", l), "rad"), btn(t("settingsDigestButton", l), "dig")],
      [btn(t("settingsLanguageButton", l), `lang:${l === "en" ? "ru" : "en"}`)],
    ],
  };
}

const back = (l: string) => [btn(t("settingsBack", l), "menu")];
const mark = (on: boolean, text: string) => (on ? `✓ ${text}` : text);

function calendarsScreen(user: User, calendars: CalendarInfo[]): Screen {
  const l = user.locale;
  return {
    text: t("settingsChooseCalendar", l),
    buttons: [...calendars.filter((c) => c.writable).map((c) => [btn(mark(c.isDefault, c.title), `cal:${c.id}`)]), back(l)],
  };
}

function calendarScreen(user: User, c: CalendarInfo): Screen {
  const l = user.locale;
  const aliases = c.aliases.length ? c.aliases.map((a) => `«${escapeHtml(a)}»`).join(", ") : t("settingsNone", l);
  const text = [t("settingsCalendarPage", l, { name: escapeHtml(c.title), aliases }), ...(c.isDefault ? ["", t("settingsIsDefault", l)] : [])].join("\n");
  return {
    text,
    buttons: [
      ...(c.isDefault ? [] : [[btn(t("settingsMakeDefault", l), `cdef:${c.id}`)]]),
      [btn(t("settingsAddAlias", l), `calias:${c.id}`), ...(c.aliases.length ? [btn(t("settingsClearAliases", l), `cclr:${c.id}`)] : [])],
      [btn(t("settingsBack", l), "cals")],
    ],
  };
}

function tzScreen(user: User): Screen {
  const l = user.locale;
  const cities = TZ_PRESETS.map((p, i) => btn(mark(p.tz === user.home_tz, l === "en" ? p.en : p.ru), `tzset:${i}`));
  return { text: t("settingsChooseTz", l, { value: user.home_tz }), buttons: [...rows(cities, 2), [btn(t("settingsOtherTz", l), "tzother")], back(l)] };
}

function durationScreen(user: User): Screen {
  const l = user.locale;
  const cur = user.settings.durationMin ?? DEFAULT_DURATION_MIN;
  const items = DURATIONS.map((m) => btn(mark(m === cur, durationLabel(m, l)), `durset:${m}`));
  return { text: t("settingsChooseDuration", l), buttons: [...rows(items, 3), back(l)] };
}

const same = (a: number[] | null | undefined, b: number[] | null | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function remindersScreen(user: User): Screen {
  const l = user.locale;
  const items = Object.entries(REMINDER_PRESETS).map(([k, v]) =>
    btn(mark(same(v, user.settings.reminders), remindersLabel(v ?? undefined, l)), `remset:${k}`));
  return { text: t("settingsChooseReminders", l), buttons: [...rows(items, 2), back(l)] };
}

function allDayScreen(user: User): Screen {
  const l = user.locale;
  const items = Object.entries(ALL_DAY_PRESETS).map(([k, v]) =>
    btn(mark(same(v, user.settings.allDayReminders ?? []), allDayRemindersLabel(v, l)), `radset:${k}`));
  return { text: t("settingsChooseAllDay", l), buttons: [...rows(items, 1), back(l)] };
}

function digestScreen(user: User): Screen {
  const l = user.locale;
  const cur = user.settings.digestOff ? undefined : user.settings.digestTime ?? DEFAULT_DIGEST_TIME;
  const items = DIGEST_TIMES.map((tm) => btn(mark(tm === cur, tm), `digset:${tm.replace(":", "")}`));
  return {
    text: t("settingsChooseDigest", l, { tz: user.home_tz }),
    buttons: [
      ...rows(items, 3),
      [btn(t("settingsOtherTime", l), "digother"), ...(cur ? [btn(t("settingsDigestDisable", l), "digoff")] : [])],
      back(l),
    ],
  };
}

async function setDigest(ctx: AppContext, user: User, time: string | null): Promise<User> {
  await updateSettings(ctx.db, user.id, time ? { digestOff: undefined, digestTime: time === DEFAULT_DIGEST_TIME ? undefined : time } : { digestOff: true });
  await rescheduleDigest(ctx.db, user.id, ctx.clock.now());
  const { digestOff: _o, digestTime: _t, ...rest } = user.settings;
  return { ...user, settings: time ? { ...rest, digestTime: time } : { ...rest, digestOff: true, ...(user.settings.digestTime ? { digestTime: user.settings.digestTime } : {}) } };
}

// --- Сценарий ------------------------------------------------------------------

const calendarsOf = (ctx: AppContext, user: User) => new GoogleCalendarProvider(ctx.config, ctx.db, user.id).calendars();

export async function showSettings(ctx: AppContext, user: User, chatId: number): Promise<void> {
  const s = mainScreen(ctx, user, await calendarsOf(ctx, user));
  await ctx.telegram.sendMessage(chatId, s.text, { inline_keyboard: s.buttons }, { html: true });
}

export function parseSettingsCallback(data: string | undefined): { section: string; value?: string } | null {
  const m = /^st:(\w+)(?::([\w-]+))?$/.exec(data ?? "");
  return m ? { section: m[1]!, ...(m[2] ? { value: m[2] } : {}) } : null;
}

/** Нажатие кнопки в меню настроек. Возвращает текст всплывающего ответа на нажатие. */
export async function handleSettingsCallback(
  ctx: AppContext,
  user: User,
  chatId: number,
  messageId: number,
  cb: { section: string; value?: string },
  conversationId: string,
): Promise<string | undefined> {
  const l = user.locale;
  let u = user;
  let saved = false;
  const calendars = await calendarsOf(ctx, user);
  const cal = cb.value ? calendars.find((c) => c.id === cb.value && c.writable) : undefined;
  let screen: Screen | null = null;

  switch (cb.section) {
    case "menu": break;
    case "cals": screen = calendarsScreen(u, calendars); break;
    case "cal": if (cal) screen = calendarScreen(u, cal); break;
    case "cdef":
      if (cal && (await setDefaultCalendar(ctx.db, user.id, cal.id))) {
        saved = true;
        const fresh = await calendarsOf(ctx, user);
        screen = calendarScreen(u, fresh.find((c) => c.id === cal.id)!);
      }
      break;
    case "cclr":
      if (cal) {
        await clearAliases(ctx.db, user.id, cal.id);
        saved = true;
        screen = calendarScreen(u, { ...cal, aliases: [] });
      }
      break;
    case "calias":
      if (cal) {
        await mergeDialogState(ctx.db, conversationId, user.id, { awaiting: { kind: "settings_alias", calendarId: cal.id, expiresAt: ctx.clock.now() + AWAIT_TTL_MS } }, ctx.clock.now());
        await ctx.telegram.sendMessage(chatId, t("settingsAskAlias", l, { name: cal.title }));
        return undefined;
      }
      break;
    case "tz": screen = tzScreen(u); break;
    case "tzset": {
      const p = TZ_PRESETS[Number(cb.value)];
      if (p) {
        await setHomeTz(ctx.db, user.id, p.tz);
        await rescheduleDigest(ctx.db, user.id, ctx.clock.now());
        u = { ...u, home_tz: p.tz };
        saved = true;
      }
      break;
    }
    case "tzother":
      await mergeDialogState(ctx.db, conversationId, user.id, { awaiting: { kind: "settings_tz", expiresAt: ctx.clock.now() + AWAIT_TTL_MS } }, ctx.clock.now());
      await ctx.telegram.sendMessage(chatId, t("settingsAskTz", l));
      return undefined;
    case "dur": screen = durationScreen(u); break;
    case "durset": {
      const m = Number(cb.value);
      if (DURATIONS.includes(m)) {
        await updateSettings(ctx.db, user.id, { durationMin: m === DEFAULT_DURATION_MIN ? undefined : m });
        u = { ...u, settings: { ...u.settings, durationMin: m } };
        saved = true;
      }
      break;
    }
    case "rem": screen = remindersScreen(u); break;
    case "remset":
      if (cb.value && cb.value in REMINDER_PRESETS) {
        const v = REMINDER_PRESETS[cb.value]!;
        await updateSettings(ctx.db, user.id, { reminders: v ?? undefined });
        const { reminders: _r, ...rest } = u.settings;
        u = { ...u, settings: v ? { ...rest, reminders: v } : rest };
        saved = true;
      }
      break;
    case "rad": screen = allDayScreen(u); break;
    case "radset":
      if (cb.value && cb.value in ALL_DAY_PRESETS) {
        const v = ALL_DAY_PRESETS[cb.value]!;
        await updateSettings(ctx.db, user.id, { allDayReminders: v.length ? v : undefined });
        u = { ...u, settings: { ...u.settings, allDayReminders: v } };
        saved = true;
      }
      break;
    case "dig": screen = digestScreen(u); break;
    case "digset": {
      const time = cb.value && /^\d{4}$/.test(cb.value) ? `${cb.value.slice(0, 2)}:${cb.value.slice(2)}` : undefined;
      if (time && DIGEST_TIMES.includes(time)) {
        u = await setDigest(ctx, u, time);
        saved = true;
      }
      break;
    }
    case "digoff":
      u = await setDigest(ctx, u, null);
      saved = true;
      break;
    case "digother":
      await mergeDialogState(ctx.db, conversationId, user.id, { awaiting: { kind: "settings_digest_time", expiresAt: ctx.clock.now() + AWAIT_TTL_MS } }, ctx.clock.now());
      await ctx.telegram.sendMessage(chatId, t("settingsAskDigestTime", l));
      return undefined;
    case "lang":
      if (cb.value === "ru" || cb.value === "en") {
        await setLocale(ctx.db, user.id, cb.value);
        u = { ...u, locale: cb.value };
        saved = true;
      }
      break;
    default:
      return undefined;
  }
  screen ??= mainScreen(ctx, u, calendars);
  await ctx.telegram.editMessageText(chatId, messageId, screen.text, { inline_keyboard: screen.buttons }, { html: true });
  return saved ? t("settingsSaved", u.locale) : undefined;
}

// --- Ввод текстом ------------------------------------------------------------------

export async function handleSettingsInput(
  ctx: AppContext,
  user: User,
  chatId: number,
  awaiting: { kind: "settings_tz" } | { kind: "settings_digest_time" } | { kind: "settings_alias"; calendarId: string },
  text: string,
): Promise<boolean> {
  const l = user.locale;
  // Длинная фраза — скорее новая команда, чем пояс или название
  const parts = text.split(/[,;\n]+/);
  if (parts.some((p) => p.trim().split(/\s+/).length > 3)) return false;
  if (awaiting.kind === "settings_tz") {
    const tz = parseTimeZone(text);
    if (!tz) {
      await ctx.telegram.sendMessage(chatId, t("settingsTzUnknown", l, { value: text.slice(0, 40) }));
      return true;
    }
    await setHomeTz(ctx.db, user.id, tz);
    await rescheduleDigest(ctx.db, user.id, ctx.clock.now());
    await ctx.telegram.sendMessage(chatId, t("settingsTzSet", l, { value: tz, time: nowIn(ctx, tz) }));
    return true;
  }
  if (awaiting.kind === "settings_digest_time") {
    const minutes = parseHhmm(text);
    if (minutes === undefined) {
      await ctx.telegram.sendMessage(chatId, t("settingsTimeUnknown", l, { value: text.slice(0, 40) }));
      return true;
    }
    const time = hhmm(minutes);
    await setDigest(ctx, user, time);
    await ctx.telegram.sendMessage(chatId, t("settingsDigestSet", l, { time }));
    return true;
  }
  const cal = (await calendarsOf(ctx, user)).find((c) => c.id === awaiting.calendarId);
  const added = cal ? await addAliases(ctx.db, user.id, cal.id, parts) : [];
  if (!cal || added.length === 0) {
    await ctx.telegram.sendMessage(chatId, t("settingsAliasEmpty", l));
    return true;
  }
  await ctx.telegram.sendMessage(chatId, t("settingsAliasesAdded", l, { name: cal.title, aliases: added.map((a) => `«${a}»`).join(", "), first: added[0]! }));
  return true;
}
