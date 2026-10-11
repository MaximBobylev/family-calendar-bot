// Настройки фразой (текстом или голосом) применяются сразу, как кнопка в /settings: ответ показывает новое значение,
// ошибку распознавания видно и легко поправить той же фразой.

import { findCalendarByName } from "../../calendar/match";
import type { CalendarInfo } from "../../calendar/model";
import { recordFeature } from "../../db/features";
import { addAliases, DEFAULT_DIGEST_TIME, DEFAULT_DURATION_MIN, setDefaultCalendar, setLocale, updateSettings } from "../../db/settings";
import type { User } from "../../db/users";
import { rescheduleDigest } from "../../jobs/digest";
import { aliasForm, parseSettingsCommand, type SettingsCommand } from "../../nlu/settings-command";
import { rescheduleUserReminders } from "../../sync/reminders";
import type { AppContext } from "../context";
import { escapeHtml } from "../format";
import { t } from "../messages";
import { calendarsOf, setDigest } from "./common";
import { type SettingKey, settingLine } from "./screens";

const GOOGLE_ONLY = new Set<SettingsCommand["kind"]>(["duration", "reminders", "alias", "default_calendar"]);

export async function handleSettingsCommand(ctx: AppContext, user: User, chatId: number, text: string): Promise<boolean> {
  const cmd = parseSettingsCommand(text);
  if (!cmd) return false;
  const l = user.locale;
  const calendars = GOOGLE_ONLY.has(cmd.kind) ? await calendarsOf(ctx, user) : [];
  if (GOOGLE_ONLY.has(cmd.kind) && calendars.length === 0) {
    await ctx.telegram.sendMessage(chatId, t("settingsVoiceNeedsGoogle", l));
    return true;
  }
  const reply = await apply(ctx, user, cmd, calendars);
  await ctx.telegram.sendMessage(chatId, reply.text, undefined, { html: true });
  if (reply.saved) await recordFeature(ctx.db, user.id, cmd.kind === "alias" ? ["settings", "alias"] : "settings", ctx.clock.now());
  return true;
}

const done = (user: User, key: SettingKey) => ({ text: t("settingsVoiceDone", user.locale, { line: settingLine(user, key) }), saved: true });

async function apply(ctx: AppContext, user: User, cmd: SettingsCommand, calendars: CalendarInfo[]): Promise<{ text: string; saved: boolean }> {
  const l = user.locale;
  const now = ctx.clock.now();
  const withSettings = (patch: Partial<User["settings"]>): User => {
    const next: Record<string, unknown> = { ...user.settings, ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    return { ...user, settings: next as User["settings"] };
  };
  switch (cmd.kind) {
    case "duration":
      await updateSettings(ctx.db, user.id, { durationMin: cmd.minutes === DEFAULT_DURATION_MIN ? undefined : cmd.minutes });
      return done(withSettings({ durationMin: cmd.minutes }), "duration");
    case "reminders":
      await updateSettings(ctx.db, user.id, { reminders: cmd.minutes ?? undefined });
      return done(withSettings({ reminders: cmd.minutes ?? undefined }), "reminders");
    case "tg_reminder":
      await updateSettings(ctx.db, user.id, { tgReminderMin: cmd.minutes || undefined });
      await rescheduleUserReminders(ctx.db, user.id, now);
      return done(withSettings({ tgReminderMin: cmd.minutes || undefined }), "tgReminder");
    case "digest": {
      if (cmd.digest === "today") {
        const time = cmd.on ? (cmd.time ?? user.settings.digestTime ?? DEFAULT_DIGEST_TIME) : null;
        return done(await setDigest(ctx, user, time), "digest");
      }
      if (cmd.digest === "tomorrow") {
        await updateSettings(ctx.db, user.id, { tomorrowDigest: cmd.on || undefined });
        await rescheduleDigest(ctx.db, user.id, now);
        return done(withSettings({ tomorrowDigest: cmd.on || undefined }), "tomorrowDigest");
      }
      const week = cmd.on ? (cmd.day ?? user.settings.weekDigest ?? "sun") : undefined;
      await updateSettings(ctx.db, user.id, { weekDigest: week });
      await rescheduleDigest(ctx.db, user.id, now);
      return done(withSettings({ weekDigest: week }), "weekDigest");
    }
    case "language":
      await setLocale(ctx.db, user.id, cmd.locale);
      return done({ ...user, locale: cmd.locale }, "language");
    case "change_notify":
      await updateSettings(ctx.db, user.id, { changeNotifyOff: cmd.on ? undefined : true });
      return done(withSettings({ changeNotifyOff: cmd.on ? undefined : true }), "changeNotify");
    case "default_calendar": {
      const writable = calendars.filter((c) => c.writable);
      const cal = findCalendarByName(writable, cmd.name);
      if (!cal) return notFound(user, cmd.name, writable);
      await setDefaultCalendar(ctx.db, user.id, cal.id);
      return { text: t("settingsVoiceDone", l, { line: t("settingsCalendar", l, { value: escapeHtml(cal.title) }) }), saved: true };
    }
    case "alias": {
      const target = "text" in cmd ? splitAlias(calendars, cmd.text) : { cal: findCalendarByName(calendars, cmd.calendar), alias: cmd.alias };
      if (!target?.cal) return notFound(user, "text" in cmd ? cmd.text : cmd.calendar, calendars);
      const added = await addAliases(ctx.db, user.id, target.cal.id, [target.alias]);
      if (added.length === 0) return { text: t("settingsAliasEmpty", l), saved: false };
      return {
        text: t("settingsAliasesAdded", l, { name: escapeHtml(target.cal.title), aliases: `«${escapeHtml(added[0]!)}»`, first: escapeHtml(added[0]!) }),
        saved: true,
      };
    }
  }
}

/** «Family Budget семейный»: самое длинное начало, которое называет календарь, — остальное новое название. */
function splitAlias(calendars: CalendarInfo[], text: string): { cal: CalendarInfo; alias: string } | undefined {
  const words = text.split(/\s+/);
  for (let i = words.length - 1; i >= 1; i--) {
    const cal = findCalendarByName(calendars, words.slice(0, i).join(" "));
    if (cal) return { cal, alias: aliasForm(words.slice(i).join(" ")) };
  }
  return undefined;
}

function notFound(user: User, name: string, calendars: CalendarInfo[]): { text: string; saved: boolean } {
  const list = calendars.map((c) => `«${escapeHtml(c.title)}»`).join(", ");
  return { text: t("settingsVoiceNoCalendar", user.locale, { name: escapeHtml(name.slice(0, 60)), list }), saved: false };
}
