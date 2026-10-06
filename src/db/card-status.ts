// tech-debt #6: машина состояний карточки (pending_actions.status) и решение для нажатия на уже «забранную».
// Чистый модуль без D1 — правила проверяются юнит-тестом (test/card-status.test.ts); SQL — в conversations.ts.
//
//   open ──нажатие──▶ executing (claimed_at) ──успех──▶ done
//     │                   │  └──сбой обработан (Google 5xx, ошибка Telegram и т.п.)──▶ failed (карточка: «Не получилось»)
//     │                   └──процесс умер посреди действия: статус остался executing
//     └──новая команда──▶ cancelled                         (истечение — по expires_at, статус не меняется)
//
// Нажатие на executing: моложе CARD_STALE_MS — «уже выполняю»; старше — для идемпотентных kind повтор
// (create — свой id события, modify/delete/undo — etag), для остальных — failed и «повторите команду».

/** Через сколько executing считается брошенным: дольше любого действия (таймаут Google 10 с × несколько вызовов). */
export const CARD_STALE_MS = 60 * 1000;

export type CardVerdict =
  /** Забрать заново и выполнить ещё раз (идемпотентный kind, прошлый обработчик умер). */
  | "retry"
  /** Выполняется прямо сейчас — подождать. */
  | "inProgress"
  /** Сбой уже обработан (failed, карточка показывает «Не получилось») — повторить командой. */
  | "notCompleted"
  /** Обработчик умер, повтор небезопасен (или карточка истекла) — пометить failed, повторить командой. */
  | "abandoned"
  | "done"
  /** Отменена новой командой, истекла или не найдена — «Карточка устарела». */
  | "stale";

export interface CardRow {
  status: string;
  claimedAt: number | null;
  expiresAt: number;
}

/** Что делать с нажатием на карточку, которую не удалось забрать из open. */
export function cardVerdict(row: CardRow | null, now: number, retryable: boolean): CardVerdict {
  if (!row) return "stale";
  switch (row.status) {
    case "executing": {
      const abandoned = row.claimedAt === null || now - row.claimedAt >= CARD_STALE_MS;
      if (!abandoned) return "inProgress";
      // Истёкшую не доводим: через 15 минут действие могло стать неактуальным
      return retryable && row.expiresAt > now ? "retry" : "abandoned";
    }
    case "failed":
      return "notCompleted";
    case "done":
      return "done";
    default:
      // open, но истекла; cancelled
      return "stale";
  }
}
