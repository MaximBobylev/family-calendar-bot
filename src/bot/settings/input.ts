// /settings: ввод текстом через awaiting в диалоге — пояс («Другой…»), время сводки, другие названия календаря (US-06).

import { parseHhmm } from "../../dates/daily";
import { parseTimeZone } from "../../dates/timezone";
import { rescheduleDigest } from "../../jobs/digest";
import { recordFeature } from "../../db/features";
import { addAliases, setHomeTz } from "../../db/settings";
import type { User } from "../../db/users";
import type { AppContext } from "../context";
import { hhmm } from "../format";
import { t } from "../messages";
import { calendarsOf, setDigest } from "./common";
import { nowIn } from "./screens";

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
    await recordFeature(ctx.db, user.id, "settings", ctx.clock.now());
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
    await recordFeature(ctx.db, user.id, "settings", ctx.clock.now());
    return true;
  }
  const cal = (await calendarsOf(ctx, user)).find((c) => c.id === awaiting.calendarId);
  const added = cal ? await addAliases(ctx.db, user.id, cal.id, parts) : [];
  if (!cal || added.length === 0) {
    await ctx.telegram.sendMessage(chatId, t("settingsAliasEmpty", l));
    return true;
  }
  await ctx.telegram.sendMessage(chatId, t("settingsAliasesAdded", l, { name: cal.title, aliases: added.map((a) => `«${a}»`).join(", "), first: added[0]! }));
  await recordFeature(ctx.db, user.id, ["settings", "alias"], ctx.clock.now());
  return true;
}
