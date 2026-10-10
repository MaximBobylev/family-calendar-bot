// Одна строка JSON на событие (tech-debt #7). Только служебные поля — без текстов пользователей.

export type LogFields = Record<string, string | number | boolean | null | undefined>;

export function log(event: string, fields: LogFields = {}): void {
  const line: Record<string, unknown> = { event };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) line[k] = v;
  const text = JSON.stringify(line);
  if (fields.outcome === "error") console.error(text);
  else console.log(text);
}

/** Хвост сообщения ошибки может содержать данные пользователя — берём только ведущие ASCII-«классы» (`google 500:`). */
export function errorClass(e: unknown): string {
  if (!(e instanceof Error)) return "unknown";
  const prefix = /^(?:[A-Za-z0-9_ ./-]{1,40}:){1,3}/.exec(e.message)?.[0] ?? "";
  return `${e.name}${prefix ? `: ${prefix}` : ""}`.slice(0, 120);
}

export async function logged<T>(event: string, fields: LogFields, fn: () => Promise<T>): Promise<T> {
  const started = Date.now(); // только длительность, не «сейчас» логики
  try {
    const result = await fn();
    log(event, { ...fields, outcome: typeof result === "string" ? result : "ok", ms: Date.now() - started });
    return result;
  } catch (e) {
    log(event, { ...fields, outcome: "error", error: errorClass(e), ms: Date.now() - started });
    throw e;
  }
}
