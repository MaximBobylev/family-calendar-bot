// Дом (US-90): участники, дети, общие календари, приглашения, привязка группового чата (US-94). Схема — ADR-0003,
// миграции 0001 и 0011. Пользователь состоит максимум в одном доме (уникальный индекс household_members_one_home).

export interface Household {
  id: string;
  name: string;
  ownerUserId: string;
}

export interface Membership {
  household: Household;
  role: "owner" | "adult";
  displayName: string;
  aliases: string[];
}

export interface Member {
  userId: string;
  role: "owner" | "adult";
  displayName: string;
  aliases: string[];
  telegramId: string | null;
  hasGoogle: boolean;
}

export interface Dependent {
  id: string;
  name: string;
  aliases: string[];
}

const parseAliases = (json: string | null): string[] => {
  try {
    const v = JSON.parse(json ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

export async function membershipOf(db: D1Database, userId: string): Promise<Membership | null> {
  const row = await db
    .prepare(
      `SELECT h.id, h.name, h.owner_user_id, m.role, m.display_name, m.aliases_json
       FROM household_members m
       JOIN households h ON h.id = m.household_id
       WHERE m.user_id = ?`,
    )
    .bind(userId)
    .first<{ id: string; name: string | null; owner_user_id: string; role: string; display_name: string | null; aliases_json: string }>();
  if (!row) return null;
  return {
    household: { id: row.id, name: row.name ?? "", ownerUserId: row.owner_user_id },
    role: row.role === "owner" ? "owner" : "adult",
    displayName: row.display_name ?? "",
    aliases: parseAliases(row.aliases_json),
  };
}

export async function getHousehold(db: D1Database, id: string): Promise<Household | null> {
  const h = await db
    .prepare("SELECT id, name, owner_user_id FROM households WHERE id = ?")
    .bind(id)
    .first<{ id: string; name: string | null; owner_user_id: string }>();
  return h ? { id: h.id, name: h.name ?? "", ownerUserId: h.owner_user_id } : null;
}

/** Участник какого-либо дома по Telegram id — доступ к боту без allowlist (приглашённые, ADR-0001 дополнение 2026-10-06). */
export async function isMemberByTelegramId(db: D1Database, telegramId: number): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1
       FROM channel_identities ci
       JOIN household_members m ON m.user_id = ci.user_id
       WHERE ci.channel = 'telegram' AND ci.external_id = ?`,
    )
    .bind(String(telegramId))
    .first();
  return row !== null;
}

export async function createHousehold(
  db: D1Database,
  a: { ownerId: string; name: string; ownerName: string; calendarIds: string[]; now: number },
): Promise<Household> {
  const id = crypto.randomUUID();
  await db.batch([
    db.prepare("INSERT INTO households (id, owner_user_id, name, created_at) VALUES (?, ?, ?, ?)").bind(id, a.ownerId, a.name, a.now),
    db
      .prepare("INSERT INTO household_members (household_id, user_id, role, display_name, joined_at) VALUES (?, ?, 'owner', ?, ?)")
      .bind(id, a.ownerId, a.ownerName, a.now),
    ...a.calendarIds.map((c) => db.prepare("INSERT INTO household_calendars (household_id, calendar_id) VALUES (?, ?)").bind(id, c)),
  ]);
  return { id, name: a.name, ownerUserId: a.ownerId };
}

export async function householdCalendarIds(db: D1Database, householdId: string): Promise<string[]> {
  const { results } = await db.prepare("SELECT calendar_id FROM household_calendars WHERE household_id = ?").bind(householdId).all<{ calendar_id: string }>();
  return results.map((r) => r.calendar_id);
}

/** Включить/выключить общий календарь дома; только календарь самого владельца. Возвращает новое состояние или null. */
export async function toggleHouseholdCalendar(db: D1Database, household: Household, calendarId: string): Promise<boolean | null> {
  const owned = await db
    .prepare(
      `SELECT 1
       FROM calendars c
       JOIN provider_accounts a ON a.id = c.account_id
       WHERE c.id = ? AND a.user_id = ?`,
    )
    .bind(calendarId, household.ownerUserId)
    .first();
  if (!owned) return null;
  const removed = await db.prepare("DELETE FROM household_calendars WHERE household_id = ? AND calendar_id = ?").bind(household.id, calendarId).run();
  if ((removed.meta.changes ?? 0) > 0) return false;
  await db.prepare("INSERT OR IGNORE INTO household_calendars (household_id, calendar_id) VALUES (?, ?)").bind(household.id, calendarId).run();
  return true;
}

/**
 * Основной общий календарь дома (ревью R1, блокер 2): куда записываются события участников. Выбранный владельцем, если
 * он ещё общий; иначе — общий с правом записи, не основной (личный) календарь владельца, по названию. Нет общих — null.
 */
export async function householdDefaultCalendar(db: D1Database, householdId: string): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT c.id
       FROM household_calendars hc
       JOIN households h ON h.id = hc.household_id
       JOIN calendars c ON c.id = hc.calendar_id
       WHERE hc.household_id = ?
       ORDER BY (c.id = h.default_calendar_id) DESC, c.writable DESC, c.is_default ASC, c.title
       LIMIT 1`,
    )
    .bind(householdId)
    .first<{ id: string }>();
  return row?.id ?? null;
}

/** Сделать общий календарь основным для дома; только уже общий календарь. */
export async function setHouseholdDefaultCalendar(db: D1Database, householdId: string, calendarId: string): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE households SET default_calendar_id = ?2
       WHERE id = ?1 AND EXISTS (SELECT 1 FROM household_calendars WHERE household_id = ?1 AND calendar_id = ?2)`,
    )
    .bind(householdId, calendarId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** Задать имя и другие имена участника дома (владелец — любому, участник — себе). false — такого участника нет. */
export async function setMemberNameOf(db: D1Database, householdId: string, userId: string, name: string, aliases: string[]): Promise<boolean> {
  const res = await db
    .prepare("UPDATE household_members SET display_name = ?, aliases_json = ? WHERE household_id = ? AND user_id = ?")
    .bind(name, JSON.stringify(aliases), householdId, userId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** Добавить другое имя участнику («муж» — Ивану), если его ещё нет. */
export async function addMemberAlias(db: D1Database, householdId: string, userId: string, alias: string): Promise<void> {
  await db
    .prepare(
      `UPDATE household_members
       SET aliases_json = json_insert(aliases_json, '$[#]', ?3)
       WHERE household_id = ?1 AND user_id = ?2
         AND NOT EXISTS (SELECT 1 FROM json_each(aliases_json) j WHERE lower(j.value) = lower(?3))
         AND lower(coalesce(display_name, '')) <> lower(?3)`,
    )
    .bind(householdId, userId, alias)
    .run();
}

export async function membersOf(db: D1Database, householdId: string): Promise<Member[]> {
  const { results } = await db
    .prepare(
      `SELECT m.user_id, m.role, m.display_name, m.aliases_json,
              (SELECT ci.external_id FROM channel_identities ci WHERE ci.user_id = m.user_id AND ci.channel = 'telegram') AS telegram_id,
              EXISTS (SELECT 1 FROM provider_accounts a WHERE a.user_id = m.user_id AND a.provider = 'google') AS has_google
       FROM household_members m
       WHERE m.household_id = ?
       ORDER BY m.role = 'owner' DESC, m.joined_at`,
    )
    .bind(householdId)
    .all<{ user_id: string; role: string; display_name: string | null; aliases_json: string; telegram_id: string | null; has_google: number }>();
  return results.map((r) => ({
    userId: r.user_id,
    role: r.role === "owner" ? "owner" : "adult",
    displayName: r.display_name ?? "",
    aliases: parseAliases(r.aliases_json),
    telegramId: r.telegram_id,
    hasGoogle: r.has_google === 1,
  }));
}

export async function setMemberName(db: D1Database, householdId: string, userId: string, name: string, aliases: string[]): Promise<void> {
  await db
    .prepare("UPDATE household_members SET display_name = ?, aliases_json = ? WHERE household_id = ? AND user_id = ?")
    .bind(name, JSON.stringify(aliases), householdId, userId)
    .run();
}

export async function addMember(db: D1Database, a: { householdId: string; userId: string; name: string; aliases: string[]; now: number }): Promise<void> {
  await db
    .prepare("INSERT INTO household_members (household_id, user_id, role, display_name, aliases_json, joined_at) VALUES (?, ?, 'adult', ?, ?, ?)")
    .bind(a.householdId, a.userId, a.name, JSON.stringify(a.aliases), a.now)
    .run();
}

/** Убрать участника (не владельца). Возвращает, был ли он в доме. */
export async function removeMember(db: D1Database, householdId: string, userId: string): Promise<boolean> {
  const res = await db.prepare("DELETE FROM household_members WHERE household_id = ? AND user_id = ? AND role <> 'owner'").bind(householdId, userId).run();
  return (res.meta.changes ?? 0) > 0;
}

export async function memberCount(db: D1Database, householdId: string): Promise<number> {
  const row = await db.prepare("SELECT count(*) AS n FROM household_members WHERE household_id = ?").bind(householdId).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function dependentsOf(db: D1Database, householdId: string): Promise<Dependent[]> {
  const { results } = await db
    .prepare("SELECT id, name, aliases_json FROM dependents WHERE household_id = ? ORDER BY name")
    .bind(householdId)
    .all<{ id: string; name: string; aliases_json: string }>();
  return results.map((r) => ({ id: r.id, name: r.name, aliases: parseAliases(r.aliases_json) }));
}

/** Добавить ребёнка; тот же имя — обновить другие имена. */
export async function upsertDependent(db: D1Database, householdId: string, name: string, aliases: string[]): Promise<void> {
  const existing = await db
    .prepare("SELECT id FROM dependents WHERE household_id = ? AND lower(name) = lower(?)")
    .bind(householdId, name)
    .first<{ id: string }>();
  if (existing) {
    await db.prepare("UPDATE dependents SET name = ?, aliases_json = ? WHERE id = ?").bind(name, JSON.stringify(aliases), existing.id).run();
    return;
  }
  await db
    .prepare("INSERT INTO dependents (id, household_id, name, aliases_json) VALUES (?, ?, ?, ?)")
    .bind(crypto.randomUUID(), householdId, name, JSON.stringify(aliases))
    .run();
}

export async function removeDependent(db: D1Database, householdId: string, id: string): Promise<string | null> {
  const row = await db.prepare("DELETE FROM dependents WHERE id = ? AND household_id = ? RETURNING name").bind(id, householdId).first<{ name: string }>();
  return row?.name ?? null;
}

// --- Приглашения ----------------------------------------------------------------

export async function createInvite(
  db: D1Database,
  a: { code: string; householdId: string; createdBy: string; preset: string[]; now: number; ttlMs: number },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO household_invites (code, household_id, created_by, aliases_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(a.code, a.householdId, a.createdBy, JSON.stringify(a.preset), a.now, a.now + a.ttlMs)
    .run();
}

/** Действующее приглашение — не «гасит» его (проверка до регистрации постороннего). */
export async function peekInvite(db: D1Database, code: string, now: number): Promise<Household | null> {
  const row = await db
    .prepare(
      `SELECT h.id, h.name, h.owner_user_id
       FROM household_invites i
       JOIN households h ON h.id = i.household_id
       WHERE i.code = ? AND i.used_at IS NULL AND i.expires_at > ?`,
    )
    .bind(code, now)
    .first<{ id: string; name: string | null; owner_user_id: string }>();
  return row ? { id: row.id, name: row.name ?? "", ownerUserId: row.owner_user_id } : null;
}

/** Одноразово «гасит» приглашение. null — уже использовано, истекло или неизвестно. */
export async function consumeInvite(db: D1Database, code: string, userId: string, now: number): Promise<{ householdId: string; preset: string[] } | null> {
  const row = await db
    .prepare(
      `UPDATE household_invites
       SET used_at = ?, used_by = ?
       WHERE code = ? AND used_at IS NULL AND expires_at > ?
       RETURNING household_id, aliases_json`,
    )
    .bind(now, userId, code, now)
    .first<{ household_id: string; aliases_json: string }>();
  return row ? { householdId: row.household_id, preset: parseAliases(row.aliases_json) } : null;
}

// --- Распустить дом, групповые чаты ------------------------------------------------

/**
 * Распустить дом (владелец так решил или отключил бота, US-03): чаты отвязываются, участники, дети, календари дома
 * и приглашения удаляются. Явно по таблицам — не полагаясь только на ON DELETE CASCADE.
 */
export function dissolveStatements(db: D1Database, householdIdsSql: string, param: string): D1PreparedStatement[] {
  return [
    db.prepare(`UPDATE conversations SET household_id = NULL WHERE household_id IN (${householdIdsSql})`).bind(param),
    db.prepare(`DELETE FROM household_invites WHERE household_id IN (${householdIdsSql})`).bind(param),
    db.prepare(`DELETE FROM household_calendars WHERE household_id IN (${householdIdsSql})`).bind(param),
    db.prepare(`DELETE FROM dependents WHERE household_id IN (${householdIdsSql})`).bind(param),
    db.prepare(`DELETE FROM assignment_messages WHERE assignment_id IN (SELECT id FROM assignments WHERE household_id IN (${householdIdsSql}))`).bind(param),
    db.prepare(`DELETE FROM assignments WHERE household_id IN (${householdIdsSql})`).bind(param),
    db.prepare(`DELETE FROM household_members WHERE household_id IN (${householdIdsSql})`).bind(param),
  ];
}

export async function dissolveHousehold(db: D1Database, householdId: string): Promise<void> {
  await db.batch([...dissolveStatements(db, "?1", householdId), db.prepare("DELETE FROM households WHERE id = ?1").bind(householdId)]);
}

export async function householdOfConversation(db: D1Database, conversationId: string): Promise<Household | null> {
  const row = await db
    .prepare(
      `SELECT h.id, h.name, h.owner_user_id
       FROM conversations c
       JOIN households h ON h.id = c.household_id
       WHERE c.id = ?`,
    )
    .bind(conversationId)
    .first<{ id: string; name: string | null; owner_user_id: string }>();
  return row ? { id: row.id, name: row.name ?? "", ownerUserId: row.owner_user_id } : null;
}

export async function linkConversation(db: D1Database, conversationId: string, householdId: string | null): Promise<void> {
  await db.prepare("UPDATE conversations SET household_id = ? WHERE id = ?").bind(householdId, conversationId).run();
}

/** Групповые чаты дома — для уведомлений (распущен дом). */
export async function householdGroupChats(db: D1Database, householdId: string): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT chat_id FROM conversations WHERE household_id = ? AND kind = 'group'")
    .bind(householdId)
    .all<{ chat_id: string }>();
  return results.map((r) => r.chat_id);
}

/** Автор и разговор карточки — нажатие в группе может сделать любой взрослый дома (US-94). */
export async function cardOwner(db: D1Database, actionId: string): Promise<{ userId: string; conversationId: string } | null> {
  const row = await db
    .prepare("SELECT user_id, conversation_id FROM pending_actions WHERE id = ?")
    .bind(actionId)
    .first<{ user_id: string; conversation_id: string }>();
  return row ? { userId: row.user_id, conversationId: row.conversation_id } : null;
}

/** Участник без своего Google живёт в поясе владельца дома (иначе — UTC по умолчанию). */
export async function adoptOwnerTimezone(db: D1Database, userId: string, ownerUserId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE users
       SET home_tz = (SELECT home_tz FROM users WHERE id = ?1)
       WHERE id = ?2 AND NOT EXISTS (SELECT 1 FROM provider_accounts WHERE user_id = ?2)`,
    )
    .bind(ownerUserId, userId)
    .run();
}

/** Кто создал событие через бота (EventMeta, ADR-0003): видно участникам дома. */
export async function recordEventCreator(
  db: D1Database,
  ref: { accountId: string; calendarId: string; providerEventId: string },
  userId: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO event_meta (account_id, calendar_id, event_id, created_by_user_id)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (account_id, calendar_id, event_id) DO UPDATE SET created_by_user_id = excluded.created_by_user_id`,
    )
    .bind(ref.accountId, ref.calendarId, ref.providerEventId, userId)
    .run();
}
