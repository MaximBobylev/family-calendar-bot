// Одна подписка на календарь провайдера, читается токеном одного из подключивших его («владельца»). Инкрементально
// по syncToken; 410 — полный синк окна со сверкой со снимками. С push — сверка раз в сутки, без push — опрос.

import { cancelAssignmentsForProviderEvent, shiftAssignmentsForProviderEvent } from "../bot/assign/answers";
import type { AppContext } from "../bot/context";
import { GoogleCalendarProvider } from "../calendar/google-provider";
import { AuthRevoked, EventGone, PermissionDenied } from "../calendar/model";
import {
  acquireLease,
  botWritesFor,
  channelsOwnedBy,
  chatsForCalendar,
  deleteSnapshots,
  dropSync,
  ensureSyncRows,
  getSyncRow,
  orphanSyncs,
  pickOwner,
  pruneNotices,
  pruneStatements,
  releaseLease,
  snapshotsBetween,
  snapshotEtags,
  snapshotsByIds,
  updateSyncRow,
  upsertSnapshots,
  type BotWriteRow,
  type SyncRow,
} from "../db/sync";
import { SyncTokenExpired, type SyncPage } from "../google/calendar-api";
import { errorClass, log } from "../log";
import type { DueJob } from "../scheduler";
import { DAY_MS, diffEvent, isActive, MINUTE_MS, snapshotOf, type ChangeKind, type Snapshot } from "./logic";
import { notifyChanges, type Change } from "./notify";
import { extendReminders, reminderStatements, reminderUsers } from "./reminders";

export const SYNC_JOB = "cal_sync";
export const PUSH_SYNC_JOB = "cal_push";
export const WATCH_RENEW_JOB = "watch_renew";

const WINDOW_PAST_MS = DAY_MS;
const WINDOW_FUTURE_MS = 60 * DAY_MS;
const POLL_ACTIVE_MS = 5 * MINUTE_MS;
const POLL_IDLE_MS = 15 * MINUTE_MS;
const ACTIVE_FOR_MS = DAY_MS;
// Страховка от потерянных push и сдвиг горизонта напоминаний.
const RECONCILE_MS = DAY_MS;
// У Google по умолчанию столько же.
const CHANNEL_TTL_MS = 7 * DAY_MS;
const RENEW_BEFORE_MS = DAY_MS;
const LEASE_MS = 2 * MINUTE_MS;
// Экземпляры серии приходят синком позже записи бота в серию — в этом интервале они приписываются боту.
const ATTRIBUTION_MS = 10 * MINUTE_MS;
const PUSH_COALESCE_MS = 15_000;

export const PUSH_PATH = "/google/push";

// Правка через бота: в chatId и автору в личный чат эхо этой правки не шлём.
export interface Origin {
  chatId: string;
  authorName?: string;
  authorUserId?: string;
}

// after = null — удалено; hint — что сделал бот, если прежнего снимка нет.
export interface Entry {
  eventId: string;
  after: Snapshot | null;
  hint?: ChangeKind;
  origin?: Origin;
}

function attribute(writes: BotWriteRow[], e: Entry, before: Snapshot | null): Origin | undefined {
  const series = e.after?.seriesId ?? before?.seriesId;
  const w = writes.find((x) => (x.eventId === e.eventId && (!e.after || x.etag === e.after.etag)) || (!!series && x.eventId === series));
  return w
    ? { chatId: w.chatId, ...(w.authorName ? { authorName: w.authorName } : {}), ...(w.authorUserId ? { authorUserId: w.authorUserId } : {}) }
    : undefined;
}

