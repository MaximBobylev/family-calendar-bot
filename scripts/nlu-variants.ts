// Варианты промпта/схем для замера разбора интентов (scripts/eval-intents.ts, docs/research/llm-intents-eval.md).
// A — промпт до замера 2026-10-05 (копия); E — победитель, он же теперь SYSTEM_PROMPT в src/nlu/intents.ts.

import { SYSTEM_PROMPT, TOOLS } from "../src/nlu/intents";
import type { ToolDefinition } from "../src/nlu/llm";

export interface Variant {
  id: string;
  label: string;
  systemPrompt: string;
  tools: ToolDefinition[];
  /** Фразы, которые сами стоят в примерах промпта — для отчёта «на отложенных» (без утечки). */
  examples: string[];
}

const str = (description: string) => ({ type: "string", description });

/** Фразы-примеры из промпта: всё в кавычках "…" перед «→». */
const examplesOf = (prompt: string) => [...prompt.matchAll(/^"(.+?)" →/gm)].map((m) => m[1]!);

const A_PROMPT = `You route a user's message (Russian or English) to exactly one calendar tool.
Copy date/time words VERBATIM from the message — never drop the day, never compute or translate dates.
Omit optional fields the user did not say. Never guess a calendar.
If the message is not about the user's calendar, call "unsupported".
Examples:
"Созвон с Петей завтра в 15:30 на полчаса" → create_event {"start":"завтра в 15:30","duration":"на полчаса","title":"Созвон с Петей"}
"Каждый понедельник в 10 планёрка" → create_event {"start":"Каждый понедельник в 10","title":"Планёрка"}
"Отпуск с 10 по 20 ноября" → create_event {"start":"с 10 по 20 ноября","all_day":true,"title":"Отпуск"}
"Поставь встречу на среду в 12" → create_event {"start":"на среду в 12"}
"Tomorrow at 3pm dentist" → create_event {"start":"Tomorrow at 3pm","title":"Dentist"}
"Что у меня в пятницу после обеда?" → list_events {"range":"в пятницу после обеда"}
"Перенеси встречу с Петей на пятницу" → modify_event {"event":"встречу с Петей"}
"Сдвинь следующую встречу на час позже" → modify_event {"reference":"next"}
"Переименуй её в Ревью дизайна" → modify_event {"reference":"last","new_title":"Ревью дизайна"}
"Сделай планёрку на полтора часа" → modify_event {"event":"планёрку"}   (changing an existing event, not creating)
"Отмени встречу с Петей в пятницу" → delete_event {"event":"встречу с Петей"}`;

// --- B: структурированные правила в стиле критики, ужато ------------------------------------------
const B_PROMPT = `You are the intent router of a calendar assistant. Call a tool for the user's message (Russian or English, often a voice transcript).

GENERAL
- Never compute, convert or translate dates. Copy date/time words verbatim.
- Omit optional fields the user did not say. Never invent values.
DATE/TIME (create_event)
- start: all date and time words, including the end of an interval: «завтра с 13 до 14» is start, not duration.
- duration: only an explicitly said length: «на полчаса», «на два часа».
TITLE
- The event name only: no date/time/duration words, no command verbs («поставь», «запиши», «добавь»).
- A bare generic word («встреча», «событие», «meeting») is not a title — omit it.
ALL-DAY
- true for birthdays, anniversaries, holidays, days off, vacations/trips over a date range. Do not set it just because no time is given.
CALENDAR
- If the user explicitly named or clearly referred to a calendar, return its exact name from the user's calendar list. Resolve informal references («семейный» → a matching calendar such as «Семья»). Never invent a calendar; omit if none matches.
LIST / MODIFY / DELETE
- list_events: questions about what is scheduled. modify_event: move/change/rename an EXISTING event. delete_event: remove/cancel an EXISTING event.
MULTIPLE
- Two separate requests in one message → call one tool per request.
UNSUPPORTED
- Weather, small talk, general questions, anything not about the user's calendar → unsupported.
Examples:
"Созвон завтра с 13 до 14" → create_event {"start":"завтра с 13 до 14","title":"Созвон"}
"Созвон завтра в 13 на час" → create_event {"start":"завтра в 13","duration":"на час","title":"Созвон"}
"Встреча завтра" → create_event {"start":"завтра"}
"Встреча с Васей завтра" → create_event {"start":"завтра","title":"Встреча с Васей"}
"Поставь мне завтра встречу с Васей" → create_event {"start":"завтра","title":"Встреча с Васей"}
"Поставь в семейный завтра в 15" → create_event {"start":"завтра в 15","calendar":"<matching calendar from the list>"}
"Поставь в новый календарь завтра в 15" → create_event {"start":"завтра в 15"}
"Что у меня завтра и поставь созвон на 15" → list_events {"range":"завтра"} + create_event {"start":"на 15","title":"Созвон"}
"Какая погода завтра?" → unsupported`;

