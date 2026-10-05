// Синхронизация списка календарей при переподключении того же аккаунта (tech-debt #19): чистая логика.

export interface ProviderCalendarEntry {
  /** id календаря у провайдера. */
  id: string;
  writable: boolean;
  primary?: boolean;
}

/**
 * Какой календарь будет основным после обновления списка: выбор пользователя сохраняется,
 * если календарь остался и в него можно писать; иначе — основной календарь аккаунта (primary).
 */
export function pickDefaultCalendar(previousDefault: string | undefined, calendars: ProviderCalendarEntry[]): string | undefined {
  const kept = previousDefault ? calendars.find((c) => c.id === previousDefault && c.writable) : undefined;
  return (kept ?? calendars.find((c) => c.primary))?.id;
}
