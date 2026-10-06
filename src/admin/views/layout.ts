// Общий каркас страниц админки: серверный HTML, без JS и внешних ресурсов (CSP default-src 'none').

import { SECURITY_HEADERS } from "../../pages";

export const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
/** Для содержимого <pre>: кавычки внутри элемента безопасны и нужны в YAML для копирования как есть. */
export const escPre = (v: string) => v.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

export const fmtTime = (ms: number | null | undefined) => (ms ? `${new Date(ms).toISOString().replace("T", " ").slice(0, 16)} UTC` : "—");

export function fmtAge(ms: number | null | undefined, now: number): string {
  if (!ms) return "—";
  const d = Math.max(0, now - ms);
  if (d < 60_000) return `${Math.round(d / 1000)} с назад`;
  if (d < 3_600_000) return `${Math.round(d / 60_000)} мин назад`;
  if (d < 2 * 86_400_000) return `${Math.round(d / 3_600_000)} ч назад`;
  return `${Math.round(d / 86_400_000)} дн назад`;
}

export const usd = (micro: number) => {
  const v = micro / 1e6;
  return `$${v.toFixed(v < 1 ? 4 : 2)}`;
};

/** Ячейка с готовым HTML (уже экранированным). */
export interface Html {
  html: string;
}
export const raw = (html: string): Html => ({ html });
const cell = (c: unknown) => (typeof c === "object" && c !== null && "html" in c ? (c as Html).html : esc(c));

export function table(headers: string[], rows: unknown[][], empty = "нет данных"): string {
  if (rows.length === 0) return `<p class="muted">${esc(empty)}</p>`;
  return `<div class="scroll"><table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${cell(c)}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>`;
}

export type Level = "ok" | "warn" | "crit" | "unknown";
const LEVEL_TEXT: Record<Level, string> = { ok: "OK", warn: "ВНИМАНИЕ", crit: "СБОЙ", unknown: "НЕТ ДАННЫХ" };
export const badge = (level: Level) => `<span class="badge ${level}">${LEVEL_TEXT[level]}</span>`;

const NAV: [string, string][] = [
  ["/admin", "Здоровье"],
  ["/admin/sync", "Синхронизация"],
  ["/admin/households", "Дома"],
  ["/admin/journal", "Журнал"],
  ["/admin/usage", "Расход"],
  ["/admin/audit", "Аудит"],
];

export function page(opts: { title: string; active: string; operator: string; now: number; body: string; status?: number }): Response {
  const nav = NAV.map(([href, label]) => `<a href="${href}"${href === opts.active ? ' aria-current="page"' : ""}>${label}</a>`).join("");
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(opts.title)} — админка</title>
<style>
  :root { color-scheme: light dark; --line: color-mix(in srgb, currentColor 15%, transparent); --tint: color-mix(in srgb, currentColor 7%, transparent); }
  body { font: 14px/1.45 system-ui, sans-serif; margin: 0 auto; max-width: 76em; padding: 1em 1em 4em; }
  header { display: flex; flex-wrap: wrap; gap: .4em 1.2em; align-items: baseline; border-bottom: 1px solid var(--line); padding-bottom: .6em; }
  header b { font-size: 1.05em; } nav { display: flex; flex-wrap: wrap; gap: 1em; } nav a[aria-current] { font-weight: 600; text-decoration: none; }
  h1 { font-size: 1.35em; margin-top: 1em; } h2 { font-size: 1.1em; margin-top: 1.8em; }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(11em, 1fr)); gap: .7em; }
  .card { padding: .7em .9em; border-radius: 8px; background: var(--tint); }
  .card b { display: block; font-size: 1.5em; }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: .95em; }
  th, td { text-align: left; padding: .35em .6em; border-bottom: 1px solid var(--line); vertical-align: top; }
  code, pre { font: .9em/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-word; }
  pre { white-space: pre-wrap; padding: .8em 1em; border-radius: 8px; background: var(--tint); user-select: all; }
  .muted { opacity: .65; } .err { color: #d33; }
  .badge { display: inline-block; padding: .05em .5em; border-radius: 4px; font-size: .8em; font-weight: 600; color: #fff; }
  .badge.ok { background: #2a8a3e; } .badge.warn { background: #c78100; } .badge.crit { background: #d33; } .badge.unknown { background: #777; }
  .note { padding: .7em 1em; border-radius: 8px; background: var(--tint); }
  form.inline { display: flex; flex-wrap: wrap; gap: .5em; align-items: end; }
  label { display: flex; flex-direction: column; gap: .2em; font-size: .9em; }
  input, select, button { font: inherit; padding: .3em .5em; }
</style></head><body>
<header><b>Calendar Assist Bot — админка</b><nav>${nav}</nav><span class="muted">${esc(opts.operator)} · ${fmtTime(opts.now)}</span></header>
${opts.body}
</body></html>`;
  return new Response(html, {
    status: opts.status ?? 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex",
      "x-frame-options": "DENY",
      ...SECURITY_HEADERS,
      // Свой Origin в POST форм (при no-referrer браузер шлёт Origin: null) — по нему проверка в auth.ts:sameOrigin
      "referrer-policy": "same-origin",
      // Формы админки — только на себя
      "content-security-policy": `${SECURITY_HEADERS["content-security-policy"]}; form-action 'self'`,
    },
  });
}