// Тот же etag, что в снимке, — не изменение (в том числе эхо записи самого бота).
// notify=false — первая синхронизация: запоминаем, но не рассылаем.
export async function applyEntries(ctx: AppContext, pcid: string, entries: Entry[], opts: { notify: boolean; extra?: D1PreparedStatement[] }): Promise<number> {
  const now = ctx.clock.now();
  const old = await snapshotsByIds(
    ctx.db,
    pcid,
    entries.map((e) => e.eventId),
  );
  const seriesIds = entries.map((e) => e.after?.seriesId ?? old.get(e.eventId)?.seriesId).filter((x): x is string => !!x);
  const needAttribution = opts.notify && entries.some((e) => !e.origin);
  const writes = needAttribution ? await botWritesFor(ctx.db, pcid, [...entries.map((e) => e.eventId), ...seriesIds], now - ATTRIBUTION_MS) : [];

  const upserts: Snapshot[] = [];
  const deletes: string[] = [];
  const touched: string[] = [];
  const changes: Change[] = [];
  // Поручения, связанные с событием (US-91): перенос/удаление мимо бота. Сделанное ботом (запись в слушателе — origin,
  // или её эхо по тому же etag) поручения уже сдвинул/отменил сам (modify-event.ts, delete-event.ts) — не повторяем.
  const linked: { eventId: string; beforeEtag: string | null; kind: ChangeKind; deltaMs: number; actor: string | null }[] = [];
  for (const e of entries) {
    const before = old.get(e.eventId) ?? null;
    if (!e.after && !before) continue;
    if (e.after && before?.etag && e.after.etag === before.etag && e.after.status === before.status) continue;
    if (e.after && e.after.status !== "cancelled") upserts.push(e.after);
    else deletes.push(e.eventId);
    touched.push(e.eventId);
    const kind = !before && e.hint ? e.hint : diffEvent(before, e.after);
    if (!e.origin && before && (kind === "moved" || kind === "cancelled")) {
      const direct = writes.some((w) => w.eventId === e.eventId && !!e.after && w.etag === e.after.etag);
      // Запись бота в серию целиком: экземпляры приходят синком, автор — только по журналу записей
      const series = writes.find((w) => w.eventId === (e.after?.seriesId ?? before.seriesId));
      const deltaMs = kind === "moved" && isActive(e.after) && isActive(before) ? e.after.startMs! - before.startMs! : 0;
      if (!direct) linked.push({ eventId: e.eventId, beforeEtag: before.etag ?? null, kind, deltaMs, actor: series?.authorUserId ?? null });
    }
    if (kind && opts.notify) {
      const origin = e.origin ?? attribute(writes, e, before);
      changes.push({ kind, before, after: e.after, ...(origin ? { origin } : {}) });
    }
  }
  if (touched.length === 0) return 0;
  const chats = await chatsForCalendar(ctx.db, pcid);
  const stmts = [
    ...(opts.extra ?? []),
    ...upsertSnapshots(ctx.db, pcid, upserts, now),
    ...(deletes.length ? [deleteSnapshots(ctx.db, pcid, deletes)] : []),
    ...reminderStatements(ctx.db, pcid, touched, upserts.filter(isActive), reminderUsers(chats), now),
  ];
  // Снимки до записи — внутри того же batch: запись бота успела раньше (её журнал мы не видели, а поручение она уже
  // сдвинула) — второй раз не сдвигаем (tech-debt #21)
  const first = linked.length
    ? snapshotEtags(
        ctx.db,
        pcid,
        linked.map((l) => l.eventId),
      )
    : undefined;
  const state = await notifyChanges(ctx, pcid, changes, stmts, chats, first);
  const etagNow = new Map((state?.results as { event_id: string; etag: string | null }[] | undefined)?.map((r) => [r.event_id, r.etag]));
  for (const l of linked) {
    if (etagNow.get(l.eventId) !== l.beforeEtag) {
      log("sync_race_skipped", { kind: l.kind });
      continue;
    }
    try {
      if (l.kind === "moved") await shiftAssignmentsForProviderEvent(ctx, pcid, l.eventId, l.deltaMs, l.actor);
      else await cancelAssignmentsForProviderEvent(ctx, pcid, l.eventId, l.actor);
    } catch (err) {
      // Снимок уже обновлён — повтор синка изменения не увидит; сбой поручения не должен ронять синк остальных
      log("assign_sync_failed", { kind: l.kind, error: errorClass(err) });
    }
  }
  if (changes.length) log("calendar_changes", { changes: changes.length, by_bot: changes.filter((c) => c.origin).length });
  return changes.length;
}

const iso = (ms: number) => new Date(ms).toISOString();

export type SyncOutcome = "ok" | "busy" | "gone" | "unavailable";

