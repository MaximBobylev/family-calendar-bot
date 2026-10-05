// «В тест» и replay (docs/admin-console.md #6, #7): фраза из журнала → заготовка YAML для переносимых наборов
// (testdata/dates, testdata/extract) и прогон текущего детерминированного извлечения/парсера дат.
// Чисто: без D1, сети и LLM. Админка в репозиторий не пишет — заготовку копируют руками.

import { parseDateFragment, type ParseResult, type ValueKind } from "../dates";
import { formatMoment, utcToLocal } from "../dates/calendar";
import { extractDateSpans } from "../dates/extract";

/** «Сейчас» фразы — локальное время пользователя без смещения, как в testdata («2026-10-07T10:00»). */
export function localNow(utcMs: number, tz: string): { now: string; tz: string } {
  try {
    return { now: formatMoment(utcToLocal(utcMs, tz)), tz };
  } catch {
    return { now: formatMoment(utcToLocal(utcMs, "UTC")), tz: "UTC" };
  }
}

export interface ReplayFragment {
  field: "point" | "range" | "duration";
  kind: ValueKind;
  text: string;
  result: ParseResult;
}

export interface Replay {
  /** Как извлекались даты: list_events — период, остальное — момент (как в обработке команд). */
  kind: "point" | "range";
  spans: { point?: string; range?: string; duration?: string };
  fragments: ReplayFragment[];
}

export function replay(text: string, now: string, tz: string, intent: string | null): Replay {
  const kind = intent === "list_events" ? "range" : "point";
  const { usedWords: _u, ...spans } = extractDateSpans(text, now, tz, kind);
  const fragments: ReplayFragment[] = [];
  for (const field of ["point", "range", "duration"] as const) {
    const fragment = spans[field];
    if (!fragment) continue;
    const k: ValueKind = field === "duration" ? "duration" : field;
    fragments.push({ field, kind: k, text: fragment, result: parseDateFragment({ text: fragment, kind: k, now, tz }) });
  }
  return { kind, spans, fragments };
}

/** Значение в стиле YAML flow — как пишут testdata: `{ datetime: "2026-10-09T15:00" }`, `{ error: in_past }`. */
export function flow(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return `[${v.map(flow).join(", ")}]`;
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
    return entries.length ? `{ ${entries.map(([k, x]) => `${k}: ${flow(x)}`).join(", ")} }` : "{}";
  }
  if (typeof v === "string") return /^[a-z][a-z_]*$/.test(v) ? v : JSON.stringify(v);
  return String(v);
}

/** Заготовка для testdata/dates/<файл>.yaml: по кейсу на фрагмент, ожидание = текущий разбор. */
export function datesSnippet(r: Replay, now: string, tz: string, idBase: string): string {
  const head = "# testdata/dates/<файл>.yaml → cases: — ожидание = текущий разбор, проверьте и поправьте";
  if (r.fragments.length === 0) return `${head}\n# дат в тексте не найдено — заготовки нет`;
  const cases = r.fragments.map((f, i) =>
    [
      `- id: ${idBase}-${i + 1}`,
      `  text: ${JSON.stringify(f.text)}`,
      `  kind: ${f.kind}`,
      `  now: ${JSON.stringify(now)}`,
      `  tz: ${tz}`,
      `  expect: ${flow(f.result)}`,
    ].join("\n"),
  );
  return [head, ...cases].join("\n");
}

/**
 * Заготовка для testdata/extract/cases.yaml. Текст — замаскированный (▒ заменить руками на нейтральные слова)
 * или показанный (тогда анонимизировать: имена, места, личное).
 */
export function extractSnippet(r: Replay, text: string, now: string, tz: string, revealed: boolean): string {
  const note = revealed
    ? "# ТЕКСТ НЕ АНОНИМИЗИРОВАН: замените имена, места и личное на нейтральные слова, даты не трогайте"
    : "# Текст замаскирован: замените ▒ на нейтральные слова (без имён и личных данных), даты не трогайте";
  return [
    `# testdata/extract/cases.yaml → cases: (фраза записана при now ${now}, tz ${tz}; в файле — общие defaults)`,
    note,
    `- { kind: ${r.kind}, text: ${JSON.stringify(text)}, expect: ${flow(r.spans)} }`,
  ].join("\n");
}
