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

export type Intent =
  | { name: "list_events"; range: string; calendar?: string }
  | CreateEventIntent
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
        properties: {
          start: str("When, exactly as the user said it, including an end time if given: «в среду в 12», «завтра с часу до двух», «с 10 по 20 ноября»."),
          title: str("Event title as the user said it, without date/time words: «Созвон с Петей», «День рождения мамы». Omit if the user did not name the event (e.g. just «встречу»)."),
          duration: str("Duration exactly as said: «на полчаса», «на два часа». Omit if not said."),
          all_day: { type: "boolean", description: "true for all-day events: birthdays, vacations, holidays, or when the user says «на весь день»." },
          calendar: str("If the user named a calendar, its name exactly as written in the user's calendar list. Omit otherwise."),
          location: str("Place if said: «в кафе Пушкин». Omit otherwise."),
        },
        required: ["start"],
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
Never compute or normalize dates and times: copy the date/time words exactly as the user said them.
If the message is not about the user's calendar, call "unsupported".`;

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
  const system = `${SYSTEM_PROMPT}\nUser's calendars: ${context.calendars.map((c) => `"${c}"`).join(", ")}.`;
  const res = await callTools(cfg, system, text, TOOLS);
  const usage = { tokensIn: res.tokensIn, tokensOut: res.tokensOut };
  // В MVP — одна команда на сообщение (US-12)
  if (res.toolCalls.length > 1) return { intent: { name: "multiple" }, ...usage };
  const call = res.toolCalls[0];
  if (call?.name === "list_events" && typeof call.arguments.range === "string" && call.arguments.range.trim()) {
    const calendar = typeof call.arguments.calendar === "string" && call.arguments.calendar.trim() ? call.arguments.calendar : undefined;
    return { intent: { name: "list_events", range: call.arguments.range, ...(calendar ? { calendar } : {}) }, ...usage };
  }
  if (call?.name === "create_event" && typeof call.arguments.start === "string" && call.arguments.start.trim()) {
    const a = call.arguments;
    const opt = (k: string) => (typeof a[k] === "string" && (a[k] as string).trim() ? { [k]: (a[k] as string).trim() } : {});
    return {
      intent: {
        name: "create_event",
        start: a.start as string,
        ...opt("title"), ...opt("duration"), ...opt("calendar"), ...opt("location"),
        ...(a.all_day === true ? { allDay: true } : {}),
      } as CreateEventIntent,
      ...usage,
    };
  }
  return { intent: { name: "unsupported" }, ...usage };
}
