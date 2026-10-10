// Ищем в коде, нечётко и с падежами (calendar/match.ts): параметр q Google для этого не годится.

import { queryWords, titleScore } from "../calendar/match";
import type { CalendarEvent, CalendarProvider } from "../calendar/model";
import { localToUtc, minutesBetween, utcToLocal } from "../dates/calendar";
import { mergeDialogState } from "../db/conversations";
import type { User } from "../db/users";
import type { AppContext } from "./context";
import { escapeHtml, hhmm, whenOf } from "./format";
import { t } from "./messages";

const LOOKUP_DAYS = 30;
const DAY_MS = 86_400_000;
const MAX_MATCHES = 3;

export interface LookupArgs {
  user: User;
  chatId: number;
  conversationId: string;
  // Нет — ближайшее событие вообще
  query?: string;
  next?: boolean;
}

export async function lookupEvent(ctx: AppContext, provider: CalendarProvider, a: LookupArgs): Promise<void> {
  const { user, chatId } = a;
  const locale = user.locale;
  const tz = user.tz;
  const nowUtc = ctx.clock.now();
  const now = utcToLocal(nowUtc, tz);
  const calendars = await provider.calendars();
  const defaultId = calendars.find((c) => c.isDefault)?.id;
  const label = (e: CalendarEvent) => (calendars.length > 1 && e.ref.calendarId !== defaultId ? ` · ${escapeHtml(e.calendarTitle)}` : "");
  const today = now.day;

  // Google отдаёт и уже идущие события (пересекающие интервал)
  const { events } = await provider.listEvents(nowUtc, localToUtc({ day: now.day + LOOKUP_DAYS, minutes: 0 }, tz), tz);
  const sortKey = (e: CalendarEvent) => (e.start ? localToUtc(e.start, tz) : e.startDay * DAY_MS);
  events.sort((x, y) => sortKey(x) - sortKey(y));

  const query = a.query && queryWords(a.query).length ? a.query : undefined;
  let shown: CalendarEvent[];
  let text: string;
  if (query) {
    const scored = events.map((e) => ({ e, s: titleScore(query, e.title) })).filter((x) => x.s > 0);
    const best = Math.max(0, ...scored.map((x) => x.s));
    shown = scored
      .filter((x) => x.s === best)
      .map((x) => x.e)
      .slice(0, a.next ? 1 : MAX_MATCHES);
    if (shown.length === 0) {
      await ctx.telegram.sendMessage(chatId, t("lookupNotFound", locale, { query: escapeHtml(query), days: String(LOOKUP_DAYS) }), undefined, { html: true });
      return;
    }
    const lines = shown.map((e) => `• ${whenOf(e, today, locale)} — <b>${escapeHtml(e.title)}</b>${label(e)}`);
    text = [t(shown.length === 1 ? "lookupFoundOne" : "lookupFound", locale), ...lines].join("\n");
  } else {
    const timed = events.filter((e) => !e.allDay);
    const running = timed.filter((e) => minutesBetween(e.start!, now) <= 0 && minutesBetween(e.end!, now) > 0);
    const next = timed.find((e) => minutesBetween(e.start!, now) > 0);
    const parts: string[] = [];
    for (const e of running) {
      parts.push(t("lookupRunning", locale, { title: escapeHtml(e.title), until: hhmm(e.end!.minutes) }) + label(e));
    }
    if (next) {
      const where = next.location ? `\n📍 ${escapeHtml(next.location)}` : "";
      parts.push(`${t("lookupNext", locale)}\n<b>${escapeHtml(next.title)}</b>${label(next)}\n🕒 ${whenOf(next, today, locale)}${where}`);
    } else {
      parts.push(t("lookupNoneAhead", locale, { days: String(LOOKUP_DAYS) }));
    }
    shown = next ? [next] : [];
    text = parts.join("\n\n");
  }

  const at = ctx.clock.now();
  await mergeDialogState(
    ctx.db,
    a.conversationId,
    user.id,
    {
      lastList: { refs: shown.map((e) => e.ref), at },
      ...(shown.length === 1 ? { lastEvent: { ref: shown[0]!.ref, at } } : {}),
      // Ответ показан — повтор вопроса голосом уже не сигнал «не понял»
      lastVoice: undefined,
    },
    at,
  );
  await ctx.telegram.sendMessage(chatId, text, undefined, { html: true });
}
