// Ошибки Google API. Наружу из адаптера (calendar/google-provider.ts) не выходят — переводятся в ошибки
// календаря из calendar/model.ts (tech-debt #12).

export class GoogleAuthError extends Error {
  constructor(
    message: string,
    /** invalid_grant — доступ отозван пользователем, нужно переподключить (US-02). */
    readonly revoked: boolean,
  ) {
    super(message);
  }
}

/** Ошибка Calendar API с HTTP-статусом: 404/410 — удалено, 403 — нет прав или лимит, 412 — событие изменили (etag). */
export class GoogleApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}
