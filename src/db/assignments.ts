// Поручения (US-91, ADR-0003 Assignment): строки assignments, сообщения с кнопками (assignment_messages) и задачи
// напоминаний/эскалации в scheduled_jobs (kind = assign, dedupe_key «assign:<id>:<что>:<момент>»). Миграции 0001, 0014.

import type { AssignJobWhat } from "../bot/assign/logic";

export type AssignmentStatus = "pending" | "accepted" | "declined" | "done" | "expired" | "cancelled";

export interface Assignment {
  id: string;
  householdId: string;
  title: string;
  /** null — «кто-то должен»: ещё никто не взял. */
  assigneeUserId: string | null;
  createdBy: string;
  dueAt: number | null;
  dueHasTime: boolean;
  status: AssignmentStatus;
  forDependentId: string | null;
  originChatId: string | null;
  event: { accountId: string; calendarId: string; providerEventId: string } | null;
  /** Связанное событие: название (есть eventStartAt) или готовая подпись «Плавание Вани, сб 10:00» (старые строки, весь день). */
  eventLabel: string | null;
  /** Начало связанного события (UTC, мс) — подпись строится при показе в поясе получателя (QA-03/04/05). */
  eventStartAt: number | null;
}

export const ASSIGN_JOB = "assign";
/** Открытые — ждут ответа или взяты. */
export const OPEN_STATUSES: AssignmentStatus[] = ["pending", "accepted"];

type Row = {
  id: string;
  household_id: string;
  title: string;
  assignee_user_id: string | null;
  created_by: string;
  due_at: number | null;
  due_has_time: number;
  status: string;
  for_dependent_id: string | null;
  origin_chat_id: string | null;
  event_account_id: string | null;
  event_calendar_id: string | null;
  event_id: string | null;
  event_label: string | null;
  event_start_at: number | null;
};

const COLUMNS =
  "id, household_id, title, assignee_user_id, created_by, due_at, due_has_time, status, for_dependent_id, origin_chat_id, event_account_id, event_calendar_id, event_id, event_label, event_start_at";

function fromRow(r: Row): Assignment {
  return {
    id: r.id,
    householdId: r.household_id,
    title: r.title,
    assigneeUserId: r.assignee_user_id,
    createdBy: r.created_by,
    dueAt: r.due_at,
    dueHasTime: r.due_has_time === 1,
    status: r.status as AssignmentStatus,
    forDependentId: r.for_dependent_id,
    originChatId: r.origin_chat_id,
    event:
      r.event_account_id && r.event_calendar_id && r.event_id
        ? { accountId: r.event_account_id, calendarId: r.event_calendar_id, providerEventId: r.event_id }
        : null,
    eventLabel: r.event_label,
    eventStartAt: r.event_start_at,
  };
}

export async function insertAssignment(db: D1Database, a: Omit<Assignment, "id" | "status">, now: number): Promise<Assignment> {
  const id = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  await db
    .prepare(
      `INSERT INTO assignments (id, household_id, title, assignee_user_id, created_by, due_at, due_has_time, status, for_dependent_id, origin_chat_id,
                                event_account_id, event_calendar_id, event_id, event_label, event_start_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      a.householdId,
      a.title,
      a.assigneeUserId,
      a.createdBy,
      a.dueAt,
      a.dueHasTime ? 1 : 0,
      a.forDependentId,
      a.originChatId,
      a.event?.accountId ?? null,
      a.event?.calendarId ?? null,
      a.event?.providerEventId ?? null,
      a.eventLabel,
      a.eventStartAt,
      now,
      now,
    )
    .run();
  return { ...a, id, status: "pending" };
}

export async function getAssignment(db: D1Database, id: string): Promise<Assignment | null> {
  const row = await db.prepare(`SELECT ${COLUMNS} FROM assignments WHERE id = ?`).bind(id).first<Row>();
  return row ? fromRow(row) : null;
}

/**
 * Атомарный переход статуса: только из `from` и (если задано) у этого исполнителя; «кто-то должен» — взять может любой
 * (assignee NULL → он). Возвращает новое состояние или null, если кто-то успел раньше (гонка «Беру»).
 */
export async function transition(
  db: D1Database,
  id: string,
  a: { from: AssignmentStatus[]; to: AssignmentStatus; assignee?: string | null; requireAssignee?: string; now: number },
): Promise<Assignment | null> {
  const setAssignee = a.assignee !== undefined;
  const row = await db
    .prepare(
      `UPDATE assignments
       SET status = ?1, updated_at = ?2${setAssignee ? ", assignee_user_id = ?5" : ""}
       WHERE id = ?3 AND status IN (${a.from.map((s) => `'${s}'`).join(",")})
         AND (?4 IS NULL OR assignee_user_id = ?4 OR assignee_user_id IS NULL)
       RETURNING ${COLUMNS}`,
    )
    .bind(a.to, a.now, id, a.requireAssignee ?? null, ...(setAssignee ? [a.assignee] : []))
    .first<Row>();
  return row ? fromRow(row) : null;
}

/** Новый срок; время связанного события сдвигается на ту же величину (перенос события, QA-03). */
export async function setAssignmentDue(db: D1Database, id: string, dueAt: number, deltaMs: number, now: number): Promise<void> {
  await db.prepare("UPDATE assignments SET due_at = ?, event_start_at = event_start_at + ?, updated_at = ? WHERE id = ?").bind(dueAt, deltaMs, now, id).run();
}

/** Открытые поручения на участнике и созданные им (уход из дома, удаление данных — QA-06/07). */
export async function openAssignmentsInvolving(db: D1Database, householdId: string, userId: string): Promise<Assignment[]> {
  const { results } = await db
    .prepare(
      `SELECT ${COLUMNS} FROM assignments
       WHERE household_id = ?1 AND status IN ('pending', 'accepted', 'declined') AND (assignee_user_id = ?2 OR created_by = ?2)`,
    )
    .bind(householdId, userId)
    .all<Row>();
  return results.map(fromRow);
}

/** Открытые поручения дома (роспуск — обновить сообщения, QA-15). */
export async function openAssignmentsOfHousehold(db: D1Database, householdId: string): Promise<Assignment[]> {
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM assignments WHERE household_id = ? AND status IN ('pending', 'accepted', 'declined')`)
    .bind(householdId)
    .all<Row>();
  return results.map(fromRow);
}