// --- C: короткие правила + контрастные примеры -----------------------------------------------------
const C_PROMPT = `You turn one user message (Russian or English, often a voice transcript with typos) into a calendar tool call.
- Copy date/time words verbatim; never compute or translate dates.
- title: what the event is, without date/time/duration words and without command verbs («поставь», «запиши»). A bare «встреча»/«событие»/«meeting» is not a title — omit it.
- all_day only for birthdays, anniversaries, holidays, days off, vacations and trips; a missing time alone is not all-day.
- calendar: only if the message refers to a calendar; return the matching name from the user's calendar list. Never invent one.
- modify_event/delete_event: changing or removing an event that already exists.
- Two separate requests → one tool call per request. Not about the user's calendar → unsupported.
Examples:
"Созвон с Петей завтра в 15:30 на полчаса" → create_event {"start":"завтра в 15:30","duration":"на полчаса","title":"Созвон с Петей"}
"Созвон завтра с 13 до 14" → create_event {"start":"завтра с 13 до 14","title":"Созвон"}
"Поставь встречу на среду в 12" → create_event {"start":"на среду в 12"}
"Поставь мне завтра встречу с Васей" → create_event {"start":"завтра","title":"Встреча с Васей"}
"Завтра в 15 стоматолог" → create_event {"start":"Завтра в 15","title":"Стоматолог"}
"Каждый понедельник в 10 планёрка" → create_event {"start":"Каждый понедельник в 10","title":"Планёрка"}
"Отпуск с 10 по 20 ноября" → create_event {"start":"с 10 по 20 ноября","all_day":true,"title":"Отпуск"}
"Встреча с Машей в пятницу" → create_event {"start":"в пятницу","title":"Встреча с Машей"}
"Ужин в детский календарь в субботу в 19" → create_event {"start":"в субботу в 19","calendar":"Дети","title":"Ужин"}   (if «Дети» is in the list)
"Поставь в новый календарь завтра в 15" → create_event {"start":"завтра в 15"}   (no such calendar)
"Что у меня в пятницу после обеда?" → list_events {"range":"в пятницу после обеда"}
"Перенеси встречу с Петей на пятницу" → modify_event {"event":"встречу с Петей"}
"Сделай планёрку на полтора часа" → modify_event {"event":"планёрку"}
"Отмени встречу с Петей в пятницу" → delete_event {"event":"встречу с Петей"}
"Что у меня завтра и поставь созвон на 15" → list_events {"range":"завтра"} + create_event {"start":"на 15","title":"Созвон"}
"Какая погода завтра?" → unsupported`;