export async function syncCalendar(ctx: AppContext, pcid: string, opts: { chain: boolean }): Promise<SyncOutcome> {
  const now = ctx.clock.now();
  let row = await getSyncRow(ctx.db, pcid);
  if (!row) {
    await ctx.db.prepare("INSERT OR IGNORE INTO calendar_sync (provider_calendar_id) VALUES (?)").bind(pcid).run();
    row = (await getSyncRow(ctx.db, pcid))!;
  }
  const owner = await pickOwner(ctx.db, pcid, row.ownerCalendarId);
  if (!owner) {
    // Каналы уже остановлены при отключении (stopUserChannels)
    await dropSync(ctx.db, pcid);
    return "gone";
  }
  if (owner.calendarId !== row.ownerCalendarId) {
    // Новый владелец: токен синхронизации и канал были чужими — полный синк со сверкой (снимки сохраняются)
    await updateSyncRow(ctx.db, pcid, {
      owner_calendar_id: owner.calendarId,
      sync_token: null,
      channel_id: null,
      channel_token: null,
      channel_resource_id: null,
      channel_expires_at: null,
    }).run();
    row = { ...row, ownerCalendarId: owner.calendarId, syncToken: null, channelId: null, channelToken: null, channelResourceId: null, channelExpiresAt: null };
  }
  if (!(await acquireLease(ctx.db, pcid, now, LEASE_MS))) return "busy";
  const provider = new GoogleCalendarProvider(ctx.config, ctx.db, owner.userId, ctx.clock);
  try {
    let page: SyncPage | undefined;
    let expired = false;
    if (row.syncToken) {
      try {
        page = await provider.syncEvents(pcid, { syncToken: row.syncToken });
      } catch (e) {
        if (!(e instanceof SyncTokenExpired)) throw e;
        expired = true;
        log("calendar_sync", { outcome: "token_expired" });
      }
    }
    const full = !page;
    page ??= await provider.syncEvents(pcid, { timeMin: iso(now - WINDOW_PAST_MS), timeMax: iso(now + WINDOW_FUTURE_MS) });
    const entries: Entry[] = page.items.map((e) => ({ eventId: e.id, after: snapshotOf(e) }));
    if (full && row.baselineAt) {
      // Полная пересинхронизация: чего нет в окне — удалено, пока токен был потерян
      const seen = new Set(entries.map((e) => e.eventId));
      for (const s of await snapshotsBetween(ctx.db, pcid, now - WINDOW_PAST_MS, now + WINDOW_FUTURE_MS)) {
        if (!seen.has(s.eventId)) entries.push({ eventId: s.eventId, after: null });
      }
    }
    const changed = await applyEntries(ctx, pcid, entries, { notify: !!row.baselineAt });
    await ctx.db.batch([
      updateSyncRow(ctx.db, pcid, {
        sync_token: page.nextSyncToken ?? null,
        last_sync_at: now,
        baseline_at: row.baselineAt ?? now,
        last_change_at: changed ? now : row.lastChangeAt,
        last_outcome: "ok",
        ...(expired ? { last_resync_at: now } : {}),
      }),
      ...pruneStatements(ctx.db, pcid, now),
    ]);
    if (opts.chain) await extendReminders(ctx.db, pcid, now);
    if (ctx.config.googlePushEnabled) await ensureChannel(ctx, provider, pcid, now);
    log("calendar_sync", { outcome: "ok", full, items: page.items.length, changes: changed });
    return "ok";
  } catch (e) {
    // Календарь удалён/недоступен владельцу или доступ отозван — не повторяем задачей; сверка попробует снова
    const unavailable = e instanceof AuthRevoked || e instanceof PermissionDenied || e instanceof EventGone;
    await updateSyncRow(ctx.db, pcid, { last_outcome: unavailable ? "unavailable" : "error", last_error_at: now, last_error: errorClass(e) })
      .run()
      .catch(() => undefined);
    if (unavailable) {
      log("calendar_sync", { outcome: "unavailable", error: errorClass(e) });
      return "unavailable";
    }
    throw e;
  } finally {
    await releaseLease(ctx.db, pcid);
  }
}

function randomToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function ensureChannel(ctx: AppContext, provider: GoogleCalendarProvider, pcid: string, now: number): Promise<void> {
  const row = await getSyncRow(ctx.db, pcid);
  if (!row) return;
  if (row.channelId && row.channelExpiresAt && row.channelExpiresAt - now > RENEW_BEFORE_MS) return;
  await openChannel(ctx, provider, row, now);
}

