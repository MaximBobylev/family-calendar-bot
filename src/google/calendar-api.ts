// Клиент Google Calendar API. Базовый URL — из конфига (в тестах — фейк).
// Позже обернётся интерфейсом CalendarProvider (ADR-0003); пока используется только при привязке.

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
    const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`calendarList failed: ${res.status} ${await res.text()}`);
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
  hangoutLink?: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  transparency?: "opaque" | "transparent";
  eventType?: string;
  attendees?: { self?: boolean; responseStatus?: string }[];
  organizer?: { self?: boolean };
  recurringEventId?: string;
  etag?: string;
}

/** События в интервале, повторяющиеся развёрнуты в экземпляры. */
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
    const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`events.list failed: ${res.status} ${await res.text()}`);
    const page = (await res.json()) as { items?: GoogleEvent[]; nextPageToken?: string };
    items.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return items;
}

export interface GoogleEventInput {
  summary?: string;
  location?: string;
  description?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  reminders?: { useDefault: boolean; overrides?: { method: "popup" | "email"; minutes: number }[] };
}

/** Ошибка Calendar API с HTTP-статусом: 404/410 — удалено, 403 — нет прав, 412 — событие изменили (etag). */
export class GoogleApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function writeEvent(
  url: URL,
  method: "POST" | "PATCH",
  accessToken: string,
  body: GoogleEventInput,
  etag?: string,
): Promise<GoogleEvent & { htmlLink?: string }> {
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", ...(etag ? { "if-match": etag } : {}) },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new GoogleApiError(`events.${method === "POST" ? "insert" : "patch"} failed: ${res.status} ${await res.text()}`, res.status);
  return (await res.json()) as GoogleEvent & { htmlLink?: string };
}

export async function getEvent(apiBase: string, accessToken: string, calendarId: string, eventId: string, timeZone: string): Promise<GoogleEvent | null> {
  const url = new URL(`${apiBase}/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
  url.searchParams.set("timeZone", timeZone);
  const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  if (res.status === 404 || res.status === 410) return null;
  if (!res.ok) throw new GoogleApiError(`events.get failed: ${res.status} ${await res.text()}`, res.status);
  return (await res.json()) as GoogleEvent;
}

export function insertEvent(apiBase: string, accessToken: string, calendarId: string, body: GoogleEventInput) {
  return writeEvent(new URL(`${apiBase}/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`), "POST", accessToken, body);
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
