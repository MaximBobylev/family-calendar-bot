// Панель «Квоты»: остатки у провайдеров LLM/STT/голоса (docs/admin-console.md, «Квоты»). Источник у каждой строки
// свой — API, заголовки последнего вызова или оценка по журналу; ключей на странице нет (src/ops/quotas.ts).

import type { QuotaReport } from "../../ops/quotas";
import type { QuotaRow } from "../../ops/quota-rules";
import { badge, esc, fmtAge, fmtTime, type Level, raw, table } from "./layout";

const fmtNum = (v: number | null | undefined, unit: string) => {
  if (v === null || v === undefined) return "—";
  if (unit === "$" || unit === "¥") return `${unit}${v.toFixed(2)}`;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
};

function sourceText(r: QuotaRow, now: number): string {
  if (r.source === "api") return `API · ${fmtAge(r.at, now)}`;
  if (r.source === "headers") return `заголовки последнего вызова · ${fmtTime(r.at)} (${fmtAge(r.at, now)})`;
  return "оценка по журналу";
}

const levelOf = (r: QuotaRow): Level => (r.level === "unknown" ? "unknown" : r.level);

function remainingCell(r: QuotaRow) {
  const left = fmtNum(r.remaining, r.unit);
  const of = r.limit === null ? "" : ` из ${fmtNum(r.limit, r.unit)}`;
  const share = r.remaining !== null && r.limit ? ` (${Math.round((r.remaining / r.limit) * 100)}%)` : "";
  const cls = r.level === "crit" ? "err" : r.level === "warn" ? "warn" : "";
  return raw(`<b class="${cls}">${esc(left)}</b>${esc(of + share)}`);
}

export function quotasBody(v: QuotaReport): string {
  const rows: unknown[][] = [];
  for (const p of v.probes) {
    if (p.off) rows.push([p.provider, raw(`<span class="muted">не подключён: ${esc(p.off)}</span>`), "", "", "", "", ""]);
    for (const r of p.rows)
      rows.push([
        r.provider,
        r.metric,
        remainingCell(r),
        r.used === undefined || r.used === null ? "—" : fmtNum(r.used, r.unit),
        r.resetAt ? `${fmtTime(r.resetAt)}` : "—",
        raw(`${r.level === "unknown" ? "" : `${badge(levelOf(r))} `}${esc(sourceText(r, v.now))}`),
        r.note ?? "",
      ]);
    if (p.error) rows.push([p.provider, raw(`<span class="err">не удалось получить: ${esc(p.error)}</span>`), "", "", "", "", ""]);
  }
  const headers = v.headers.map((h) => [
    h.provider,
    `${fmtTime(h.at)} (${fmtAge(h.at, v.now)})`,
    raw(h.status === 200 ? "200" : `<span class="err">${h.status}</span>`),
    raw(
      `<code>${Object.entries(h.headers)
        .map(([k, val]) => `${esc(k)}: ${esc(val)}`)
        .join("<br>")}</code>`,
    ),
  ]);
  return `<h1>Квоты провайдеров</h1>
<p class="muted">Остатки бесплатных квот и балансов. Квоту моделей страница не тратит: только бесплатные эндпоинты остатков, заголовки настоящих вызовов бота и наш журнал. Ответы API — ${v.cached ? "из кеша" : "запрошены"} ${esc(fmtAge(v.fetchedAt, v.now))} (кеш 1 мин). Жёлтым — меньше 20% остатка.</p>
${table(["Провайдер", "Что", "Осталось", "Израсходовано", "Сброс", "Источник", "Примечание"], rows, "провайдеры не настроены")}
<h2>Заголовки лимитов последних вызовов</h2>
${table(["Провайдер", "Когда", "Статус", "Заголовки"], headers, "вызовов с заголовками x-ratelimit-* ещё не было")}
<h2>Где остатков не узнать</h2>
<ul>
  <li><b>Gemini</b> — API остатка нет; дневной лимит модели на бесплатном тарифе виден только в AI Studio (Rate limits), сброс в 00:00 по Тихоокеанскому времени. Здесь — наш расход за эти сутки.</li>
  <li><b>Workers AI</b> — точный расход neurons даёт только GraphQL Analytics (<code>aiInferenceAdaptiveGroups</code>), токену нужно право <i>Account Analytics: Read</i>; без него — оценка по журналу бота (без скриптов замеров и других Worker'ов аккаунта).</li>
  <li><b>Groq</b> — эндпоинта остатка нет; суточные запросы — из заголовков последнего распознавания, секунды аудио — по журналу.</li>
  <li><b>Google Calendar API</b> — квота проекта (запросы в минуту на пользователя и на проект) видна только в Google Cloud Console; её превышение бот показывает как «Google просит подождать» (US-14).</li>
  <li><b>Telegram Bot API</b> — квоты нет, только ограничения частоты отправки (≈30 сообщений в секунду, 1 в секунду в один чат) без счётчика.</li>
</ul>`;
}
