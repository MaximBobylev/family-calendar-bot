// Реестр интентов (docs/intents.md): схемы tools для LLM и разбор ответа.
// LLM не вычисляет даты — только копирует фрагменты, как сказано (ADR-0005 п.3).

import { callTools, type LlmConfig, type ToolDefinition } from "./llm";

export interface CreateEventIntent {
  name: "create_event";
  /** Фрагмент даты/времени как сказано, включая конец интервала: «завтра с часу до двух». */
  start: string;
  title?: string;
  duration?: string;
  allDay?: boolean;
  calendar?: string;
  location?: string;
}

export interface ModifyEventIntent {
  name: "modify_event";
  event?: string;
  reference?: "next" | "last" | "list";
  listIndex?: number;
  newTitle?: string;
  newLocation?: string;
  scope?: "this" | "all";
}

export type Intent =
  | { name: "list_events"; range: string; calendar?: string }
  | CreateEventIntent
  | ModifyEventIntent
  | { name: "unsupported" }
  | { name: "multiple" };

const str = (description: string) => ({ type: "string", description });

export const TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "list_events",
      description: "Show the user's calendar events for a period: «что у меня завтра», «покажи неделю», «what's on Friday».",
      parameters: {
        type: "object",
        properties: {
          range: str("The period exactly as the user said it, without computing dates: «завтра», «на этой неделе», «в пятницу после обеда»."),
          calendar: str("If the user named a calendar, its name exactly as written in the user's calendar list. Omit otherwise."),
        },
        required: ["range"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_event",
      description: "Create a new calendar event: «поставь встречу в среду в 12», «созвон с Петей завтра в 15:30 на полчаса», «отпуск с 10 по 20 ноября», «завтра день рождения мамы».",
      parameters: {
        type: "object",
        // Порядок важен: маленькие модели обрывают JSON на полях после title — title последним
        properties: {
          start: str("All date and time words copied verbatim, including the day and the end of a range: «завтра в 15:30», «в пятницу с часу до двух», «с 10 по 20 ноября»."),
          duration: str("Duration words verbatim: «на полчаса», «на два часа». Omit if not said."),
          all_day: { type: "boolean", description: "true for birthdays, anniversaries, holidays, vacations, whole-day events." },
          calendar: str("Only if the user explicitly named a calendar in this message: its name exactly as in the user's calendar list."),
          title: str("Event name only, without date/time/duration words: «Созвон с Петей». Omit if the user did not name it («встречу» is not a name)."),
        },
        required: ["start"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "modify_event",
      description: "Move or change an EXISTING event: «перенеси встречу с Петей на пятницу», «сдвинь созвон на час позже», «переименуй планёрку в Стендап», «сделай встречу на полтора часа».",
      parameters: {
        type: "object",
        properties: {
          event: str("Which event, without date/time words: «встречу с Петей», «планёрку», «созвон». Omit if referred to only as «её», «следующую», «вторую»."),
          reference: { type: "string", enum: ["next", "last", "list"], description: "«следующую встречу» → next; «её», «эту», «последнюю» → last; «вторую», «третью» (from a shown list) → list." },
          list_index: { type: "integer", description: "Position for reference=list: «вторую» → 2." },
          scope: { type: "string", enum: ["this", "all"], description: "For recurring events: «все планёрки», «всю серию» → all; «только эту», «в этот понедельник» → this. Omit if not said." },
          new_location: str("New place if the user sets one."),
          new_title: str("New name if the user renames the event: «переименуй в Ревью дизайна» → «Ревью дизайна»."),
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "unsupported",
      description: "The request is not about the user's calendar, or no other tool fits.",
      parameters: { type: "object", properties: {} },
    },
  },
];

export const SYSTEM_PROMPT = `You route a user's message (Russian or English) to exactly one calendar tool.
Copy date/time words VERBATIM from the message — never drop the day, never compute or translate dates.
Omit optional fields the user did not say. Never guess a calendar.
If the message is not about the user's calendar, call "unsupported".
Examples:
"Созвон с Петей завтра в 15:30 на полчаса" → create_event {"start":"завтра в 15:30","duration":"на полчаса","title":"Созвон с Петей"}
"Отпуск с 10 по 20 ноября" → create_event {"start":"с 10 по 20 ноября","all_day":true,"title":"Отпуск"}
"Поставь встречу на среду в 12" → create_event {"start":"на среду в 12"}
"Tomorrow at 3pm dentist" → create_event {"start":"Tomorrow at 3pm","title":"Dentist"}
"Что у меня в пятницу после обеда?" → list_events {"range":"в пятницу после обеда"}
"Перенеси встречу с Петей на пятницу" → modify_event {"event":"встречу с Петей"}
"Сдвинь следующую встречу на час позже" → modify_event {"reference":"next"}
"Переименуй её в Ревью дизайна" → modify_event {"reference":"last","new_title":"Ревью дизайна"}
"Сделай планёрку на полтора часа" → modify_event {"event":"планёрку"}   (changing an existing event, not creating)`;

export interface ParsedIntent {
  intent: Intent;
  tokensIn: number;
  tokensOut: number;
}

export interface IntentContext {
  /** Названия и алиасы календарей пользователя — чтобы «в семейном» превращалось в «Семья». */
  calendars: string[];
}

export async function parseIntent(cfg: LlmConfig, text: string, context: IntentContext): Promise<ParsedIntent> {
  // Qwen3 по умолчанию «думает»: медленно, дорого и ломает JSON аргументов — отключаем
  const noThink = /qwen3/i.test(cfg.model) ? "\n/no_think" : "";
  // Названия календарей задают третьи лица (подписки) — как данные, экранированно и коротко
  const calendars = context.calendars.map((c) => JSON.stringify(c.slice(0, 100))).join(", ");
  const system = `${SYSTEM_PROMPT}\nUser's calendars: ${calendars}.${noThink}`;
  const res = await callTools(cfg, system, text, TOOLS);
  const usage = { tokensIn: res.tokensIn, tokensOut: res.tokensOut };
  // В MVP — одна команда на сообщение (US-12)
  if (res.toolCalls.length > 1) return { intent: { name: "multiple" }, ...usage };
  const call = res.toolCalls[0];
  if (call?.name === "list_events" && typeof call.arguments.range === "string" && call.arguments.range.trim()) {
    const calendar = typeof call.arguments.calendar === "string" && call.arguments.calendar.trim() ? call.arguments.calendar : undefined;
    return { intent: { name: "list_events", range: call.arguments.range, ...(calendar ? { calendar } : {}) }, ...usage };
  }
  if (call?.name === "create_event") {
    // start может отсутствовать — даты всё равно извлекаются из текста (src/dates/extract.ts)
    const a = call.arguments;
    const opt = (k: string) => (typeof a[k] === "string" && (a[k] as string).trim() ? { [k]: (a[k] as string).trim() } : {});
    return {
      intent: {
        name: "create_event",
        start: typeof a.start === "string" ? a.start : "",
        ...opt("title"), ...opt("duration"), ...opt("calendar"), ...opt("location"),
        ...(a.all_day === true ? { allDay: true } : {}),
      } as CreateEventIntent,
      ...usage,
    };
  }
  if (call?.name === "modify_event") {
    const a = call.arguments;
    const str = (k: string) => (typeof a[k] === "string" && (a[k] as string).trim() ? (a[k] as string).trim() : undefined);
    const reference = ["next", "last", "list"].includes(String(a.reference)) ? (a.reference as "next" | "last" | "list") : undefined;
    const scope = ["this", "all"].includes(String(a.scope)) ? (a.scope as "this" | "all") : undefined;
    const intent: ModifyEventIntent = { name: "modify_event" };
    const event = str("event");
    if (event) intent.event = event;
    if (reference) intent.reference = reference;
    if (typeof a.list_index === "number") intent.listIndex = a.list_index;
    const title = str("new_title");
    if (title) intent.newTitle = title;
    const location = str("new_location");
    if (location) intent.newLocation = location;
    if (scope) intent.scope = scope;
    return { intent, ...usage };
  }
  return { intent: { name: "unsupported" }, ...usage };
}
