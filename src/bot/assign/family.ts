// «Для кого» и «ответственный» у события (US-92): подсказки из фразы при создании («Стоматолог Вани в четверг в 16,
// отводит папа»), строки карточки, подписи в списках и дайджестах («16:00 Стоматолог (Ваня) — отводит Дима»).
// Состав дома (участники и дети с другими именами) — loadHome.

import type { CalendarEvent, EventRef } from "../../calendar/model";
import { type Dependent, dependentsOf, getHousehold, type Household, type Member, membersOf, membershipOf } from "../../db/households";
import { familyMetaFor, setEventFamily } from "../../db/event-meta";
import type { AppContext } from "../context";
import { type Day, localToUtc, type Moment, utcToLocal } from "../../dates/calendar";
import { dateLabel, escapeHtml, hhmm } from "../format";
import { notifyMember } from "./notify";
import { t } from "../messages";
import { type EventFamily, type FamilyLabel, familyTitle, findMentioned, householdResponsible, type Named } from "./logic";

export type { EventFamily, FamilyLabel };

export type HomeMember = Member & Named;
export type HomeDependent = Dependent & Named;

export interface Home {
  household: Household;
  members: HomeMember[];
  dependents: HomeDependent[];
}

const named = <T extends { aliases: string[] }>(x: T, name: string): T & Named => ({ ...x, names: [name, ...x.aliases].filter(Boolean) });

/** Участники по имени — один порядок в карточках и предложениях. */
const byName = <T extends { displayName: string }>(list: T[]) => [...list].sort((a, b) => a.displayName.localeCompare(b.displayName, "ru"));

/** Дом пользователя с участниками и детьми; не в доме — null. */
export async function loadHome(db: D1Database, userId: string): Promise<Home | null> {
  const m = await membershipOf(db, userId);
  if (!m) return null;
  const [members, dependents] = await Promise.all([membersOf(db, m.household.id), dependentsOf(db, m.household.id)]);
  return {
    household: m.household,
    members: byName(members.map((x) => named(x, x.displayName))),
    dependents: dependents.map((d) => named(d, d.name)),
  };
}

/** Дом по id (задачи планировщика: автор мог уже выйти из дома). */
export async function homeById(db: D1Database, householdId: string): Promise<Home | null> {
  const household = await getHousehold(db, householdId);
  if (!household) return null;
  const [members, dependents] = await Promise.all([membersOf(db, household.id), dependentsOf(db, household.id)]);
  return {
    household,
    members: byName(members.map((x) => named(x, x.displayName))),
    dependents: dependents.map((d) => named(d, d.name)),
  };
}

export const memberName = (home: Home, userId: string | null): string => home.members.find((m) => m.userId === userId)?.displayName || "—";

/**
 * Создание события (US-92): «…, отводит папа» — ответственный по именам участников дома, ребёнок в названии — «для кого».
 * `remove` — кусок про ответственного: убрать из названия и из текста для дат. Не в доме — ничего.
 */
export async function familyHints(ctx: AppContext, userId: string, text: string): Promise<{ family?: EventFamily; remove: string[] }> {
  const home = await loadHome(ctx.db, userId);
  if (!home) return { remove: [] };
  const family: EventFamily = {};
  const resp = householdResponsible(text, home.members, home.dependents);
  if (resp) {
    if (resp.found.length === 1) {
      family.responsibleUserId = resp.found[0]!.userId;
      family.responsibleName = resp.found[0]!.displayName;
    } else family.unknownWho = resp.who;
  }
  const remove = resp?.remove ?? [];
  const kid = findMentioned(
    remove.reduce((s, r) => s.replace(r, " "), text),
    home.dependents,
  );
  if (kid) {
    family.forDependentId = kid.id;
    family.forName = kid.name;
  }
  return { ...(Object.keys(family).length ? { family } : {}), remove };
}

