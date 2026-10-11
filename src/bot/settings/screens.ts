// Пресеты — белые списки значений, по ним проверяются нажатия (callbacks.ts). Без записи в D1.

import type { CalendarInfo } from "../../calendar/model";
import { parseLocal, utcToLocal } from "../../dates/calendar";
import { TZ_PRESETS } from "../../dates/timezone";
import { DEFAULT_DIGEST_TIME, DEFAULT_DURATION_MIN } from "../../db/settings";
import type { User } from "../../db/users";
import type { InlineKeyboardButton } from "../../telegram/types";
import type { AppContext } from "../context";
import { dateLabel, escapeHtml, hhmm } from "../format";
import { t } from "../messages";
import { allDayRemindersLabel, durationLabel, remindersLabel } from "./labels";
import { TG_REMINDER_PRESETS } from "../../sync/reminders";

export const DURATIONS = [15, 30, 45, 60, 90, 120];
export const DIGEST_TIMES = ["06:00", "06:30", "07:00", "07:30", "08:00", "08:30", "09:00", "09:30", "10:00"];

// null — как в Google.
export const REMINDER_PRESETS: Record<string, number[] | null> = {
  g: null,
  n: [],
  m10: [10],
  m15: [15],
  m30: [30],
  h1: [60],
  h1d1: [60, 1440],
  d1: [1440],
};
/** Для «весь день» минуты считаются до полуночи дня события: 900 = накануне в 9:00. */
export const ALL_DAY_PRESETS: Record<string, number[]> = { n: [], e18: [360], e9: [900], e9d2: [900, 2340] };

export const nowIn = (ctx: AppContext, tz: string) => hhmm(utcToLocal(ctx.clock.now(), tz).minutes);

function tzLine(ctx: AppContext, user: User): string {
  const l = user.locale;
  const trip = user.trip;
  if (!trip) return t("settingsTz", l, { value: user.home_tz, time: nowIn(ctx, user.home_tz) });
  const until = trip.until ? t("tzUntilPart", l, { day: dateLabel(parseLocal(`${trip.until}T00:00`).day, utcToLocal(ctx.clock.now(), trip.tz).day, l) }) : "";
  return t("settingsTzTrip", l, { tz: trip.tz, time: nowIn(ctx, trip.tz), until, home: user.home_tz });
}

export type SettingKey = "duration" | "reminders" | "digest" | "tomorrowDigest" | "weekDigest" | "language" | "changeNotify" | "tgReminder";

export function settingLine(user: User, key: SettingKey): string {
  const l = user.locale;
  const s = user.settings;
  switch (key) {
    case "duration":
      return t("settingsDuration", l, { value: durationLabel(s.durationMin ?? DEFAULT_DURATION_MIN, l) });
    case "reminders":
      return t("settingsReminders", l, { value: remindersLabel(s.reminders, l) });
    case "digest":
      return s.digestOff ? t("settingsDigestOff", l) : t("settingsDigest", l, { time: s.digestTime ?? DEFAULT_DIGEST_TIME });
    case "tomorrowDigest":
      return t(s.tomorrowDigest ? "settingsTomorrowDigest" : "settingsTomorrowDigestOff", l);
    case "weekDigest":
      return t(s.weekDigest === "sun" ? "settingsWeekDigestSun" : s.weekDigest === "mon" ? "settingsWeekDigestMon" : "settingsWeekDigestOff", l);
    case "language":
      return t("settingsLanguage", l);
    case "changeNotify":
      return s.changeNotifyOff ? t("settingsNotifyOff", l) : t("settingsNotifyOn", l);
    case "tgReminder":
      return s.tgReminderMin ? t("settingsTgReminderOn", l, { minutes: String(s.tgReminderMin) }) : t("settingsTgReminderOff", l);
  }
}

export interface Screen {
  text: string;
  buttons: InlineKeyboardButton[][];
}

const btn = (text: string, data: string): InlineKeyboardButton => ({ text, callback_data: `st:${data}` });
const rows = <T>(items: T[], size: number): T[][] => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, i * size + size));

export function mainScreen(ctx: AppContext, user: User, calendars: CalendarInfo[]): Screen {
  const l = user.locale;
  const s = user.settings;
  // Без своего Google (участник дома): только то, что действует, — сводки, напоминания и уведомления в Telegram, пояс,
  // язык; календари, длительность и напоминания Google — не его (ревью R1 #17, QA-25)
  if (calendars.length === 0) return memberScreen(ctx, user);
  const def = calendars.find((c) => c.isDefault && c.writable) ?? calendars.find((c) => c.writable);
  const text = [
    t("settingsTitle", l),
    "",
    t("settingsCalendar", l, { value: escapeHtml(def?.title ?? t("settingsNone", l)) }),
    tzLine(ctx, user),
    settingLine(user, "duration"),
    settingLine(user, "reminders"),
    t("settingsAllDayReminders", l, { value: allDayRemindersLabel(s.allDayReminders, l) }),
    settingLine(user, "digest"),
    settingLine(user, "tomorrowDigest"),
    settingLine(user, "weekDigest"),
    settingLine(user, "language"),
    settingLine(user, "changeNotify"),
    settingLine(user, "tgReminder"),
    "",
    `<i>${t("settingsHint", l)}</i>`,
    `<i>${t("settingsDisconnectHint", l)}</i>`,
  ].join("\n");
  return {
    text,
    buttons: [
      [btn(t("settingsCalendarsButton", l), "cals"), btn(t("settingsTzButton", l), "tz")],
      [btn(t("settingsDurationButton", l), "dur"), btn(t("settingsRemindersButton", l), "rem")],
      [btn(t("settingsAllDayButton", l), "rad"), btn(t("settingsDigestButton", l), "dig")],
      [btn(t("settingsLanguageButton", l), `lang:${l === "en" ? "ru" : "en"}`), btn(t("settingsGoogleButton", l), "conn")],
      [btn(t("settingsNotifyButton", l), "ntf")],
    ],
  };
}