// Не вышло (адрес не принят, лимиты) — остаёмся на опросе. Новый канал записываем до остановки старого — иначе
// уведомления между ними теряются.
async function openChannel(ctx: AppContext, provider: GoogleCalendarProvider, row: SyncRow, now: number): Promise<void> {
  const channel = { id: crypto.randomUUID(), token: randomToken(), address: `${ctx.config.publicBaseUrl}${PUSH_PATH}`, expiration: now + CHANNEL_TTL_MS };
  let res: { resourceId: string; expiration?: number };
  try {
    res = await provider.watch(row.pcid, channel);
  } catch (e) {
    log("calendar_watch", { outcome: "error", error: errorClass(e) });
    console.warn("events.watch failed — polling only", e instanceof Error ? e.message : e);
    return;
  }
  const expiresAt = Math.min(res.expiration ?? channel.expiration, channel.expiration);
  await ctx.db.batch([
    updateSyncRow(ctx.db, row.pcid, {
      channel_id: channel.id,
      channel_token: channel.token,
      channel_resource_id: res.resourceId,
      channel_expires_at: expiresAt,
    }),
    ctx.db
      .prepare(
        `INSERT INTO scheduled_jobs (id, kind, user_id, fire_at, payload_json, status, dedupe_key)
         VALUES (?, ?, NULL, ?, ?, 'pending', ?)
         ON CONFLICT (dedupe_key) DO NOTHING`,
      )
      .bind(
        crypto.randomUUID(),
        WATCH_RENEW_JOB,
        Math.max(now, expiresAt - RENEW_BEFORE_MS),
        JSON.stringify({ pcid: row.pcid, expiresAt }),
        `${WATCH_RENEW_JOB}:${row.pcid}:${expiresAt}`,
      ),
  ]);
  log("calendar_watch", { outcome: "opened", renewed: !!row.channelId });
  if (row.channelId && row.channelResourceId) await provider.stopChannel({ id: row.channelId, resourceId: row.channelResourceId }).catch(() => undefined);
}

// Канал мог уже заменить плановый синк — тогда expiresAt не совпадёт.
export async function runWatchRenewJob(ctx: AppContext, job: DueJob): Promise<void> {
  const { pcid, expiresAt } = JSON.parse(job.payload_json) as { pcid: string; expiresAt: number };
  if (!ctx.config.googlePushEnabled) return;
  const row = await getSyncRow(ctx.db, pcid);
  if (!row || row.channelExpiresAt !== expiresAt) return;
  const owner = await pickOwner(ctx.db, pcid, row.ownerCalendarId);
  if (!owner || owner.calendarId !== row.ownerCalendarId) return;
  await openChannel(ctx, new GoogleCalendarProvider(ctx.config, ctx.db, owner.userId, ctx.clock), row, ctx.clock.now());
}

// Перед /disconnect: канал Google может остановить только токен, который его открыл.
export async function stopUserChannels(ctx: AppContext, userId: string): Promise<void> {
  const rows = await channelsOwnedBy(ctx.db, userId);
  if (rows.length === 0) return;
  const provider = new GoogleCalendarProvider(ctx.config, ctx.db, userId, ctx.clock);
  for (const r of rows) {
    await provider.stopChannel({ id: r.channelId!, resourceId: r.channelResourceId ?? "" }).catch((e) => console.warn("channels.stop failed", errorClass(e)));
    await updateSyncRow(ctx.db, r.pcid, {
      channel_id: null,
      channel_token: null,
      channel_resource_id: null,
      channel_expires_at: null,
      sync_token: null,
      owner_calendar_id: null,
    }).run();
    // Календарь есть и у других — синк сразу перейдёт к их токену и откроет свой канал (иначе push — только после сверки)
    await enqueuePushSync(ctx.db, r.pcid, ctx.clock.now());
  }
}

export async function dropOrphanSyncs(db: D1Database): Promise<void> {
  for (const pcid of await orphanSyncs(db)) await dropSync(db, pcid);
}

