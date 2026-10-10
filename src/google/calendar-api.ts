// Сырой HTTP к Google Calendar API; остальной код видит его только через calendar/google-provider.ts (ADR-0003).

import { fetchWithTimeout, TIMEOUTS } from "../net/fetch";
import { retryDelayMs } from "../net/retry";
import { GoogleApiError } from "./errors";

/** Повтор только для GET — чтение идемпотентно (tech-debt #13). */
async function getWithRetry(url: URL, accessToken: string): Promise<Response> {
  const init = { headers: { authorization: `Bearer ${accessToken}` } };
  const started = performance.now();
  const res = await fetchWithTimeout(url, init, TIMEOUTS.google);
  const delay = retryDelayMs(res.status, performance.now() - started, res.headers.get("retry-after"));
  if (delay === null) return res;
  await res.body?.cancel();
  await new Promise((r) => setTimeout(r, delay));
  return fetchWithTimeout(url, init, TIMEOUTS.google);
}

export interface GoogleCalendarListEntry {
  id: string;
  summary: string;
  timeZone?: string;
  accessRole: "freeBusyReader" | "reader" | "writer" | "owner";
  primary?: boolean;
}

export async function listCalendars(apiBase: string, accessToken: string): Promise<GoogleCalendarListEntry[]> {
  const items: GoogleCalendarListEntry[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${apiBase}/calendar/v3/users/me/calendarList`);
    url.searchParams.set("maxResults", "250");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await getWithRetry(url, accessToken);
    if (!res.ok) throw new GoogleApiError(`calendarList failed: ${res.status} ${await res.text()}`, res.status);
    const page = (await res.json()) as { items?: GoogleCalendarListEntry[]; nextPageToken?: string };
    items.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return items;
}

export interface GoogleEvent {
  id: string;
  status?: "confirmed" | "tentative" | "cancelled";
  summary?: string;
  location?: string;
  description?: string;
  reminders?: { useDefault?: boolean; overrides?: { method: "popup" | "email"; minutes: number }[] };
  hangoutLink?: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  transparency?: "opaque" | "transparent";
  eventType?: string;
  attendees?: { self?: boolean; responseStatus?: string }[];
  organizer?: { self?: boolean; email?: string; displayName?: string };
  recurringEventId?: string;
  /** Только у мастер-события серии. */
  recurrence?: string[];
  etag?: string;
  htmlLink?: string;
}

export async function listEvents(
  apiBase: string,
  accessToken: string,
  calendarId: string,
  timeMin: string,
  timeMax: string,
  timeZone: string,
): Promise<GoogleEvent[]> {
  const items: GoogleEvent[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${apiBase}/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("timeMin", timeMin);
    url.searchParams.set("timeMax", timeMax);
    url.searchParams.set("timeZone", timeZone);
    url.searchParams.set("maxResults", "250");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await getWithRetry(url, accessToken);
    if (!res.ok) throw new GoogleApiError(`events.list failed: ${res.status} ${await res.text()}`, res.status);
    const page = (await res.json()) as { items?: GoogleEvent[]; nextPageToken?: string };
    items.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return items;
}

export interface GoogleEventInput {
  id?: string;
  attendees?: { email?: string; self?: boolean; responseStatus?: string }[];
  summary?: string;
  location?: string;
  description?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  recurrence?: string[];
  reminders?: { useDefault: boolean; overrides?: { method: "popup" | "email"; minutes: number }[] };
}

async function writeEvent(
  url: URL,
  method: "POST" | "PATCH",
  accessToken: string,
  body: GoogleEventInput,
  etag?: string,
): Promise<GoogleEvent & { htmlLink?: string }> {
  const res = await fetchWithTimeout(
    url,
    {
      method,
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", ...(etag ? { "if-match": etag } : {}) },
      body: JSON.stringify(body),
    },
    TIMEOUTS.google,
  );
  if (!res.ok) throw new GoogleApiError(`events.${method === "POST" ? "insert" : "patch"} failed: ${res.status} ${await res.text()}`, res.status);
  return (await res.json()) as GoogleEvent & { htmlLink?: string };
}

export async function getEvent(apiBase: string, accessToken: string, calendarId: string, eventId: string, timeZone: string): Promise<GoogleEvent | null> {
  const url = new URL(`${apiBase}/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
  url.searchParams.set("timeZone", timeZone);
  const res = await getWithRetry(url, accessToken);
  if (res.status === 404 || res.status === 410) return null;
  if (!res.ok) throw new GoogleApiError(`events.get failed: ${res.status} ${await res.text()}`, res.status);
  return (await res.json()) as GoogleEvent;
}

export async function insertEvent(apiBase: string, accessToken: string, calendarId: string, body: GoogleEventInput) {
  try {
    return await writeEvent(new URL(`${apiBase}/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`), "POST", accessToken, body);
  } catch (e) {
    // 409 с нашим id — событие создала прошлая попытка: это успех
    if (e instanceof GoogleApiError && e.status === 409 && body.id) {
      const existing = await getEvent(apiBase, accessToken, calendarId, body.id, body.start?.timeZone ?? "UTC");
      if (existing) return existing as GoogleEvent & { htmlLink?: string };
    }
    throw e;
  }
}

export function patchEvent(
  apiBase: string,
  accessToken: string,
  calendarId: string,
  eventId: string,
  body: GoogleEventInput,
  opts: { sendUpdates?: "all" | "none"; etag?: string } = {},
) {
  const url = new URL(`${apiBase}/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
  if (opts.sendUpdates) url.searchParams.set("sendUpdates", opts.sendUpdates);
  return writeEvent(url, "PATCH", accessToken, body, opts.etag);
}

/** 404/410 — уже удалено: для пользователя это успех. */
export async function deleteEvent(
  apiBase: string,
  accessToken: string,
  calendarId: string,
  eventId: string,
  opts: { sendUpdates?: "all" | "none"; etag?: string } = {},
): Promise<"deleted" | "gone"> {
  const url = new URL(`${apiBase}/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
  if (opts.sendUpdates) url.searchParams.set("sendUpdates", opts.sendUpdates);
  const res = await fetchWithTimeout(
    url,
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${accessToken}`, ...(opts.etag ? { "if-match": opts.etag } : {}) },
    },
    TIMEOUTS.google,
  );
  if (res.status === 404 || res.status === 410) return "gone";
  if (!res.ok) throw new GoogleApiError(`events.delete failed: ${res.status} ${await res.text()}`, res.status);
  return "deleted";
}

/** 410 Gone на syncToken: нужна полная пересинхронизация. */
export class SyncTokenExpired extends Error {}

export interface SyncPage {
  items: GoogleEvent[];
  /** Нет — следующий синк снова полный (по окну). */
  nextSyncToken?: string;
}

/**
 * С syncToken удалённые приходят со status=cancelled; orderBy и timeMin/timeMax вместе с ним Google не принимает.
 * singleEvents — одинаково в полном и инкрементальном синке. nextSyncToken — только на последней странице.
 */
export async function syncEvents(
  apiBase: string,
  accessToken: string,
  calendarId: string,
  opts: { syncToken?: string; timeMin?: string; timeMax?: string },
): Promise<SyncPage> {
  const items: GoogleEvent[] = [];
  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;
  do {
    const url = new URL(`${apiBase}/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("maxResults", "250");
    if (opts.syncToken) url.searchParams.set("syncToken", opts.syncToken);
    else {
      if (opts.timeMin) url.searchParams.set("timeMin", opts.timeMin);
      if (opts.timeMax) url.searchParams.set("timeMax", opts.timeMax);
    }
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await getWithRetry(url, accessToken);
    if (res.status === 410 && opts.syncToken) {
      await res.body?.cancel();
      throw new SyncTokenExpired("sync token expired");
    }
    if (!res.ok) throw new GoogleApiError(`events.list (sync) failed: ${res.status} ${await res.text()}`, res.status);
    const page = (await res.json()) as { items?: GoogleEvent[]; nextPageToken?: string; nextSyncToken?: string };
    items.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
    nextSyncToken = page.nextSyncToken;
  } while (pageToken);
  return { items, ...(nextSyncToken ? { nextSyncToken } : {}) };
}

/** expiration — желаемый срок (мс); Google может дать меньше. */
export async function watchEvents(
  apiBase: string,
  accessToken: string,
  calendarId: string,
  channel: { id: string; token: string; address: string; expiration: number },
): Promise<{ resourceId: string; expiration?: number }> {
  const url = new URL(`${apiBase}/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/watch`);
  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ id: channel.id, type: "web_hook", address: channel.address, token: channel.token, expiration: channel.expiration }),
    },
    TIMEOUTS.google,
  );
  if (!res.ok) throw new GoogleApiError(`events.watch failed: ${res.status} ${await res.text()}`, res.status);
  const body = (await res.json()) as { resourceId: string; expiration?: string | number };
  return { resourceId: body.resourceId, ...(body.expiration !== undefined ? { expiration: Number(body.expiration) } : {}) };
}

/** 404 — канал уже истёк: это успех. */
export async function stopChannel(apiBase: string, accessToken: string, channel: { id: string; resourceId: string }): Promise<void> {
  const res = await fetchWithTimeout(
    new URL(`${apiBase}/calendar/v3/channels/stop`),
    {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ id: channel.id, resourceId: channel.resourceId }),
    },
    TIMEOUTS.google,
  );
  if (res.status === 404) return;
  if (!res.ok) throw new GoogleApiError(`channels.stop failed: ${res.status} ${await res.text()}`, res.status);
}
