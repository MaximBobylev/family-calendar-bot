// По умолчанию замаскирован; «Показать» — с причиной и записью в admin_audit.

import { flow, type Replay } from "../yaml-snippet";
import { esc, escPre, fmtTime, raw, table, usd } from "./layout";

export interface JournalListItem {
  id: string;
  created_at: number;
  user: string;
  kind: string;
  intent: string | null;
  outcome: string | null;
  maskedText: string;
}

export interface JournalFilterView {
  u?: string;
  kind?: string;
  outcome?: string;
  intent?: string;
}

export function journalListBody(items: JournalListItem[], f: JournalFilterView, nextBefore: number | null): string {
  const opt = (value: string, current: string | undefined, label = value) =>
    `<option value="${esc(value)}"${value === (current ?? "") ? " selected" : ""}>${esc(label)}</option>`;
  const filters = `<form class="inline" method="get" action="/admin/journal">
  <label>Пользователь<input name="u" value="${esc(f.u ?? "")}" placeholder="u-3f9a2c" size="10"></label>
  <label>Тип<select name="kind">${opt("", f.kind, "все")}${opt("llm", f.kind)}${opt("stt", f.kind)}</select></label>
  <label>Итог<select name="outcome">${opt("", f.outcome, "все")}${opt("ok", f.outcome)}${opt("error", f.outcome)}</select></label>
  <label>Интент<input name="intent" value="${esc(f.intent ?? "")}" placeholder="create_event" size="14"></label>
  <button type="submit">Фильтр</button> <a href="/admin/journal">сбросить</a>
</form>`;
  const rows = items.map((j) => [
    fmtTime(j.created_at),
    raw(`<a href="/admin/journal?u=${encodeURIComponent(j.user)}">${esc(j.user)}</a>`),
    j.kind,
    j.intent ?? "—",
    j.maskedText,
    raw(j.outcome === "error" ? `<span class="err">error</span>` : esc(j.outcome ?? "")),
    raw(`<a href="/admin/journal/${encodeURIComponent(j.id)}">открыть</a>`),
  ]);
  const qs = new URLSearchParams(Object.entries({ ...f, before: nextBefore ? String(nextBefore) : "" }).filter(([, v]) => v) as [string, string][]);
  return `<h1>Журнал распознанного</h1>
<p class="note">Тексты замаскированы: открыты только фрагменты дат и интент. Полный текст строки — через «открыть» → «Показать» с причиной (записывается в аудит).</p>
${filters}
${table(["Время", "Пользователь", "Тип", "Интент", "Текст (маска)", "Итог", ""], rows, "записей нет")}
${nextBefore ? `<p><a href="/admin/journal?${esc(qs.toString())}">раньше →</a></p>` : ""}`;
}

export const REVEAL_REASONS = ["Отладка NLU", "Жалоба пользователя", "Инцидент", "Другое"] as const;

export interface JournalDetailView {
  id: string;
  created_at: number;
  user: string;
  kind: string;
  model: string;
  outcome: string | null;
  intent: string | null;
  tokens: string;
  costMicroUsd: number | null;
  now: string;
  tz: string;
  text: string;
  result: string;
  replay: Replay | null;
  // Как записала LLM — для сравнения с извлечением сейчас.
  llmSlots: [string, string][];
  datesSnippet: string;
  extractSnippet: string;
  revealed: { auditId: number; reason: string } | null;
  revealError?: string;
}

const pre = (s: string) => `<pre>${escPre(s)}</pre>`;

function revealForm(v: JournalDetailView): string {
  return `<h2>Показать полный текст</h2>
${v.revealError ? `<p class="err">${esc(v.revealError)}</p>` : ""}
<form class="inline" method="post" action="/admin/journal/${encodeURIComponent(v.id)}/reveal">
  <label>Причина<select name="reason" required><option value="">— выберите —</option>${REVEAL_REASONS.map((r) => `<option>${esc(r)}</option>`).join("")}</select></label>
  <label>Комментарий (для «Другое» — обязательно)<input name="note" size="40" maxlength="200"></label>
  <button type="submit">Показать</button>
</form>
<p class="muted">Показ этой строки записывается в аудит: кто, когда, причина.</p>`;
}

function replaySection(v: JournalDetailView): string {
  if (!v.replay) return `<p class="muted">Текста нет (удалён по сроку хранения или это не фраза).</p>`;
  const r = v.replay;
  const rows = r.fragments.map((f) => [f.field, f.kind, raw(`<code>${esc(f.text)}</code>`), raw(`<code>${esc(flow(f.result))}</code>`)]);
  return `<p class="muted">Текущие извлечение и парсер дат на тексте этой строки (без LLM, бесплатно), «сейчас» = ${esc(v.now)} ${esc(v.tz)}, вид — ${r.kind}.</p>
${table(["Поле", "Вид", "Фрагмент сейчас", "Разбор сейчас"], rows, "дат не найдено")}
${v.llmSlots.length ? `<p>LLM тогда: ${v.llmSlots.map(([k, s]) => `${esc(k)} = <code>${esc(s)}</code>`).join(", ")}</p>` : ""}`;
}

export function journalDetailBody(v: JournalDetailView): string {
  const meta = table(
    ["", ""],
    [
      ["Время", `${fmtTime(v.created_at)} · у пользователя ${v.now} (${v.tz})`],
      ["Пользователь", v.user],
      ["Тип, модель", `${v.kind} · ${v.model}`],
      ["Интент", v.intent ?? "—"],
      ["Итог", v.outcome ?? ""],
      ["Токены / аудио", v.tokens],
      ["Стоимость", v.costMicroUsd === null ? "—" : usd(v.costMicroUsd)],
    ],
  );
  const state = v.revealed
    ? `<p class="note">Показано по причине «${esc(v.revealed.reason)}» — запись аудита #${v.revealed.auditId}. Не копируйте текст в репозиторий без анонимизации.</p>`
    : `<p class="note">Замаскировано: открыты фрагменты дат и интент.</p>`;
  return `<h1>Запись журнала</h1>
<p><a href="/admin/journal">← журнал</a></p>
${state}
${meta}
<h2>Текст${v.revealed ? "" : " (маска)"}</h2>
${pre(v.text || "—")}
<h2>Результат${v.revealed ? "" : " (маска)"}</h2>
${pre(v.result || "—")}
${v.revealed ? "" : revealForm(v)}
<h2>Replay: даты сейчас</h2>
${replaySection(v)}
<h2>«В тест»: даты</h2>
${pre(v.datesSnippet)}
<h2>«В тест»: извлечение</h2>
${pre(v.extractSnippet)}
<p class="muted">Админка в репозиторий не пишет: скопируйте заготовку, проверьте ожидание и анонимизируйте текст.</p>`;
}
