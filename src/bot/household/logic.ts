// Чистая логика дома и группового чата (US-90, US-94): разбор команд /home, имени с другими именами, ссылки-приглашения,
// «обращено ли сообщение в группе к боту» (privacy mode). Без D1 и сети — юнит-тесты в test/household-logic.test.ts.

import type { TgMessage } from "../../telegram/types";

/** Приглашение действует 48 часов и годится для одного человека (US-90, [решение 2026-10-06]). */
export const HOUSEHOLD_INVITE_TTL_MS = 48 * 60 * 60 * 1000;
/** Участников в доме вместе с владельцем — до открытого вопроса family-plan.md о размере дома. */
export const HOUSEHOLD_MAX_MEMBERS = 5;
/** Детей (dependents) в доме. */
export const HOUSEHOLD_MAX_DEPENDENTS = 10;
const MAX_NAME_LEN = 32;
const MAX_ALIASES = 8;
const MAX_HOUSEHOLD_NAME_LEN = 40;

export type HouseholdCommand =
  | { kind: "menu" }
  | { kind: "create"; name: string }
  | { kind: "name"; name: string; aliases: string[] }
  | { kind: "kid"; name: string; aliases: string[] }
  | { kind: "invite"; preset?: { name: string; aliases: string[] } }
  | { kind: "link" }
  | { kind: "unlink" }
  | { kind: "leave" }
  /** /home с неизвестным подкомандой или без нужного аргумента — подсказка. */
  | { kind: "help" };

/** «Создай дом "Бобылевы"», «создать дом Бобылевы» — без LLM. */
const CREATE_PHRASE = /^(?:создай|создать|заведи|завести)\s+(?:новый\s+)?дом\s+(.+)$/i;
/** /home и /home@bot; подкоманда — после пробела. */
const HOME_COMMAND = /^\/home(?:@\w+)?(?:\s+(\S+)(?:\s+([\s\S]*))?)?$/i;

/** Разбор команд дома; null — это не команда дома (дальше — обычный путь). */
export function parseHouseholdCommand(text: string): HouseholdCommand | null {
  const s = text.trim();
  if (/^\/leave(@\w+)?$/i.test(s)) return { kind: "leave" };
  const create = CREATE_PHRASE.exec(s);
  if (create) {
    const name = cleanHouseholdName(create[1]!);
    return name ? { kind: "create", name } : { kind: "help" };
  }
  const m = HOME_COMMAND.exec(s);
  if (!m) return null;
  const sub = m[1]?.toLowerCase();
  const arg = m[2]?.trim() ?? "";
  if (!sub) return { kind: "menu" };
  switch (sub) {
    case "create": {
      const name = cleanHouseholdName(arg);
      return name ? { kind: "create", name } : { kind: "help" };
    }
    case "name":
    case "me": {
      const parsed = parseNameAndAliases(arg);
      return parsed ? { kind: "name", ...parsed } : { kind: "help" };
    }
    case "kid":
    case "child": {
      const parsed = parseNameAndAliases(arg);
      return parsed ? { kind: "kid", ...parsed } : { kind: "help" };
    }
    case "invite": {
      const preset = parseNameAndAliases(arg);
      return preset ? { kind: "invite", preset } : { kind: "invite" };
    }
    case "link":
      return { kind: "link" };
    case "unlink":
      return { kind: "unlink" };
    case "leave":
      return { kind: "leave" };
    default:
      return { kind: "help" };
  }
}

