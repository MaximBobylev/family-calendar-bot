// Расход AI по пользователям (псевдонимы) и итоги против лимитов (config.ts: USAGE_LIMITS, COST_ESTIMATES).
// Стоимость — из usage_events.cost_micro_usd (пишется в момент вызова, ADR-0004), а не по ценам в админке.

import type { UsageLimits } from "../../limits";
import type { FeatureRow, ModelUsage, UserUsage } from "../queries";
import { esc, fmtTime, raw, table, usd } from "./layout";

export interface UsageView {
  byUser: (UserUsage & { user: string })[];
  byModel: ModelUsage[];
  intents: { intent: string; n: number }[];
  cards: { kind: string; status: string; n: number }[];
  features: FeatureRow[];
  limits: UsageLimits;
}

/** «45 / 60», красным — от 80% лимита. */
function vsLimit(n: number, limit: number) {
  return raw(`<span class="${n >= limit * 0.8 ? "err" : ""}">${n} / ${limit}</span>`);
}

export function usageBody(v: UsageView): string {
  const limitOf = (kind: string) => (kind === "stt" ? v.limits.stt : v.limits.llm);
  const userRows = v.byUser.map((u) => [
    raw(`<a href="/admin/journal?u=${encodeURIComponent(u.user)}">${esc(u.user)}</a>`),
    u.kind,
    u.n_today,
    u.n_7d,
    u.errors_7d,
    vsLimit(u.n_hour, limitOf(u.kind).perHour),
    vsLimit(u.n_24h, limitOf(u.kind).perDay),
    usd(u.cost_today),
    usd(u.cost_7d) + (u.no_cost ? ` (+${u.no_cost} без оценки)` : ""),
  ]);
  const sum = (f: (u: UserUsage) => number) => v.byUser.reduce((a, u) => a + f(u), 0);
  const totalRow = v.byUser.length
    ? `<p><b>Итого:</b> сегодня ${sum((u) => u.n_today)} вызовов, ${usd(sum((u) => u.cost_today))}; за 7 дней ${sum((u) => u.n_7d)} вызовов, ${usd(sum((u) => u.cost_7d))}.</p>`
    : "";
  return `<h1>Расход AI</h1>
<p class="muted">Сегодня — с полуночи UTC. Лимиты на пользователя (скользящие час / сутки): LLM ${v.limits.llm.perHour} / ${v.limits.llm.perDay}, STT ${v.limits.stt.perHour} / ${v.limits.stt.perDay}. Стоимость — оценка по прайсу на момент вызова.</p>
<h2>По пользователям (7 дней)</h2>
${table(["Пользователь", "Тип", "Сегодня", "7 дней", "Ошибок", "Час / лимит", "Сутки / лимит", "≈ сегодня", "≈ 7 дней"], userRows)}
${totalRow}
<h2>По моделям (7 дней)</h2>
${table(
  ["Тип", "Модель", "Вызовов", "Ошибок", "Токены вх/вых · аудио", "≈ стоимость"],
  v.byModel.map((m) => [m.kind, m.model, m.n, m.errors, m.kind === "llm" ? `${m.tin} / ${m.tout}` : `${(m.audio_ms / 60_000).toFixed(1)} мин`, usd(m.cost)]),
)}
<h2>Интенты (7 дней)</h2>
${table(
  ["Интент", "Раз"],
  v.intents.map((i) => [i.intent, i.n]),
)}
<h2>Карточки (7 дней)</h2>
${table(
  ["Тип", "Статус", "Количество"],
  v.cards.map((c) => [c.kind, c.status, c.n]),
)}
<h2>Функции (US-64, за всё время)</h2>
${table(
  ["Функция", "Пользователей", "Раз", "Впервые"],
  v.features.map((f) => [f.feature, f.users, f.uses, fmtTime(f.first_at)]),
)}`;
}
