// Журнал действий операторов (admin_audit): только чтение. Хранится бессрочно (миграция 0006).

import { esc, fmtTime, raw, table } from "./layout";

export interface AuditItem {
  id: number;
  at: number;
  operator: string;
  action: string;
  user: string;
  reason: string | null;
  details: string;
}

export function auditBody(items: AuditItem[]): string {
  return `<h1>Аудит действий операторов</h1>
<p class="muted">Каждый «Показать» и (позже) каждое изменение. Записи только добавляются. Просмотр агрегатов не пишется.</p>
${table(
  ["#", "Когда", "Оператор", "Действие", "Пользователь", "Причина", "Детали"],
  items.map((a) => [a.id, fmtTime(a.at), a.operator, a.action, a.user, a.reason ?? "", raw(`<code>${esc(a.details)}</code>`)]),
  "записей нет",
)}`;
}
