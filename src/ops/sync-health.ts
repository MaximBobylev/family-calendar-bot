// Пороги общие для панели /admin/sync и алерта sync_stale — краснеют одинаково. Во входных строках нет id календаря
// (это почта) — только времена и флаги.

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;

// С push сверка раз в сутки (RECONCILE_MS) — плюс запас.
export const SYNC_STALE_PUSH_MS = 26 * HOUR_MS;
// Без push опрос раз в 5–15 минут — час без синка уже сбой.
export const SYNC_STALE_POLL_MS = HOUR_MS;
// Канал продлевается за сутки до конца (RENEW_BEFORE_MS): осталось меньше — продление не сработало.
export const CHANNEL_EXPIRING_MS = 12 * HOUR_MS;
export const SYNC_WINDOW_MS = DAY_MS;

export interface SyncCalendarRow {
  last_sync_at: number | null;
  has_channel: number;
  channel_expires_at: number | null;
  last_outcome: string | null;
  last_error_at: number | null;
  last_resync_at: number | null;
  // Календарь виден хотя бы в одном чате — есть кому слать уведомления
  subscribed: number;
}

export type SyncMode = "push" | "poll";

export const syncMode = (r: Pick<SyncCalendarRow, "has_channel" | "channel_expires_at">, now: number): SyncMode =>
  r.has_channel && (r.channel_expires_at ?? 0) > now ? "push" : "poll";

// «Недоступен» (доступ отозван, календарь удалён) — проблема пользователя, не эксплуатации: в алерт не идёт.
export function isSyncStale(r: SyncCalendarRow, now: number): boolean {
  if (!r.subscribed || r.last_sync_at === null || r.last_outcome === "unavailable") return false;
  return now - r.last_sync_at > (syncMode(r, now) === "push" ? SYNC_STALE_PUSH_MS : SYNC_STALE_POLL_MS);
}

export interface SyncSummary {
  total: number;
  push: number;
  poll: number;
  neverSynced: number;
  unavailable: number;
  failing: number;
  stale: number;
  oldestStaleAt: number | null;
  oldestSyncAt: number | null;
  errorsDay: number;
  resyncsDay: number;
  // В том числе уже истёкшие, если новый не открыт
  channelsExpiring: number;
}

const minOf = (a: number | null, b: number) => (a === null ? b : Math.min(a, b));

export function summarizeSync(rows: SyncCalendarRow[], now: number): SyncSummary {
  const s: SyncSummary = {
    total: rows.length,
    push: 0,
    poll: 0,
    neverSynced: 0,
    unavailable: 0,
    failing: 0,
    stale: 0,
    oldestStaleAt: null,
    oldestSyncAt: null,
    errorsDay: 0,
    resyncsDay: 0,
    channelsExpiring: 0,
  };
  for (const r of rows) {
    s[syncMode(r, now)]++;
    if (r.last_sync_at === null) s.neverSynced++;
    else s.oldestSyncAt = minOf(s.oldestSyncAt, r.last_sync_at);
    if (r.last_outcome === "unavailable") s.unavailable++;
    if (r.last_outcome === "error") s.failing++;
    if (isSyncStale(r, now)) {
      s.stale++;
      s.oldestStaleAt = minOf(s.oldestStaleAt, r.last_sync_at!);
    }
    if (r.last_error_at !== null && r.last_error_at > now - SYNC_WINDOW_MS) s.errorsDay++;
    if (r.last_resync_at !== null && r.last_resync_at > now - SYNC_WINDOW_MS) s.resyncsDay++;
    if (r.has_channel && r.channel_expires_at !== null && r.channel_expires_at - now < CHANNEL_EXPIRING_MS) s.channelsExpiring++;
  }
  return s;
}

export function syncLevel(s: SyncSummary, noticesOverdue: number, jobsFailedDay: number): "ok" | "warn" | "crit" {
  if (s.stale > 0) return "crit";
  if (s.failing > 0 || s.errorsDay > 0 || s.channelsExpiring > 0 || noticesOverdue > 0 || jobsFailedDay > 0) return "warn";
  return "ok";
}