/** Поручения, созданные автором и ещё не закрытые (US-91: «что я поручил»), — новые сроки первыми по порядку. */
export async function assignmentsCreatedBy(db: D1Database, userId: string, householdId: string): Promise<Assignment[]> {
  const { results } = await db
    .prepare(
      `SELECT ${COLUMNS} FROM assignments
       WHERE household_id = ? AND created_by = ? AND status IN ('pending', 'accepted', 'declined')
       ORDER BY due_at IS NULL, due_at, created_at`,
    )
    .bind(householdId, userId)
    .all<Row>();
  return results.map(fromRow);
}

/**
 * Поручение, на которое отвечают словом («Беру», «Не могу», «Сделано», ревью R1 #7): по сообщению (reply) или последнее
 * с предложением этому участнику в этом чате — в подходящих статусах.
 */
export async function assignmentForTextAnswer(
  db: D1Database,
  a: { userId: string; chatId: string; replyTo?: number; statuses: AssignmentStatus[] },
): Promise<Assignment | null> {
  const statuses = a.statuses.map((s) => `'${s}'`).join(",");
  const row = await db
    .prepare(
      `SELECT ${COLUMNS.split(", ")
        .map((c) => `x.${c}`)
        .join(", ")}
       FROM assignments x
       JOIN assignment_messages m ON m.assignment_id = x.id
       WHERE m.chat_id = ?1 AND x.status IN (${statuses})
         AND (x.assignee_user_id = ?2 OR (x.assignee_user_id IS NULL AND m.user_id = ?2 AND m.answer IS NULL) OR m.role = 'group')
         AND (?3 IS NULL OR m.message_id = ?3)
         AND (?3 IS NOT NULL OR m.role = 'offer')
       ORDER BY coalesce(x.updated_at, x.created_at) DESC
       LIMIT 1`,
    )
    .bind(a.chatId, a.userId, a.replyTo ?? null)
    .first<Row>();
  return row ? fromRow(row) : null;
}

/** Открытые поручения участнику (US-91: «мои дела»); с открытыми «кто-то должен» его дома. */
export async function openAssignmentsFor(db: D1Database, userId: string, householdId: string): Promise<Assignment[]> {
  const { results } = await db
    .prepare(
      `SELECT ${COLUMNS} FROM assignments
       WHERE household_id = ?2 AND status IN ('pending', 'accepted')
         AND (assignee_user_id = ?1 OR (assignee_user_id IS NULL AND created_by <> ?1))
       ORDER BY due_at IS NULL, due_at, created_at`,
    )
    .bind(userId, householdId)
    .all<Row>();
  return results.map(fromRow);
}

/** Открытые поручения, связанные с событием (перенос события сдвигает их, US-91). */
export async function openAssignmentsForEvent(db: D1Database, ref: { calendarId: string; providerEventId: string }): Promise<Assignment[]> {
  const { results } = await db
    .prepare(
      // Тот же календарь Google может быть подключён у нескольких (свой аккаунт и дом) — сравниваем календарь провайдера
      `SELECT ${COLUMNS} FROM assignments
       WHERE event_id = ?1 AND status IN ('pending', 'accepted')
         AND (event_calendar_id = ?2
           OR event_calendar_id IN (SELECT c.id FROM calendars c JOIN calendars r ON r.provider_calendar_id = c.provider_calendar_id WHERE r.id = ?2))`,
    )
    .bind(ref.providerEventId, ref.calendarId)
    .all<Row>();
  return results.map(fromRow);
}

