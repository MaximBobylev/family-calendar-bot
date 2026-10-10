// Список календарей при переподключении того же аккаунта (tech-debt #19).

export interface ProviderCalendarEntry {
  id: string;
  writable: boolean;
  primary?: boolean;
}

/** Выбор пользователя сохраняется, только если календарь остался и в него можно писать; иначе — primary аккаунта. */
export function pickDefaultCalendar(previousDefault: string | undefined, calendars: ProviderCalendarEntry[]): string | undefined {
  const kept = previousDefault ? calendars.find((c) => c.id === previousDefault && c.writable) : undefined;
  return (kept ?? calendars.find((c) => c.primary))?.id;
}
