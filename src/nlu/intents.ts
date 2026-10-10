// Схемы tools для LLM и разбор ответа (docs/intents.md).
// LLM не вычисляет даты — только копирует фрагменты, как сказано (ADR-0005 п.3).

import { type DateStructure, parseDateStructure } from "../dates/structured";
import { DATE_STRUCTURE_RULES, DATE_STRUCTURE_SCHEMA } from "./date-structure";
import { callTools, type CallOptions, type LlmConfig, LlmHttpError, type ToolCall, type ToolDefinition } from "./llm";

export interface CreateEventIntent {
  name: "create_event";
  /** Фрагмент даты/времени как сказано, включая конец интервала: «завтра с часу до двух». */
  start: string;
  title?: string;
  duration?: string;
  allDay?: boolean;
  calendar?: string;
  location?: string;
  /** Даты считает наш код; нет или испорчена — undefined (второе мнение — `start`). */
  when?: DateStructure;
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

export interface FindEventIntent {
  name: "find_event";
  event?: string;
  next?: boolean;
}

/** Кому и что разбирается ещё и из текста (bot/assign/logic.ts). */
export interface AssignTaskIntent {
  name: "assign_task";
  /** Кому, как сказано: «мужу», «Ане». Нет — см. someone. */
  assignee?: string;
  /** «Кто-то должен …» — без исполнителя: предложить всем взрослым дома. */
  someone?: boolean;
  /** Что сделать, без дат и исполнителя: «забрать Машу из школы». */
  task?: string;
  when?: string;
}

export type Intent =
  | { name: "list_events"; range: string; calendar?: string }
  | AssignTaskIntent
  /** Только по тексту, не tool. */
  | { name: "list_assignments"; byMe?: boolean }
  | FindEventIntent
  | CreateEventIntent
  | ModifyEventIntent
  | { name: "delete_event"; event?: string }
  | { name: "unsupported" }
  | SetTimezoneIntent
  /** parts — разбор каждой команды: «…, отводит папа» как create + assign — на деле одно событие. */
  | { name: "multiple"; parts?: Intent[] };

/** Фразы, которые не узнал nlu/timezone-command.ts. tz от модели только проверяется (Intl), город из словаря важнее. */
export interface SetTimezoneIntent {
  name: "set_timezone";
  action: "trip" | "move" | "return" | "where";
  place?: string;
  tz?: string;
  until?: string;
}

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
      name: "find_event",
      description:
        "WHEN is a specific existing event, or what is the next one: «какая у меня следующая встреча», «когда встреча с Петей», «когда у меня стоматолог». Not for a period overview.",
      parameters: {
        type: "object",
        properties: {
          event: str("Which event, without date/time words: «встреча с Петей», «стоматолог». Omit for «следующая встреча»."),
          next: { type: "boolean", description: "true for «следующая», «ближайшая» (the next event)." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_event",
      description:
        "Create a new calendar event: «поставь встречу в среду в 12», «созвон с Петей завтра в 15:30 на полчаса», «отпуск с 10 по 20 ноября», «завтра день рождения мамы».",
      parameters: {
        type: "object",
        // Порядок важен: маленькие модели обрывают JSON на полях после title — title последним
        properties: {
          start: str(
            "All date and time words copied verbatim, including the day and the end of a range: «завтра в 15:30», «в пятницу с часу до двух», «с 10 по 20 ноября».",
          ),
          duration: str("Duration words verbatim: «на полчаса», «на два часа». Omit if not said."),
          all_day: { type: "boolean", description: "true for birthdays, anniversaries, holidays, vacations, whole-day events." },
          calendar: str("Only if the user explicitly named a calendar in this message: its name exactly as in the user's calendar list."),
          title: str("Event name only, without date/time/duration words: «Созвон с Петей». Omit if the user did not name it («встречу» is not a name)."),
          // Последним: модель, оборвавшая JSON, теряет только второе мнение о дате, а не название
          when: { ...DATE_STRUCTURE_SCHEMA, description: "The same date/time as a STRUCTURE (see DATE STRUCTURE rules). Omit if no date/time was said." },
        },
        required: ["start"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "modify_event",
      description:
        "Move or change an EXISTING event: «перенеси встречу с Петей на пятницу», «сдвинь созвон на час позже», «переименуй планёрку в Стендап», «сделай встречу на полтора часа».",
      parameters: {
        type: "object",
        properties: {
          event: str("Which event, without date/time words: «встречу с Петей», «планёрку», «созвон». Omit if referred to only as «её», «следующую», «вторую»."),
          reference: {
            type: "string",
            enum: ["next", "last", "list"],
            description: "«следующую встречу» → next; «её», «эту», «последнюю» → last; «вторую», «третью» (from a shown list) → list.",
          },
          list_index: { type: "integer", description: "Position for reference=list: «вторую» → 2." },
          scope: {
            type: "string",
            enum: ["this", "all"],
            description: "For recurring events: «все планёрки», «всю серию» → all; «только эту», «в этот понедельник» → this. Omit if not said.",
          },
          new_location: str("New place if the user sets one."),
          new_title: str("New name if the user renames the event: «переименуй в Ревью дизайна» → «Ревью дизайна»."),
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_event",
      description: "Delete or cancel an EXISTING event: «удали встречу с Петей», «отмени планёрку в пятницу», «убери обед».",
      parameters: {
        type: "object",
        properties: {
          event: str("Which event, without date/time words: «встречу с Петей», «планёрку». Omit if referred to only as «её», «следующую»."),
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
  {
    type: "function",
    function: {
      name: "assign_task",
      description:
        "Give a task to ANOTHER family member or to anyone in the family: «напомни мужу забрать Машу из школы в 17», «пусть Аня завтра купит торт», «кто-то должен отвезти Ваню на плавание в субботу». Not for reminding the user themself.",
      parameters: {
        type: "object",
        properties: {
          assignee: str("Who should do it, exactly as said: «мужу», «Аня», «папе». Omit for «кто-то», «кто-нибудь» (anyone)."),
          when: str("Date and time words verbatim: «сегодня в 17», «завтра», «в субботу». Omit if not said."),
          task: str(
            "What to do, in the infinitive, without date/time words and without the assignee: «забрать Машу из школы», «купить торт». In the user's language — never translate.",
          ),
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_timezone",
      description:
        "The USER says where they are NOW or are leaving for right now (a trip), that they moved, that they are back home, or asks their time zone: «я на неделю улетаю в Бангкок», «мы сейчас в Таиланде», «переехали в Лиссабон», «I'm back home», «какой у меня часовой пояс». A city of an event («встреча в Берлине») or a PLANNED trip with future dates («поездка в Казань с 5 по 8 декабря») is NOT this — that is create_event.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["trip", "move", "return", "where"],
            description: "trip — temporarily there; move — lives there now; return — back home; where — asks the time zone.",
          },
          place: str("City or country as the user said it. Omit for return/where."),
          tz: str("IANA time zone of that place: «Asia/Bangkok», «Europe/Lisbon». Omit for return/where."),
          until: str("Words for when the trip ends, verbatim: «до воскресенья», «на неделю». Omit if not said."),
        },
        required: ["action"],
      },
    },
  },
];

// Замер (docs/research/llm-intents-eval.md, вариант E): контрастные примеры — короткое название, календарь до названия,
// два запроса в одном сообщении. Правила `when` — до примеров: в конце промпта они вытесняли правило календаря (llm-date-resolution-eval.md, раунд 2).
const PROMPT_HEAD = `You route a user's message (Russian or English, often a voice transcript) to a calendar tool.
Copy date/time words VERBATIM from the message — never drop the day, never compute or translate dates.
Omit optional fields the user did not say. title is whatever names the event, even one word («стоматолог»); a bare «встреча» is not a title.
calendar: only if the message refers to one of the user's calendars — return that name from the list; never guess. A person's calendar may be named in another case or by a short form of the name («в календарь Маше» → «Мария»).
Two separate requests in one message → one tool call per request. Not about the user's calendar → "unsupported".
`;

/** ≈ 4,5 тыс. токенов из ≈ 7 — поэтому есть вариант промпта без него. */
const PROMPT_WHEN = `In create_event also fill "when" — the date/time words of "start" as a structure, e.g. "Созвон с Петей завтра в 15:30 на полчаса" → "when":{"day":{"type":"relative_days","days":1},"time":{"hour":15,"minute":30}}.

DATE STRUCTURE (create_event.when) — kind=point:
${DATE_STRUCTURE_RULES}

The examples below omit "when" for brevity — fill it anyway.
`;

const PROMPT_EXAMPLES = `Examples:
"Созвон с Петей завтра в 15:30 на полчаса" → create_event {"start":"завтра в 15:30","duration":"на полчаса","title":"Созвон с Петей"}
"Каждый понедельник в 10 планёрка" → create_event {"start":"Каждый понедельник в 10","title":"Планёрка"}
"Отпуск с 10 по 20 ноября" → create_event {"start":"с 10 по 20 ноября","all_day":true,"title":"Отпуск"}
"Поставь встречу на среду в 12" → create_event {"start":"на среду в 12"}
"Завтра в 15 стоматолог" → create_event {"start":"Завтра в 15","title":"Стоматолог"}
"Tomorrow at 3pm dentist" → create_event {"start":"Tomorrow at 3pm","title":"Dentist"}
"Ужин в детский календарь в субботу в 19" → create_event {"calendar":"Дети","start":"в субботу в 19","title":"Ужин"}   (when «Дети» is in the user's calendars)
"Поставь в новый календарь завтра в 15" → create_event {"start":"завтра в 15"}   (no such calendar)
"Что у меня в пятницу после обеда?" → list_events {"range":"в пятницу после обеда"}
"Что у меня на следующей неделе?" → list_events {"range":"на следующей неделе"}
"Какая у меня следующая встреча?" → find_event {"next":true}
"Когда встреча с Петей?" → find_event {"event":"встреча с Петей"}
"Когда у меня стоматолог?" → find_event {"event":"стоматолог"}
"Покажи пятницу и удали обед" → list_events {"range":"пятницу"} + delete_event {"event":"обед"}
"Перенеси встречу с Петей на пятницу" → modify_event {"event":"встречу с Петей"}
"Сдвинь следующую встречу на час позже" → modify_event {"reference":"next"}
"Переименуй её в Ревью дизайна" → modify_event {"reference":"last","new_title":"Ревью дизайна"}
"Сделай планёрку на полтора часа" → modify_event {"event":"планёрку"}   (changing an existing event, not creating)
"Отмени встречу с Петей в пятницу" → delete_event {"event":"встречу с Петей"}
"Напомни мужу забрать Машу из школы в 17" → assign_task {"assignee":"мужу","when":"в 17","task":"забрать Машу из школы"}
"Кто-то должен отвезти Ваню на плавание в субботу" → assign_task {"when":"в субботу","task":"отвезти Ваню на плавание"}
"Кто отвезёт Машу к стоматологу в четверг в 15?" → assign_task {"when":"в четверг в 15","task":"отвезти Машу к стоматологу"}   (asking who will do it = a task for anyone)
"Стоматолог Вани в четверг в 16, отводит папа" → create_event {"start":"в четверг в 16","title":"Стоматолог Вани"}   (who takes the child is part of the event, not a separate task)
"Tell Anya to buy milk" → assign_task {"assignee":"Anya","task":"buy milk"}   (task stays in the user's language)
"Я на неделю улетаю в Бангкок" → set_timezone {"action":"trip","place":"Бангкок","tz":"Asia/Bangkok","until":"на неделю"}
"Мы переехали в Таиланд" → set_timezone {"action":"move","place":"Таиланд","tz":"Asia/Bangkok"}
"Встреча в Бангкоке завтра в 10" → create_event {"start":"завтра в 10","title":"Встреча в Бангкоке"}   (a city of an event is not the user's time zone)
"Поездка в Сочи с 3 по 9 ноября" → create_event {"start":"с 3 по 9 ноября","all_day":true,"title":"Поездка в Сочи"}   (a planned trip is an event)`;

export const SYSTEM_PROMPT = PROMPT_HEAD + PROMPT_WHEN + PROMPT_EXAMPLES;

/** Для звена с `dateStructure: false` (запасной Workers AI): промпт втрое короче по neurons; дату тогда сверяем только с `start`. */
export const SYSTEM_PROMPT_NO_WHEN = PROMPT_HEAD + PROMPT_EXAMPLES;
export const TOOLS_NO_WHEN: ToolDefinition[] = TOOLS.map((t) => {
  if (t.function.name !== "create_event") return t;
  const params = t.function.parameters as { properties: Record<string, unknown> };
  const { when: _when, ...properties } = params.properties;
  return { ...t, function: { ...t.function, parameters: { ...params, properties } } };
});

export interface ParsedIntent {
  intent: Intent;
  tokensIn: number;
  tokensOut: number;
  toolCalls?: ToolCall[];
  rateHeaders?: Record<string, string>;
}

/** Подмена промпта/схем/параметров — только для замеров (scripts/eval-intents.ts); в проде не задаётся. */
export interface IntentOverrides extends CallOptions {
  systemPrompt?: string;
  tools?: ToolDefinition[];
}

export interface IntentContext {
  /** Названия и алиасы календарей пользователя — чтобы «в семейном» превращалось в «Семья». */
  calendars: string[];
}

export async function parseIntent(cfg: LlmConfig, text: string, context: IntentContext, overrides: IntentOverrides = {}): Promise<ParsedIntent> {
  // Qwen3 по умолчанию «думает»: медленно, дорого и ломает JSON аргументов — отключаем
  const noThink = /qwen3/i.test(cfg.model) ? "\n/no_think" : "";
  // Названия календарей задают третьи лица (подписки) — как данные, экранированно и коротко
  const calendars = context.calendars.map((c) => JSON.stringify(c.slice(0, 100))).join(", ");
  const noWhen = cfg.dateStructure === false;
  const system = `${overrides.systemPrompt ?? (noWhen ? SYSTEM_PROMPT_NO_WHEN : SYSTEM_PROMPT)}\nUser's calendars: ${calendars}.${noThink}`;
  const { systemPrompt: _p, tools, ...callOpts } = overrides;
  const res = await callTools(cfg, system, text, tools ?? (noWhen ? TOOLS_NO_WHEN : TOOLS), callOpts);
  return { intent: intentFromCalls(res.toolCalls), tokensIn: res.tokensIn, tokensOut: res.tokensOut, toolCalls: res.toolCalls, rateHeaders: res.rateHeaders };
}

/** Заголовки лимитов, увиденные цепочкой (и у упавших звеньев: 429 — самый ценный случай), — для панели «Квоты». */
export interface SeenHeaders {
  provider: string;
  headers: Record<string, string>;
  status: number;
}

export interface LlmAttemptError {
  provider: string;
  error: string;
}

/** Пустой ответ без tools — не ошибка провайдера: к запасным не идём. */
export async function parseIntentChain(
  chain: LlmConfig[],
  text: string,
  context: IntentContext,
  seen?: SeenHeaders[],
): Promise<{ parsed: ParsedIntent; via: LlmConfig; failed: LlmAttemptError[] }> {
  const failed: LlmAttemptError[] = [];
  for (const cfg of chain) {
    try {
      const parsed = await parseIntent(cfg, text, context);
      if (seen && parsed.rateHeaders && Object.keys(parsed.rateHeaders).length)
        seen.push({ provider: cfg.name ?? cfg.baseUrl, headers: parsed.rateHeaders, status: 200 });
      return { parsed, via: cfg, failed };
    } catch (e) {
      if (seen && e instanceof LlmHttpError && Object.keys(e.rateHeaders).length)
        seen.push({ provider: cfg.name ?? cfg.baseUrl, headers: e.rateHeaders, status: e.status });
      failed.push({ provider: cfg.name ?? cfg.baseUrl, error: String(e instanceof Error ? e.message : e).slice(0, 300) });
    }
  }
  throw new LlmChainError(failed);
}

export class LlmChainError extends Error {
  constructor(readonly failed: LlmAttemptError[]) {
    super(failed.map((f) => `${f.provider}: ${f.error}`).join("; ") || "no LLM providers configured");
  }
}

function whenOf(raw: unknown): { when?: DateStructure } {
  const when = parseDateStructure(raw);
  return when ? { when } : {};
}

/** Вызовы tools → интент (отдельно — чтобы замеры могли переоценить сохранённые ответы без новых вызовов). */
export function intentFromCalls(toolCalls: ToolCall[]): Intent {
  if (toolCalls.length > 1) return { name: "multiple", parts: toolCalls.map((c) => intentFromCalls([c])) };
  const call = toolCalls[0];
  if (call?.name === "list_events" && typeof call.arguments.range === "string" && call.arguments.range.trim()) {
    const calendar = typeof call.arguments.calendar === "string" && call.arguments.calendar.trim() ? call.arguments.calendar : undefined;
    return { name: "list_events", range: call.arguments.range, ...(calendar ? { calendar } : {}) };
  }
  if (call?.name === "find_event") {
    const event = typeof call.arguments.event === "string" && call.arguments.event.trim() ? call.arguments.event.trim() : undefined;
    return { name: "find_event", ...(event ? { event } : {}), ...(call.arguments.next === true ? { next: true } : {}) };
  }
  if (call?.name === "create_event") {
    // start может отсутствовать — даты всё равно извлекаются из текста (src/dates/extract.ts)
    const a = call.arguments;
    const opt = (k: string) => (typeof a[k] === "string" && (a[k] as string).trim() ? { [k]: (a[k] as string).trim() } : {});
    return {
      name: "create_event",
      start: typeof a.start === "string" ? a.start : "",
      ...opt("title"),
      ...opt("duration"),
      ...opt("calendar"),
      ...opt("location"),
      ...(a.all_day === true ? { allDay: true } : {}),
      ...whenOf(a.when),
    } as CreateEventIntent;
  }
  if (call?.name === "delete_event") {
    const event = typeof call.arguments.event === "string" && call.arguments.event.trim() ? call.arguments.event.trim() : undefined;
    return { name: "delete_event", ...(event ? { event } : {}) };
  }
  if (call?.name === "assign_task") {
    const a = call.arguments;
    const opt = (k: string) => (typeof a[k] === "string" && (a[k] as string).trim() ? (a[k] as string).trim() : undefined);
    const assignee = opt("assignee");
    const someone = !assignee || /^(кто-?\s?(то|нибудь)|some(one|body)|anyone)$/i.test(assignee);
    const task = opt("task");
    const when = opt("when");
    return {
      name: "assign_task",
      ...(someone ? { someone: true } : { assignee }),
      ...(task ? { task } : {}),
      ...(when ? { when } : {}),
    } as AssignTaskIntent;
  }
  if (call?.name === "set_timezone") {
    const a = call.arguments;
    const opt = (k: string) => (typeof a[k] === "string" && (a[k] as string).trim() ? (a[k] as string).trim() : undefined);
    const action = ["trip", "move", "return", "where"].includes(String(a.action)) ? (a.action as SetTimezoneIntent["action"]) : undefined;
    if (!action) return { name: "unsupported" };
    const place = opt("place");
    const tz = opt("tz");
    const until = opt("until");
    return { name: "set_timezone", action, ...(place ? { place } : {}), ...(tz ? { tz } : {}), ...(until ? { until } : {}) };
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
    return intent;
  }
  return { name: "unsupported" };
}