/** Название дома: без кавычек и «ёлочек», обрезано по длине; пустое — null. */
export function cleanHouseholdName(raw: string): string | null {
  const name = raw
    .trim()
    .replace(/^["«“'„]+|["»”'“]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_HOUSEHOLD_NAME_LEN);
  return name || null;
}

/**
 * «Дима, муж, папа» → имя «Дима» и другие имена [«муж», «папа»] (US-90: алиасы участника). Повторы и пустые убраны,
 * длина ограничена. Пусто — null.
 */
export function parseNameAndAliases(raw: string): { name: string; aliases: string[] } | null {
  const parts = raw
    .split(/[,;\n]/)
    .map((p) => p.trim().replace(/\s+/g, " ").slice(0, MAX_NAME_LEN))
    .filter(Boolean);
  const unique: string[] = [];
  for (const p of parts) if (!unique.some((u) => u.toLowerCase() === p.toLowerCase())) unique.push(p);
  const [name, ...aliases] = unique;
  return name ? { name, aliases: aliases.slice(0, MAX_ALIASES) } : null;
}

/**
 * Похоже на ответ «имя и другие имена», а не на команду: без «?», цифр и слэша, до 8 частей по 1–3 слова
 * («Аня, жена, мама»). «Что у нас завтра?» — не имя.
 */
export function looksLikeNames(text: string): boolean {
  const s = text.trim();
  if (!s || s.length > 120 || /[?!/\d@#]/.test(s)) return false;
  const parts = s
    .split(/[,;\n]/)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length > 0 && parts.length <= 8 && parts.every((p) => p.split(/\s+/).length <= 3);
}

/** Код из `/start home_<code>` (deep link приглашения); иначе null. */
export function parseHomeStart(text: string | undefined): string | null {
  const m = /^\/start(?:@\w+)?\s+home_([A-Za-z0-9_-]{6,64})$/.exec(text?.trim() ?? "");
  return m ? m[1]! : null;
}

/** Ссылка-приглашение. Без имени бота в конфиге — команда, которую можно отправить боту вручную. */
export function inviteLink(botUsername: string, code: string): string {
  return botUsername ? `https://t.me/${botUsername}?start=home_${code}` : `/start home_${code}`;
}

/** Похоже на общий календарь по названию или другому имени: «Семья», «Family», «Дом», «Общий». */
const SHARED_TITLE = /сем[ьеяй]|family|дом|home|общ|shared/i;

/**
 * Календари дома по умолчанию при создании (US-90, [решение 2026-10-06, изменено по ревью R1]): только календари с «общими»
 * названиями (или другими именами) и с правом записи. Основной календарь владельца — обычно личный и рабочий вперемешку —
 * по умолчанию НЕ общий. Нет ни одного — владелец выбирает сам (или создаёт «Семья» в Google).
 */
export function defaultHouseholdCalendars(calendars: { id: string; title: string; writable: boolean; isDefault: boolean; aliases: string[] }[]): string[] {
  return calendars.filter((c) => c.writable && !c.isDefault && (SHARED_TITLE.test(c.title) || c.aliases.some((a) => SHARED_TITLE.test(a)))).map((c) => c.id);
}

/**
 * Обращено ли сообщение в группе к боту (privacy mode, US-94): команда (без @ или с @нашим_ботом), упоминание
 * @нашего_бота или ответ (reply) на сообщение бота. Остальную переписку не читаем.
 */
export function isAddressedToBot(message: Pick<TgMessage, "text" | "reply_to_message">, botUsername: string): boolean {
  const text = message.text?.trim() ?? "";
  const bot = botUsername.toLowerCase();
  const command = /^\/\w+(?:@(\w+))?/.exec(text);
  if (command) return !command[1] || command[1].toLowerCase() === bot;
  if (bot && new RegExp(`(^|[^\\w@])@${escapeRe(bot)}\\b`, "i").test(text)) return true;
  const replied = message.reply_to_message?.from;
  return !!replied?.is_bot && !!bot && replied.username?.toLowerCase() === bot;
}

/** Убрать обращение к боту: «@bot, что у нас в выходные?» → «что у нас в выходные?», «/home@bot link» → «/home link». */
export function stripBotMention(text: string, botUsername: string): string {
  if (!botUsername) return text.trim();
  const bot = escapeRe(botUsername);
  return text
    .replace(new RegExp(`^(/\\w+)@${bot}\\b`, "i"), "$1")
    .replace(new RegExp(`@${bot}\\b`, "gi"), " ")
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/^[\s,.:;!]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
