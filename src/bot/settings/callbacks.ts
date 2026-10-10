// Нажатия «st:<раздел>:<значение>» правят сообщение на месте. Настройка идемпотентна — карточка в D1 не нужна;
// значения проверяются по белым спискам (screens.ts).

import { TZ_PRESETS } from "../../dates/timezone";
import { AWAIT_TTL_MS, mergeDialogState } from "../../db/conversations";
import { recordFeature } from "../../db/features";
import { rescheduleDigest } from "../../jobs/digest";
import { clearAliases, DEFAULT_DURATION_MIN, setDefaultCalendar, setHomeTz, setLocale, updateSettings } from "../../db/settings";
import type { User } from "../../db/users";
import type { AppContext } from "../context";
import { t } from "../messages";
import { calendarsOf, sendReconnect, setDigest } from "./common";
import { rescheduleUserReminders, TG_REMINDER_PRESETS } from "../../sync/reminders";
import {
  ALL_DAY_PRESETS,
  allDayScreen,
  calendarScreen,
  calendarsScreen,
  DIGEST_TIMES,
  digestScreen,
  DURATIONS,
  durationScreen,
  mainScreen,
  notifyScreen,
  REMINDER_PRESETS,
  remindersScreen,
  type Screen,
  tzScreen,
} from "./screens";

export function parseSettingsCallback(data: string | undefined): { section: string; value?: string } | null {
  const m = /^st:(\w+)(?::([\w-]+))?$/.exec(data ?? "");
  return m ? { section: m[1]!, ...(m[2] ? { value: m[2] } : {}) } : null;
}

// Возвращает текст всплывающего ответа на нажатие.
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
    case "menu":
      break;
    case "conn":
      await sendReconnect(ctx, user, chatId);
      return undefined;
    case "cals":
      screen = calendarsScreen(u, calendars);
      break;
    case "cal":
      if (cal) screen = calendarScreen(u, cal);
      break;
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
        await mergeDialogState(
          ctx.db,
          conversationId,
          user.id,
          { awaiting: { kind: "settings_alias", calendarId: cal.id, expiresAt: ctx.clock.now() + AWAIT_TTL_MS } },
          ctx.clock.now(),
        );
        await ctx.telegram.sendMessage(chatId, t("settingsAskAlias", l, { name: cal.title }));
        return undefined;
      }
      break;
    case "tz":
      screen = tzScreen(u);
      break;
    case "tzset": {
      const p = TZ_PRESETS[Number(cb.value)];
      if (p) {
        await setHomeTz(ctx.db, user.id, p.tz);
        await rescheduleDigest(ctx.db, user.id, ctx.clock.now());
        // Пояс в настройках — домашний: поездка снимается (US-07)
        const { trip: _trip, ...rest } = u;
        u = { ...rest, tz: p.tz, home_tz: p.tz };
        saved = true;
      }
      break;
    }
    case "tzother":
      await mergeDialogState(
        ctx.db,
        conversationId,
        user.id,
        { awaiting: { kind: "settings_tz", expiresAt: ctx.clock.now() + AWAIT_TTL_MS } },
        ctx.clock.now(),
      );
      await ctx.telegram.sendMessage(chatId, t("settingsAskTz", l));
      return undefined;
    case "dur":
      screen = durationScreen(u);
      break;
    case "durset": {
      const m = Number(cb.value);
      if (DURATIONS.includes(m)) {
        await updateSettings(ctx.db, user.id, { durationMin: m === DEFAULT_DURATION_MIN ? undefined : m });
        u = { ...u, settings: { ...u.settings, durationMin: m } };
        saved = true;
      }
      break;
    }
    case "rem":
      screen = remindersScreen(u);
      break;
    case "remset":
      if (cb.value && cb.value in REMINDER_PRESETS) {
        const v = REMINDER_PRESETS[cb.value]!;
        await updateSettings(ctx.db, user.id, { reminders: v ?? undefined });
        const { reminders: _r, ...rest } = u.settings;
        u = { ...u, settings: v ? { ...rest, reminders: v } : rest };
        saved = true;
      }
      break;
    case "rad":
      screen = allDayScreen(u);
      break;
    case "radset":
      if (cb.value && cb.value in ALL_DAY_PRESETS) {
        const v = ALL_DAY_PRESETS[cb.value]!;
        await updateSettings(ctx.db, user.id, { allDayReminders: v.length ? v : undefined });
        u = { ...u, settings: { ...u.settings, allDayReminders: v } };
        saved = true;
      }
      break;
    case "dig":
      screen = digestScreen(u);
      break;
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
    case "digtm": {
      const on = !u.settings.tomorrowDigest;
      await updateSettings(ctx.db, user.id, { tomorrowDigest: on || undefined });
      await rescheduleDigest(ctx.db, user.id, ctx.clock.now());
      const { tomorrowDigest: _t, ...rest } = u.settings;
      u = { ...u, settings: on ? { ...rest, tomorrowDigest: true } : rest };
      saved = true;
      screen = digestScreen(u);
      break;
    }
    case "digwk":
      if (cb.value === "off" || cb.value === "sun" || cb.value === "mon") {
        const week = cb.value === "off" ? undefined : cb.value;
        await updateSettings(ctx.db, user.id, { weekDigest: week });
        await rescheduleDigest(ctx.db, user.id, ctx.clock.now());
        const { weekDigest: _w, ...rest } = u.settings;
        u = { ...u, settings: week ? { ...rest, weekDigest: week } : rest };
        saved = true;
        screen = digestScreen(u);
      }
      break;
    case "digother":
      await mergeDialogState(
        ctx.db,
        conversationId,
        user.id,
        { awaiting: { kind: "settings_digest_time", expiresAt: ctx.clock.now() + AWAIT_TTL_MS } },
        ctx.clock.now(),
      );
      await ctx.telegram.sendMessage(chatId, t("settingsAskDigestTime", l));
      return undefined;
    case "ntf":
      screen = notifyScreen(u);
      break;
    case "ntfchg": {
      const off = !u.settings.changeNotifyOff;
      await updateSettings(ctx.db, user.id, { changeNotifyOff: off || undefined });
      u = { ...u, settings: { ...u.settings, changeNotifyOff: off } };
      screen = notifyScreen(u);
      saved = true;
      break;
    }
    case "ntfrem": {
      const m = Number(cb.value);
      if (m === 0 || TG_REMINDER_PRESETS.includes(m)) {
        await updateSettings(ctx.db, user.id, { tgReminderMin: m || undefined });
        const { tgReminderMin: _m, ...rest } = u.settings;
        u = { ...u, settings: m ? { ...rest, tgReminderMin: m } : rest };
        await rescheduleUserReminders(ctx.db, user.id, ctx.clock.now());
        screen = notifyScreen(u);
        saved = true;
      }
      break;
    }
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
  if (saved) await recordFeature(ctx.db, user.id, "settings", ctx.clock.now());
  return saved ? t("settingsSaved", u.locale) : undefined;
}
