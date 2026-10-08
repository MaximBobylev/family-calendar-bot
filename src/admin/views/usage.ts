// Расход AI по пользователям (псевдонимы) и итоги против лимитов (config.ts: USAGE_LIMITS, COST_ESTIMATES).
// Стоимость — из usage_events.cost_micro_usd (пишется в момент вызова, ADR-0004), а не по ценам в админке.

import type { Feature } from "../../db/features";
import type { UsageLimits } from "../../limits";
import type { DateFixDay, FeatureRow, InlineStats, ModelUsage, SourceUsage, UserUsage } from "../queries";
import { type FEATURE_LABELS, featureLabel, SOURCE_LABELS } from "../labels";
import { esc, fmtTime, raw, table, usd } from "./layout";

/** Каждой функции US-64 — подпись: новое значение Feature без строки в labels.ts не скомпилируется. */
type UnlabelledFeature = Exclude<Feature, keyof typeof FEATURE_LABELS>;
const ALL_FEATURES_LABELLED: [UnlabelledFeature] extends [never] ? true : UnlabelledFeature = true;
void ALL_FEATURES_LABELLED;

/** Функции «контент → событие» (US-65–67) — отдельная секция. */
const INGEST_FEATURES: Feature[] = ["forward_event", "image_event", "ics_import"];

export interface UsageView {
  byUser: (UserUsage & { user: string })[];
  byModel: ModelUsage[];
  intents: { intent: string; n: number }[];
  cards: { kind: string; status: string; n: number }[];
  features: FeatureRow[];
  bySource: SourceUsage[];
  inline: InlineStats;
  /** Правки даты после карточки по дням (tech-debt #26). */
  dateFixes: DateFixDay[];
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
${ingestSection(v)}
${dateFixSection(v.dateFixes)}
<h2>Функции (US-64, за всё время)</h2>
${table(
  ["Функция", "Ключ", "Пользователей", "Раз", "Впервые"],
  v.features.map((f) => [featureLabel(f.feature), raw(`<code>${esc(f.feature)}</code>`), f.users, f.uses, fmtTime(f.first_at)]),
)}`;
}

/** Доля правок от созданных: «3 / 40 (7,5%)». */
const share = (n: number, of: number) => (of ? `${n} / ${of} (${((n / of) * 100).toFixed(1).replace(".", ",")}%)` : String(n));

function dateFixSection(days: DateFixDay[]): string {
  const total = (f: (d: DateFixDay) => number) => days.reduce((a, d) => a + f(d), 0);
  const row = (label: string, d: Omit<DateFixDay, "day">) => [
    label,
    d.created,
    raw(`<span class="${d.created && d.fixes / d.created > 0.05 ? "err" : ""}">${share(d.fixes, d.created)}</span>`),
    `${d.option_ours} / ${d.option_llm}`,
    d.modify,
    d.recreate,
    `${d.fixes_disagreed} / ${d.created_disagreed}`,
  ];
  const sum: Omit<DateFixDay, "day"> = {
    created: total((d) => d.created),
    created_disagreed: total((d) => d.created_disagreed),
    fixes: total((d) => d.fixes),
    option_ours: total((d) => d.option_ours),
    option_llm: total((d) => d.option_llm),
    modify: total((d) => d.modify),
    recreate: total((d) => d.recreate),
    fixes_disagreed: total((d) => d.fixes_disagreed),
  };
  return `<h2 id="date-fix">Даты: правки после карточки (date_fix, 14 дней)</h2>
${table(
  ["День (UTC)", "Создано", "Правок / создано", "Другой вариант: наш / LLM", "Изменили время", "Пересоздали", "Правки / создано при расхождении с LLM"],
  [...days.map((d) => row(d.day, d)), ...(days.length ? [row("Итого", sum)] : [])],
  "карточек создания не было",
)}
<p class="muted">Правка — в окне карточки (15 мин): выбран не первый вариант даты, изменено время только что созданного события или отменили и создали то же на другую дату. Расхождение — сверка <code>date_check</code> дала <code>differ</code> / <code>llm_invented</code>. Больше 5% правок — повод для шага 4 ревью дат (структура от LLM).</p>`;
}

function ingestSection(v: UsageView): string {
  const byFeature = new Map(v.features.map((f) => [f.feature, f]));
  const i = v.inline;
  return `<h2 id="ingest">Контент → событие (US-65–67)</h2>
${table(
  ["Функция", "Пользователей", "Раз (за всё время)"],
  INGEST_FEATURES.map((f) => [featureLabel(f), byFeature.get(f)?.users ?? 0, byFeature.get(f)?.uses ?? 0]),
)}
<p class="muted">«Раз» — успешные: событие предложено или добавлено. Неудачи и отказы — в вызовах ниже.</p>
${table(
  ["Вызовы LLM (7 дней)", "Вызовов", "Ошибок", "≈ стоимость"],
  v.bySource.map((s) => [SOURCE_LABELS[s.source] ?? s.source, s.n, raw(`<span class="${s.errors ? "err" : ""}">${s.errors}</span>`), usd(s.cost)]),
  "вызовов не было",
)}
<h2 id="inline">Inline-карточки (US-95)</h2>
<div class="cards">
  <div class="card">Карточек за 7 дней<b>${i.cards7d}</b></div>
  <div class="card">Авторов за 7 дней<b>${i.authors7d}</b></div>
  <div class="card">Хранится карточек<b>${i.cardsStored}</b></div>
  <div class="card">«Добавить себе» за 7 дней<b>${i.adds7d}</b></div>
  <div class="card">«Добавить себе» за 60 дней / людей<b>${i.adds60d} / ${i.adders60d}</b></div>
</div>
<p class="muted">Карточка — уникальное событие автора (повторный inline-запрос строк не плодит), хранится до истечения ссылки; нажатия — 60 дней, один человек на сообщение — один раз.</p>`;
}
