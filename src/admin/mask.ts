// Маскирование по умолчанию (docs/admin-console.md): вместо пользователя — псевдоним; фрагменты дат открыты (предмет
// отладки), остальной текст — ▒ по длине слова.

import { extractDateSpans } from "../dates/extract";

export const MASK_CHAR = "▒";

// Производный от TOKEN_ENCRYPTION_KEY: отдельный секрет не нужен, по нему не восстановить id.
export async function pseudonymKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(`admin-pseudonym:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

// 6 hex — без коллизий на сотнях пользователей (4 hex дали бы их уже к бете).
export async function pseudonym(key: CryptoKey, userId: string | null): Promise<string> {
  if (!userId) return "u-удалён";
  return `u-${await hmac6(key, userId)}`;
}

// Другое пространство HMAC: с псевдонимами пользователей не совпадает.
export async function chatPseudonym(key: CryptoKey, chatId: string): Promise<string> {
  return `c-${await hmac6(key, `chat:${chatId}`)}`;
}

async function hmac6(key: CryptoKey, value: string): Promise<string> {
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
  return [...mac.slice(0, 3)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const maskWord = (w: string) => w.replace(/[\p{L}\p{N}]/gu, MASK_CHAR);

// То же деление на слова, что в extractDateSpans: пробелы, без краевой пунктуации; пустые не считаются.
const stripEdges = (w: string) => w.replace(/^[«"(,.!?]+|[»"),.!?]+$/g, "");

function dateWordIndexes(text: string, nowLocal: string, tz: string): Set<number> {
  const used = new Set<number>();
  for (const kind of ["point", "range"] as const) {
    try {
      for (const i of extractDateSpans(text, nowLocal, tz, kind).usedWords) used.add(i);
    } catch {
      // Сбой парсера не должен открывать текст: просто ничего не считаем датой
    }
  }
  return used;
}

export function maskText(text: string, nowLocal: string, tz: string): string {
  const open = dateWordIndexes(text, nowLocal, tz);
  let index = 0;
  return text
    .split(/(\s+)/)
    .map((part) => {
      if (!part || /^\s+$/.test(part)) return part;
      if (!stripEdges(part)) return part; // одна пунктуация — в нумерацию слов не входит
      return open.has(index++) ? part : maskWord(part);
    })
    .join("");
}

// Только поля без текста пользователя: имя интента, перечисления, числа.
const OPEN_KEYS = new Set(["name", "reference", "listIndex", "scope", "allDay", "language"]);

function maskValue(v: unknown, nowLocal: string, tz: string): unknown {
  if (typeof v === "string") return maskText(v, nowLocal, tz);
  if (Array.isArray(v)) return v.map((x) => maskValue(x, nowLocal, tz));
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, OPEN_KEYS.has(k) && typeof x !== "object" ? x : maskValue(x, nowLocal, tz)]));
  }
  return v;
}

export function maskResult(json: string | null, nowLocal: string, tz: string): string {
  if (!json) return "";
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return maskError(json);
  }
  if (typeof v === "string") return JSON.stringify(maskError(v));
  return JSON.stringify(maskValue(v, nowLocal, tz));
}

export function intentOf(json: string | null): string | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as { name?: unknown };
    return v && typeof v === "object" && typeof v.name === "string" ? v.name : null;
  } catch {
    return null;
  }
}

const ERROR_MAX = 300;

/**
 * Текст ошибки (inbox.error, scheduled_jobs.last_error, ошибка вызова): в нём может оказаться текст пользователя
 * или ответ Google. Открыты: ведущие «классы» до двоеточия из ASCII («Error: telegram sendMessage:») и коды ≤ 3 цифр.
 */
export function maskError(error: string | null): string {
  if (!error) return "";
  let rest = error.slice(0, ERROR_MAX);
  let head = "";
  for (let i = 0; i < 3; i++) {
    const m = /^([A-Za-z][A-Za-z0-9 _./-]{0,40}):\s*/.exec(rest);
    if (!m) break;
    head += m[0];
    rest = rest.slice(m[0].length);
  }
  const masked = rest
    .split(/(\s+)/)
    .map((part) => (/^\s*$/.test(part) || /^\(?\d{1,3}\)?[.,:]?$/.test(part) ? part : maskWord(part)))
    .join("");
  return head + masked + (error.length > ERROR_MAX ? "…" : "");
}