/** То же по событию календаря провайдера (синк Google, US-72): связь хранит id календаря автора — ищем через calendars. */
export async function openAssignmentsForProviderEvent(db: D1Database, providerCalendarId: string, eventId: string): Promise<Assignment[]> {
  const { results } = await db
    .prepare(
      `SELECT ${COLUMNS} FROM assignments
       WHERE event_id = ? AND status IN ('pending', 'accepted')
         AND event_calendar_id IN (SELECT id FROM calendars WHERE provider_calendar_id = ?)`,
    )
    .bind(eventId, providerCalendarId)
    .all<Row>();
  return results.map(fromRow);
}

// --- Сообщения с кнопками ---------------------------------------------------------------

export interface AssignmentMessage {
  chatId: string;
  messageId: number;
  userId: string | null;
  role: "offer" | "author" | "group";
  answer: string | null;
}

export async function addAssignmentMessage(db: D1Database, assignmentId: string, m: Omit<AssignmentMessage, "answer">): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO assignment_messages (assignment_id, chat_id, message_id, user_id, role) VALUES (?, ?, ?, ?, ?)")
    .bind(assignmentId, m.chatId, m.messageId, m.userId, m.role)
    .run();
}

export async function assignmentMessages(db: D1Database, assignmentId: string): Promise<AssignmentMessage[]> {
  const { results } = await db
    .prepare("SELECT chat_id, message_id, user_id, role, answer FROM assignment_messages WHERE assignment_id = ? ORDER BY rowid")
    .bind(assignmentId)
    .all<{ chat_id: string; message_id: number; user_id: string | null; role: string; answer: string | null }>();
  return results.map((r) => ({ chatId: r.chat_id, messageId: r.message_id, userId: r.user_id, role: r.role as AssignmentMessage["role"], answer: r.answer }));
}

/** «Не могу» одного из предложенных («кто-то должен»): отметка у его сообщений. */
export async function markOfferAnswer(db: D1Database, assignmentId: string, userId: string, answer: string): Promise<void> {
  await db
    .prepare("UPDATE assignment_messages SET answer = ? WHERE assignment_id = ? AND user_id = ? AND role = 'offer'")
    .bind(answer, assignmentId, userId)
    .run();
}

/** Предложили заново («Предложить другому» → «Всем»): прежние «Не могу» не в счёт. */
export async function clearOfferAnswers(db: D1Database, assignmentId: string): Promise<void> {
  await db.prepare("UPDATE assignment_messages SET answer = NULL WHERE assignment_id = ?").bind(assignmentId).run();
}

// --- Задачи напоминаний ------------------------------------------------------------------

const jobPrefix = (id: string) => `${ASSIGN_JOB}:${id}:`;

/** Снять ожидающие напоминания поручения (отмена, перенос, сделано). Диапазон по dedupe_key — по индексу. */
export async function cancelAssignmentJobs(db: D1Database, id: string): Promise<void> {
  const p = jobPrefix(id);
  await db.prepare("UPDATE scheduled_jobs SET status = 'cancelled' WHERE dedupe_key >= ? AND dedupe_key < ? AND status = 'pending'").bind(p, `${p}￿`).run();
}

export async function scheduleAssignmentJobs(db: D1Database, id: string, plan: { what: AssignJobWhat; fireAt: number }[]): Promise<void> {
  if (plan.length === 0) return;
  await db.batch(
    plan.map((p) =>
      db
        .prepare(
          `INSERT INTO scheduled_jobs (id, kind, user_id, fire_at, payload_json, status, dedupe_key)
           VALUES (?, ?, NULL, ?, ?, 'pending', ?)
           ON CONFLICT (dedupe_key) DO UPDATE SET status = 'pending' WHERE status = 'cancelled'`,
        )
        .bind(crypto.randomUUID(), ASSIGN_JOB, p.fireAt, JSON.stringify({ assignmentId: id, what: p.what }), `${jobPrefix(id)}${p.what}:${p.fireAt}`),
    ),
  );
}

/** Поручения участнику на период — для дайджеста (US-93). */
export async function assignmentsDueBetween(db: D1Database, userId: string, fromUtc: number, toUtc: number): Promise<Assignment[]> {
  const { results } = await db
    .prepare(
      `SELECT ${COLUMNS} FROM assignments
       WHERE assignee_user_id = ? AND status IN ('pending', 'accepted') AND due_at >= ? AND due_at < ?
       ORDER BY due_at`,
    )
    .bind(userId, fromUtc, toUtc)
    .all<Row>();
  return results.map(fromRow);
}