// --- D: C + описания полей схемы (calendar из критики, start необязателен, all_day с отрицанием) ----
const D_TOOLS: ToolDefinition[] = TOOLS.map((t) => {
  if (t.function.name === "create_event") {
    return {
      type: "function",
      function: {
        name: "create_event",
        description: "Create a NEW calendar event: «поставь встречу в среду в 12», «созвон с Петей завтра в 15:30 на полчаса», «отпуск с 10 по 20 ноября», «завтра день рождения мамы».",
        parameters: {
          type: "object",
          properties: {
            start: str("All date and time words copied verbatim, including the day and the end of an interval: «завтра в 15:30», «в пятницу с часу до двух», «с 10 по 20 ноября». Omit if the message has no date or time."),
            duration: str("Only an explicitly said length, verbatim: «на полчаса», «на два часа». The end of an interval («до 14») belongs to start. Omit if not said."),
            all_day: { type: "boolean", description: "true only for birthdays, anniversaries, holidays, days off, vacations and trips. Do not set it just because no time was said." },
            calendar: str("If the user explicitly named or clearly referred to a calendar, its exact name from the user's calendar list; resolve informal forms («в семейный» → «Семья» if listed). Never invent a calendar. Omit if none was referred to or none matches."),
            title: str("Event name only, without date/time/duration words and command verbs: «Созвон с Петей», «Стоматолог». Omit if only a generic word was said («встречу», «событие», «meeting»)."),
          },
        },
      },
    };
  }
  if (t.function.name === "list_events") {
    return {
      ...t,
      function: {
        ...t.function,
        parameters: {
          type: "object",
          properties: {
            range: str("The period exactly as the user said it, without computing dates: «завтра», «на этой неделе», «в пятницу после обеда»."),
            calendar: str("If the user explicitly named or clearly referred to a calendar, its exact name from the user's calendar list («в семейном» → «Семья» if listed). Never invent a calendar. Omit otherwise."),
          },
          required: ["range"],
        },
      },
    };
  }
  if (t.function.name === "delete_event") {
    return { ...t, function: { ...t.function, description: "Delete or cancel an EXISTING event: «удали встречу с Петей», «отмени планёрку в пятницу», «убери обед», «встреча с Машей отменяется»." } };
  }
  if (t.function.name === "unsupported") {
    return { ...t, function: { ...t.function, description: "The message is not about the user's calendar (weather, small talk, general questions, other tasks), or no other tool fits." } };
  }
  return t;
});


// --- E: A + точечные контрастные примеры по ошибкам A (короткое название, календарь до названия, два запроса) ---
const E_PROMPT = SYSTEM_PROMPT;

// --- F: E + в схеме create_event поле calendar первым (Qwen обрывает JSON после title) ------------
const F_TOOLS: ToolDefinition[] = TOOLS.map((t) => {
  if (t.function.name !== "create_event") return t;
  const params = t.function.parameters as { properties: Record<string, unknown>; required: string[] };
  const { calendar, ...rest } = params.properties;
  return { ...t, function: { ...t.function, parameters: { ...params, properties: { calendar, ...rest } } } };
});

export const VARIANTS: Record<string, Variant> = {
  A: { id: "A", label: "прод до 2026-10-05", systemPrompt: A_PROMPT, tools: TOOLS, examples: examplesOf(A_PROMPT) },
  B: { id: "B", label: "правила в стиле критики", systemPrompt: B_PROMPT, tools: TOOLS, examples: examplesOf(B_PROMPT) },
  C: { id: "C", label: "краткие правила + 16 контрастных примеров", systemPrompt: C_PROMPT, tools: TOOLS, examples: examplesOf(C_PROMPT) },
  E: { id: "E", label: "A + точечные контрастные примеры", systemPrompt: E_PROMPT, tools: TOOLS, examples: examplesOf(E_PROMPT) },
  F: { id: "F", label: "E + calendar первым в схеме", systemPrompt: E_PROMPT, tools: F_TOOLS, examples: examplesOf(E_PROMPT) },
  D: { id: "D", label: "C + улучшенные описания полей, start необязателен", systemPrompt: C_PROMPT, tools: D_TOOLS, examples: examplesOf(C_PROMPT) },
};
