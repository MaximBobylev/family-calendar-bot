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
