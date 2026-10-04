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