function jobStatement(db: D1Database, kind: string, pcid: string, at: number, key: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO scheduled_jobs (id, kind, user_id, fire_at, payload_json, status, dedupe_key)
       VALUES (?, ?, NULL, ?, ?, 'pending', ?)
       ON CONFLICT (dedupe_key) DO NOTHING`,
    )
    .bind(crypto.randomUUID(), kind, at, JSON.stringify({ pcid }), key);
}

// Цепочка одна на календарь: повтор задачи и страховка не должны её удваивать.
async function scheduleSync(db: D1Database, pcid: string, at: number): Promise<void> {
  const waiting = await db
    .prepare("SELECT 1 FROM scheduled_jobs WHERE kind = ? AND status = 'pending' AND payload_json ->> '$.pcid' = ? LIMIT 1")
    .bind(SYNC_JOB, pcid)
    .first();
  if (!waiting) await jobStatement(db, SYNC_JOB, pcid, at, `${SYNC_JOB}:${pcid}:${crypto.randomUUID()}`).run();
}

function nextSyncAt(row: SyncRow | null, now: number): number {
  if (row?.channelId && (row.channelExpiresAt ?? 0) > now) return now + RECONCILE_MS;
  return now + (row?.lastChangeAt && row.lastChangeAt > now - ACTIVE_FOR_MS ? POLL_ACTIVE_MS : POLL_IDLE_MS);
}

export async function runSyncJob(ctx: AppContext, job: DueJob): Promise<void> {
  const { pcid } = JSON.parse(job.payload_json) as { pcid: string };
  const outcome = await syncCalendar(ctx, pcid, { chain: true });
  if (outcome === "gone") return;
  const now = ctx.clock.now();
  await scheduleSync(ctx.db, pcid, outcome === "busy" ? now + MINUTE_MS : nextSyncAt(await getSyncRow(ctx.db, pcid), now));
}

export async function runPushSyncJob(ctx: AppContext, job: DueJob): Promise<void> {
  const { pcid } = JSON.parse(job.payload_json) as { pcid: string };
  const outcome = await syncCalendar(ctx, pcid, { chain: false });
  // Идёт другой синк — он мог начаться до изменения: повторить чуть позже
  if (outcome === "busy") await enqueuePushSync(ctx.db, pcid, ctx.clock.now() + 30_000);
}

// Пачка push — одна задача, пока ждёт ещё не начатая. Уже идущая не в счёт: она могла прочитать календарь до
// этого изменения.
export async function enqueuePushSync(db: D1Database, pcid: string, at: number): Promise<string | null> {
  const waiting = await db
    .prepare("SELECT 1 FROM scheduled_jobs WHERE kind = ? AND status = 'pending' AND payload_json ->> '$.pcid' = ? AND fire_at <= ? LIMIT 1")
    .bind(PUSH_SYNC_JOB, pcid, at + PUSH_COALESCE_MS)
    .first();
  if (waiting) return null;
  const id = crypto.randomUUID();
  await db
    .prepare("INSERT INTO scheduled_jobs (id, kind, user_id, fire_at, payload_json, status, dedupe_key) VALUES (?, ?, NULL, ?, ?, 'pending', ?)")
    .bind(id, PUSH_SYNC_JOB, at, JSON.stringify({ pcid }), `${PUSH_SYNC_JOB}:${pcid}:${id}`)
    .run();
  return id;
}

// Страховка раз в час: новые подключения и оборванные цепочки синка.
export async function ensureCalendarSyncs(db: D1Database, now: number): Promise<void> {
  await dropOrphanSyncs(db);
  await pruneNotices(db, now);
  const pcids = await ensureSyncRows(db);
  const { results } = await db
    .prepare("SELECT DISTINCT payload_json ->> '$.pcid' AS pcid FROM scheduled_jobs WHERE kind = ? AND status IN ('pending', 'queued', 'running')")
    .bind(SYNC_JOB)
    .all<{ pcid: string }>();
  const planned = new Set(results.map((r) => r.pcid));
  const missing = pcids.filter((p) => !planned.has(p));
  if (missing.length) await db.batch(missing.map((p) => jobStatement(db, SYNC_JOB, p, now, `${SYNC_JOB}:${p}:${crypto.randomUUID()}`)));
}
