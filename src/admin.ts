// Страница статистики для владельца бота: GET /admin, HTTP Basic auth (ADMIN_USER / ADMIN_PASSWORD).
// Только чтение. Показывает журнал распознанного (US-13) — доступ только у владельца.

import type { AppContext } from "./bot/context";
import { COST_ESTIMATES } from "./config";

/** Цены Workers AI (docs/research/hosting-economics.md) — для оценки; одни на учёт и админку (config.ts). */
const PRICE = COST_ESTIMATES;

export function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export function checkAdminAuth(request: Request, user: string, password: string): boolean {
  if (!user || !password) return false;
  const header = request.headers.get("authorization") ?? "";
  const m = /^Basic\s+(.+)$/i.exec(header);
  if (!m) return false;
  let decoded: string;
  try {
    decoded = atob(m[1]!);
  } catch {
    return false;
  }
  const sep = decoded.indexOf(":");
  if (sep < 0) return false;
  return timingSafeEqual(decoded.slice(0, sep), user) && timingSafeEqual(decoded.slice(sep + 1), password);
}

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const fmtTime = (ms: number | null) => (ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "—");
const usd = (v: number) => `$${v.toFixed(v < 1 ? 4 : 2)}`;

function table(headers: string[], rows: unknown[][]): string {
  if (rows.length === 0) return `<p class="muted">нет данных</p>`;
  return `<table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${typeof c === "object" && c !== null && "html" in c ? (c as { html: string }).html : esc(c)}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;
}

export async function adminPage(ctx: AppContext): Promise<Response> {
  const db = ctx.db;
  const now = ctx.clock.now();
  const weekAgo = now - 7 * 86_400_000;
  const dayAgo = now - 86_400_000;

  const [totals, byDay, usage, intents, journal, failures, cards] = await Promise.all([
    db.prepare(
      `SELECT (SELECT count(*) FROM users) users,
              (SELECT count(*) FROM provider_accounts) accounts,
              (SELECT count(*) FROM calendars) calendars,
              (SELECT count(*) FROM inbox WHERE received_at > ?1) updates_24h,
              (SELECT count(*) FROM inbox WHERE status = 'failed') failed_total,
              (SELECT count(*) FROM inbox WHERE status IN ('pending', 'processing')) in_flight`,
    ).bind(dayAgo).first<Record<string, number>>(),
    db.prepare(
      `SELECT date(received_at / 1000, 'unixepoch') day, count(*) n,
              sum(status = 'failed') failed,
              round(avg(CASE WHEN status = 'done' THEN processed_at - received_at END)) lag_ms,
              max(CASE WHEN status = 'done' THEN processed_at - received_at END) max_lag_ms
       FROM inbox WHERE received_at > ? GROUP BY day ORDER BY day DESC`,
    ).bind(weekAgo).all<{ day: string; n: number; failed: number; lag_ms: number | null; max_lag_ms: number | null }>(),
    db.prepare(
      `SELECT kind, model, count(*) n, sum(outcome = 'error') errors,
              coalesce(sum(tokens_in), 0) tin, coalesce(sum(tokens_out), 0) tout, coalesce(sum(audio_ms), 0) audio_ms
       FROM usage_events WHERE created_at > ? GROUP BY kind, model ORDER BY kind`,
    ).bind(weekAgo).all<{ kind: string; model: string; n: number; errors: number; tin: number; tout: number; audio_ms: number }>(),
    db.prepare(
      `SELECT coalesce(json_extract(result_json, '$.name'), '(ошибка)') intent, count(*) n
       FROM usage_events WHERE kind = 'llm' AND created_at > ? GROUP BY intent ORDER BY n DESC`,
    ).bind(weekAgo).all<{ intent: string; n: number }>(),
    db.prepare(
      `SELECT created_at, kind, text, result_json, outcome FROM usage_events ORDER BY created_at DESC LIMIT 50`,
    ).all<{ created_at: number; kind: string; text: string | null; result_json: string | null; outcome: string }>(),
    db.prepare(
      `SELECT update_id, received_at, attempts, error FROM inbox WHERE status = 'failed' ORDER BY received_at DESC LIMIT 20`,
    ).all<{ update_id: number; received_at: number; attempts: number; error: string | null }>(),
    db.prepare(
      `SELECT kind, status, count(*) n FROM pending_actions WHERE created_at > ? GROUP BY kind, status ORDER BY kind, status`,
    ).bind(weekAgo).all<{ kind: string; status: string; n: number }>(),
  ]);

  let cost = 0;
  const usageRows = usage.results.map((u) => {
    const c = u.kind === "llm" ? (u.tin / 1e6) * PRICE.llmInPerM + (u.tout / 1e6) * PRICE.llmOutPerM : (u.audio_ms / 60_000) * PRICE.sttPerMin;
    cost += c;
    return [u.kind, u.model, u.n, u.errors, u.kind === "llm" ? `${u.tin} / ${u.tout}` : `${(u.audio_ms / 60_000).toFixed(1)} мин`, usd(c)];
  });

  const t = totals ?? {};
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Admin — Calendar Assist Bot</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.45 system-ui, sans-serif; margin: 0 auto; max-width: 72em; padding: 1.5em 1em 4em; }
  h1 { font-size: 1.4em; } h2 { font-size: 1.1em; margin-top: 2em; }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(10em, 1fr)); gap: .8em; }
  .card { padding: .8em 1em; border-radius: 8px; background: color-mix(in srgb, currentColor 7%, transparent); }
  .card b { display: block; font-size: 1.6em; }
  table { border-collapse: collapse; width: 100%; font-size: .95em; }
  th, td { text-align: left; padding: .35em .6em; border-bottom: 1px solid color-mix(in srgb, currentColor 15%, transparent); vertical-align: top; }
  td code { font-size: .9em; word-break: break-all; }
  .muted { opacity: .6; } .err { color: #d33; }
</style></head><body>
<h1>Calendar Assist Bot — статистика</h1>
<p class="muted">Сейчас: ${fmtTime(now)} · за 7 дней, если не указано иное</p>
<div class="cards">
  <div class="card">Пользователи<b>${t.users ?? 0}</b></div>
  <div class="card">Google-аккаунты<b>${t.accounts ?? 0}</b></div>
  <div class="card">Календари<b>${t.calendars ?? 0}</b></div>
  <div class="card">Апдейтов за 24 ч<b>${t.updates_24h ?? 0}</b></div>
  <div class="card">В обработке<b>${t.in_flight ?? 0}</b></div>
  <div class="card">Ошибок всего<b class="${t.failed_total ? "err" : ""}">${t.failed_total ?? 0}</b></div>
  <div class="card">AI, 7 дней<b>${usd(cost)}</b></div>
</div>

<h2>Апдейты по дням</h2>
${table(["День (UTC)", "Апдейтов", "Ошибок", "Задержка обработки, ср.", "макс."], byDay.results.map((d) => [d.day, d.n, d.failed, d.lag_ms === null ? "—" : `${d.lag_ms} мс`, d.max_lag_ms === null ? "—" : `${d.max_lag_ms} мс`]))}

<h2>AI: вызовы и стоимость</h2>
${table(["Тип", "Модель", "Вызовов", "Ошибок", "Токены вх/вых · аудио", "≈ стоимость"], usageRows)}

<h2>Интенты</h2>
${table(["Интент", "Раз"], intents.results.map((i) => [i.intent, i.n]))}

<h2>Карточки</h2>
${table(["Тип", "Статус", "Количество"], cards.results.map((c) => [c.kind, c.status, c.n]))}

<h2>Ошибки обработки (последние 20)</h2>
${table(["Время", "update_id", "Попыток", "Ошибка"], failures.results.map((f) => [fmtTime(f.received_at), f.update_id, f.attempts, { html: `<code class="err">${esc((f.error ?? "").slice(0, 400))}</code>` }]))}

<h2>Журнал распознанного (последние 50)</h2>
${table(["Время", "Тип", "Текст", "Результат", "Итог"], journal.results.map((j) => [fmtTime(j.created_at), j.kind, j.text ?? "", { html: `<code>${esc((j.result_json ?? "").slice(0, 300))}</code>` }, j.outcome]))}
</body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex", "x-frame-options": "DENY", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" } });
}