/** Строки карточки создания: «👤 Отводит: Дима», «🧒 Для: Ваня». */
export function familyCardLines(family: EventFamily | undefined, locale: string): string {
  if (!family) return "";
  const lines: string[] = [];
  if (family.responsibleName)
    lines.push(t(family.forName ? "famCardResponsible" : "famCardResponsibleOnly", locale, { name: escapeHtml(family.responsibleName) }));
  if (family.forName) lines.push(t("assignForWhom", locale, { name: escapeHtml(family.forName) }));
  if (family.unknownWho) lines.push(t("famWhoUnknown", locale, { who: escapeHtml(family.unknownWho) }));
  return lines.length ? `\n${lines.join("\n")}` : "";
}

export async function saveEventFamily(ctx: AppContext, ref: EventRef, family: EventFamily | undefined): Promise<void> {
  if (!family || (!family.responsibleUserId && !family.forDependentId)) return;
  await setEventFamily(ctx.db, ref, {
    ...(family.responsibleUserId ? { responsibleUserId: family.responsibleUserId } : {}),
    ...(family.forDependentId ? { forDependentId: family.forDependentId } : {}),
  });
}

/**
 * Подписи «для кого / ответственный» для списка событий (US-92, US-93) — участникам дома. Ответственный экземпляра серии
 * важнее ответственного за всю серию. Не в доме или меток нет — undefined.
 */
export async function familyLabeler(db: D1Database, userId: string, events: CalendarEvent[], locale: string): Promise<FamilyLabel | undefined> {
  if (events.length === 0) return undefined;
  const home = await loadHome(db, userId);
  if (!home) return undefined;
  const byCalendar = new Map<string, Set<string>>();
  for (const e of events) {
    const ids = byCalendar.get(e.ref.calendarId) ?? new Set<string>();
    ids.add(e.ref.providerEventId);
    if (e.seriesId) ids.add(e.seriesId);
    byCalendar.set(e.ref.calendarId, ids);
  }
  const meta = await familyMetaFor(
    db,
    [...byCalendar].map(([calendarId, ids]) => ({ calendarId, ids: [...ids] })),
  );
  if (meta.size === 0) return undefined;
  return (e) => {
    const own = meta.get(`${e.ref.calendarId}|${e.ref.providerEventId}`);
    const series = e.seriesId ? meta.get(`${e.ref.calendarId}|${e.seriesId}`) : undefined;
    const responsible = own?.responsibleUserId ?? series?.responsibleUserId ?? null;
    const kidId = own?.forDependentId ?? series?.forDependentId ?? null;
    const kid = kidId ? home.dependents.find((d) => d.id === kidId) : undefined;
    const person = responsible ? home.members.find((m) => m.userId === responsible) : undefined;
    if (!kid && !person) return undefined;
    const name = person?.displayName;
    const note = name ? t(kid ? "famLeads" : "famResponsible", locale, { name }) : undefined;
    return { title: kid ? familyTitle(e.title, kid) : e.title, ...(note ? { note } : {}) };
  };
}

/**
 * Ответственный за новое событие узнаёт лично (ревью R1 #9), если назначил не он сам: нейтрально, в своём поясе и на своём
 * языке. С ребёнком — «🚗 Отводите вы: Стоматолог (Ваня) — …», без — «👤 На вас: …».
 */
export async function notifyResponsible(
  ctx: AppContext,
  family: EventFamily | undefined,
  creatorId: string,
  o: { title: string; tz: string; allDay: boolean; startDay: Day; start?: Moment },
): Promise<void> {
  if (!family?.responsibleUserId || family.responsibleUserId === creatorId) return;
  const title = family.forName ? familyTitle(o.title, { name: family.forName, names: [family.forName] }) : o.title;
  await notifyMember(ctx, family.responsibleUserId, (v) => {
    const today = utcToLocal(ctx.clock.now(), v.tz).day;
    let when = dateLabel(o.startDay, today, v.locale);
    if (!o.allDay && o.start) {
      const local = utcToLocal(localToUtc(o.start, o.tz), v.tz);
      when = `${dateLabel(local.day, today, v.locale)} ${hhmm(local.minutes)}`;
    }
    return t(family.forName ? "famYouLead" : "famYouResponsible", v.locale, { title, when });
  }).catch((e) => console.warn("responsible notify failed", e instanceof Error ? e.message : e));
}