function memberScreen(ctx: AppContext, user: User): Screen {
  const l = user.locale;
  const text = [
    t("settingsTitle", l),
    "",
    tzLine(ctx, user),
    settingLine(user, "digest"),
    settingLine(user, "tomorrowDigest"),
    settingLine(user, "weekDigest"),
    settingLine(user, "language"),
    settingLine(user, "changeNotify"),
    settingLine(user, "tgReminder"),
    "",
    `<i>${t("settingsMemberHint", l)}</i>`,
  ].join("\n");
  return {
    text,
    buttons: [
      [btn(t("settingsTzButton", l), "tz"), btn(t("settingsDigestButton", l), "dig")],
      [btn(t("settingsLanguageButton", l), `lang:${l === "en" ? "ru" : "en"}`), btn(t("settingsNotifyButton", l), "ntf")],
      [btn(t("settingsConnectOwnButton", l), "conn")],
    ],
  };
}

const back = (l: string) => [btn(t("settingsBack", l), "menu")];
const mark = (on: boolean, text: string) => (on ? `✓ ${text}` : text);

export function calendarsScreen(user: User, calendars: CalendarInfo[]): Screen {
  const l = user.locale;
  return {
    text: t("settingsChooseCalendar", l),
    buttons: [...calendars.filter((c) => c.writable).map((c) => [btn(mark(c.isDefault, c.title), `cal:${c.id}`)]), back(l)],
  };
}

export function calendarScreen(user: User, c: CalendarInfo): Screen {
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

export function tzScreen(user: User): Screen {
  const l = user.locale;
  const cities = TZ_PRESETS.map((p, i) => btn(mark(p.tz === user.home_tz, l === "en" ? p.en : p.ru), `tzset:${i}`));
  return { text: t("settingsChooseTz", l, { value: user.home_tz }), buttons: [...rows(cities, 2), [btn(t("settingsOtherTz", l), "tzother")], back(l)] };
}

export function durationScreen(user: User): Screen {
  const l = user.locale;
  const cur = user.settings.durationMin ?? DEFAULT_DURATION_MIN;
  const items = DURATIONS.map((m) => btn(mark(m === cur, durationLabel(m, l)), `durset:${m}`));
  return { text: t("settingsChooseDuration", l), buttons: [...rows(items, 3), back(l)] };
}

const same = (a: number[] | null | undefined, b: number[] | null | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function remindersScreen(user: User): Screen {
  const l = user.locale;
  const items = Object.entries(REMINDER_PRESETS).map(([k, v]) => btn(mark(same(v, user.settings.reminders), remindersLabel(v ?? undefined, l)), `remset:${k}`));
  return { text: t("settingsChooseReminders", l), buttons: [...rows(items, 2), back(l)] };
}

export function allDayScreen(user: User): Screen {
  const l = user.locale;
  const items = Object.entries(ALL_DAY_PRESETS).map(([k, v]) =>
    btn(mark(same(v, user.settings.allDayReminders ?? []), allDayRemindersLabel(v, l)), `radset:${k}`),
  );
  return { text: t("settingsChooseAllDay", l), buttons: [...rows(items, 1), back(l)] };
}

export function digestScreen(user: User): Screen {
  const l = user.locale;
  const cur = user.settings.digestOff ? undefined : (user.settings.digestTime ?? DEFAULT_DIGEST_TIME);
  const items = DIGEST_TIMES.map((tm) => btn(mark(tm === cur, tm), `digset:${tm.replace(":", "")}`));
  const week = user.settings.weekDigest;
  return {
    text: `${t("settingsChooseDigest", l, { tz: user.tz })}\n\n${t("settingsDigestMore", l)}`,
    buttons: [
      ...rows(items, 3),
      [btn(t("settingsOtherTime", l), "digother"), ...(cur ? [btn(t("settingsDigestDisable", l), "digoff")] : [])],
      [btn(mark(!!user.settings.tomorrowDigest, t("settingsTomorrowButton", l)), "digtm")],
      [
        btn(mark(!week, t("settingsWeekOffButton", l)), "digwk:off"),
        btn(mark(week === "sun", t("settingsWeekSunButton", l)), "digwk:sun"),
        btn(mark(week === "mon", t("settingsWeekMonButton", l)), "digwk:mon"),
      ],
      back(l),
    ],
  };
}

export function notifyScreen(user: User): Screen {
  const l = user.locale;
  const s = user.settings;
  const toggle = btn(t(s.changeNotifyOff ? "settingsNotifyToggleOff" : "settingsNotifyToggleOn", l), "ntfchg");
  const mins = TG_REMINDER_PRESETS.map((m) => btn(mark(s.tgReminderMin === m, t("settingsTgReminderMin", l, { minutes: String(m) })), `ntfrem:${m}`));
  return {
    text: t("settingsChooseNotify", l),
    buttons: [[toggle], ...rows(mins, 3), [btn(mark(!s.tgReminderMin, t("settingsTgReminderNone", l)), "ntfrem:0")], back(l)],
  };
}
