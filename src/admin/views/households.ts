// Дома (US-90/94; docs/admin-console.md, итерация 3): список и карточка дома — только псевдонимы и счётчики.
// Название дома, имена участников и детей, коды приглашений и id чатов сюда не попадают (их нет и в запросах).

import type { HouseholdRow, InviteCounts } from "../queries";
import { esc, fmtTime, raw, table } from "./layout";

export const ROLE_LABELS: Record<string, string> = { owner: "владелец", adult: "взрослый", participant: "участник" };

const roleLabel = (role: string) => ROLE_LABELS[role] ?? role;
const yesNo = (v: number | boolean) => (v ? "да" : "нет");
const userLink = (u: string) => raw(`<a href="/admin/journal?u=${encodeURIComponent(u)}">${esc(u)}</a>`);

export type HouseholdListItem = HouseholdRow & { owner: string };

export function householdsBody(items: HouseholdListItem[]): string {
  const sum = (f: (h: HouseholdRow) => number) => items.reduce((a, h) => a + f(h), 0);
  return `<h1>Дома</h1>
<p class="muted">Без названий и имён: владелец и участники — псевдонимы, чаты — c-xxxxxx, приглашения — только счётчики.</p>
<div class="cards">
  <div class="card">Домов<b>${items.length}</b></div>
  <div class="card">Участников<b>${sum((h) => h.members)}</b></div>
  <div class="card">Без Google<b>${sum((h) => h.members - h.with_google)}</b></div>
  <div class="card">Детей<b>${sum((h) => h.dependents)}</b></div>
  <div class="card">Групповых чатов<b>${sum((h) => h.group_chats)}</b></div>
</div>
${table(
  ["Дом (владелец)", "Участников", "С Google / без", "Детей", "Групповых чатов", "Общих календарей", "Активных приглашений", "Создан"],
  items.map((h) => [
    raw(`<a href="/admin/households/${encodeURIComponent(h.id)}">${esc(h.owner)}</a>`),
    h.members,
    `${h.with_google} / ${h.members - h.with_google}`,
    h.dependents,
    h.group_chats,
    h.calendars,
    h.invites_active,
    fmtTime(h.created_at),
  ]),
  "домов нет",
)}`;
}

export interface HouseholdDetailView {
  household: HouseholdListItem;
  members: { user: string; role: string; hasGoogle: boolean; joinedAt: number }[];
  invites: InviteCounts;
  chats: string[];
  /**
   * Дополнительные секции карточки дома (готовый HTML). Место для поручений US-91/92/93: счётчики assignments
   * по статусам — запрос в queries.ts, секция — сюда (без названий поручений: это текст пользователя).
   */
  sections: { title: string; html: string }[];
}

export function householdDetailBody(v: HouseholdDetailView): string {
  const h = v.household;
  return `<p><a href="/admin/households">← Дома</a></p>
<h1>Дом владельца ${esc(h.owner)}</h1>
<p class="muted">Создан ${fmtTime(h.created_at)}. Название дома, имена участников и детей не показываются.</p>
<div class="cards">
  <div class="card">Участников<b>${h.members}</b></div>
  <div class="card">С Google / без<b>${h.with_google} / ${h.members - h.with_google}</b></div>
  <div class="card">Детей<b>${h.dependents}</b></div>
  <div class="card">Общих календарей<b>${h.calendars}</b></div>
</div>
<h2>Участники</h2>
${table(
  ["Участник", "Роль", "Google", "Присоединился"],
  v.members.map((m) => [userLink(m.user), roleLabel(m.role), yesNo(m.hasGoogle), fmtTime(m.joinedAt)]),
  "участников нет",
)}
<h2>Приглашения</h2>
${table(["Активные", "Использованы", "Истекли"], [[v.invites.active, v.invites.used, v.invites.expired]])}
<p class="muted">Коды приглашений не показываются: код — это доступ в дом.</p>
<h2>Групповые чаты</h2>
${table(
  ["Чат"],
  v.chats.map((c) => [c]),
  "не привязаны",
)}
${v.sections.map((s) => `<h2>${esc(s.title)}</h2>\n${s.html}`).join("\n")}`;
}
