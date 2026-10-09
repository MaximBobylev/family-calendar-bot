// Замер разбора интентов на живой LLM (Workers AI): варианты промпта × модели × N повторов.
// Оценивается то, что бот реально использует после детерминированной обработки (как в src/bot/route-intent.ts).
// Набор — testdata/nlu/intents.yaml; итоги — docs/research/llm-intents-eval.md.
//
// Запуск (секреты есть только в сервисе deploy):
//   docker compose run --rm --entrypoint npx deploy tsx scripts/eval-intents.ts \
//     --variants A,C --models @cf/qwen/qwen3-30b-a3b-fp8,or:google/gemma-4-26b-a4b-it --n 3 [--ids c01,g01] [--limit 10] [--cats list,modify] \
//     [--concurrency 4] [--delay-ms 8000] [--out reports/nlu-eval/run.json] [--failures]
//   --report reports/nlu-eval/a.json,reports/nlu-eval/b.json — только сводка по сохранённым прогонам, без вызовов.
//   --set testdata/nlu/intents-r1.yaml — другой набор (R1: дом с участниками и детьми — поручения, «для кого», поиск).
//   --models none — без LLM: только детерминированные поправки (можно в сервисе test, без секретов).
//   --dry-run — только посчитать вызовы и расход квоты Workers AI, ничего не вызывая (можно в сервисе test).
//   --max-fail-streak 5 — после стольких сбоев подряд модель пропускается (бесплатные тарифы); OR_EXTRA='{"reasoning":{...}}'
//   и OR_MAX_TOKENS — свои параметры для or:-моделей с рассуждением (по умолчанию reasoning off, 300 токенов).
//   --spend-quota — разрешить больше WORKERS_AI_SAFE_CALLS вызовов Workers AI (квота общая с ботом в проде!).

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { llmDateCheck } from "../src/bot/create-logic";
import { parseLocal } from "../src/dates/calendar";
import { resolveDateStructure } from "../src/dates/structured";
import { findCalendarByName } from "../src/calendar/match";
import { cleanTitle, extractDateSpans, extractRecurrenceSpan, looksAllDay } from "../src/dates/extract";
import { parseDateFragment } from "../src/dates";
import { intentFromCalls, parseIntent, type Intent } from "../src/nlu/intents";
import { safeParse, LlmHttpError } from "../src/nlu/llm";
import { assignOverride, findMentioned, matchNamed, householdResponsible, parseAssignPhrase, pickAssignee, taskTitle } from "../src/bot/assign/logic";
import { detailHints } from "../src/nlu/detail-hints";
import { effectiveIntent, lookupQuery, NEXT_WORD } from "../src/nlu/intent-overrides";
import { VARIANTS } from "./nlu-variants";

// --- Набор ----------------------------------------------------------------------------------------

interface Calendar {
  title: string;
  aliases: string[];
}
type Expect = string | null | (string | null)[];
interface Case {
  id: string;
  cat: string;
  text: string;
  intent: string | string[];
  title?: Expect;
  calendar?: Expect;
  all_day?: boolean;
  // R1 (testdata/nlu/intents-r1.yaml): поручения, «для кого / ответственный», поиск, напоминания, срок/начало
  assignee?: Expect;
  task?: Expect;
  due?: Expect;
  start?: Expect;
  for_whom?: Expect;
  responsible?: Expect;
  query?: Expect;
  next?: boolean;
  reminders?: number[];
}
/** Состав дома для поручений и US-92 (как loadHome): участники с другими именами, дети; owner — автор фраз. */
interface Household {
  members: { name: string; aliases?: string[]; owner?: boolean }[];
  dependents: { name: string; aliases?: string[] }[];
}
// --set testdata/nlu/intents-r1.yaml — другой набор (по умолчанию intents.yaml)
const SET_PATH = (() => {
  const i = process.argv.indexOf("--set");
  return i >= 0 ? process.argv[i + 1]! : join(import.meta.dirname, "..", "testdata", "nlu", "intents.yaml");
})();
const SET = parseYaml(readFileSync(SET_PATH, "utf8")) as {
  defaults: { now: string; tz: string; calendars: Calendar[]; household?: Household };
  cases: Case[];
};
const { now, tz, calendars } = SET.defaults;
const HOME = SET.defaults.household
  ? {
      members: SET.defaults.household.members.map((m) => ({ ...m, names: [m.name, ...(m.aliases ?? [])] })),
      dependents: SET.defaults.household.dependents.map((d) => ({ ...d, names: [d.name, ...(d.aliases ?? [])] })),
    }
  : undefined;
const calendarNames = calendars.flatMap((c) => [c.title, ...c.aliases]);

// --- Цены Workers AI, $ за 1M токенов (developers.cloudflare.com/workers-ai/platform/pricing, 2026-10-05) ---
const PRICES: Record<string, [number, number]> = {
  "@cf/qwen/qwen3-30b-a3b-fp8": [0.051, 0.335], // = COST_ESTIMATES в src/config.ts (config.ts тянет типы Worker — не импортируем)
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": [0.293, 2.253],
  "@cf/meta/llama-4-scout-17b-16e-instruct": [0.27, 0.85],
  "@cf/mistralai/mistral-small-3.1-24b-instruct": [0.351, 0.555],
  "@cf/google/gemma-3-12b-it": [0.345, 0.556],
  "@cf/google/gemma-4-26b-a4b-it": [0.1, 0.3],
  "@cf/openai/gpt-oss-20b": [0.2, 0.3],
  "@cf/openai/gpt-oss-120b": [0.35, 0.75],
  "@cf/zai-org/glm-4.7-flash": [0.06, 0.4],
  "@cf/zai-org/glm-5.3-flash": [0.15, 0.5],
  "@cf/qwen/qwen3.8-27b": [0.45, 3.2],
  "@cf/ibm-granite/granite-4.0-h-micro": [0.017, 0.112],
  "@cf/nvidia/nemotron-3-120b-a12b": [0.5, 1.5],
  "@cf/deepseek-ai/deepseek-v4-flash-0731": [0.44, 1.32],
  "@cf/moonshotai/kimi-k2.5": [0.6, 3.0],
  "@cf/meta/llama-3.1-8b-instruct-fp8-fast": [0.045, 0.384],
  "@cf/qwen/qwen2.5-coder-32b-instruct": [0.66, 1.0],
  "@cf/qwen/qwq-32b": [0.66, 1.0],
};

/**
 * Особые параметры запроса: модели с рассуждением без отключения думают секунды и обрываются до tool call.
 * enable_thinking=false через chat_template_kwargs — проверено 2026-10-05 (gemma-4, glm-4.7-flash, nemotron, qwen3.8);
 * gpt-oss-20b при tool_choice=required не возвращает вызовов, при auto — возвращает.
 */
const NO_THINK = { chat_template_kwargs: { enable_thinking: false } };
const MODEL_OPTS: Record<string, { maxTokens?: number; extraBody?: Record<string, unknown> }> = {
  "@cf/openai/gpt-oss-20b": { maxTokens: 1500, extraBody: { reasoning_effort: "low", tool_choice: "auto" } },
  "@cf/openai/gpt-oss-120b": { maxTokens: 1500, extraBody: { reasoning_effort: "low" } },
  "@cf/google/gemma-4-26b-a4b-it": { extraBody: NO_THINK },
  "@cf/zai-org/glm-4.7-flash": { extraBody: NO_THINK },
  "@cf/qwen/qwen3.8-27b": { extraBody: NO_THINK },
  "@cf/nvidia/nemotron-3-120b-a12b": { extraBody: NO_THINK },
};

// --- Аргументы ------------------------------------------------------------------------------------

/** Оценка расхода Workers AI: Qwen3 с промптом E ≈ 10 neurons за вызов, Gemma-4 ≈ 16 (llm-intents-eval.md). */
const NEURONS_PER_CALL = 16;
const WORKERS_AI_FREE_NEURONS = 10_000;
/** Порог без --spend-quota: ≈ 30 % дневной квоты — бот в проде продолжает работать. */
const WORKERS_AI_SAFE_CALLS = 200;

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const list = (s: string | undefined) =>
  s
    ? s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
    : [];

// --- Оценка ---------------------------------------------------------------------------------------

interface Outcome {
  intent: string; // после детерминированных поправок (effectiveIntent)
  rawIntent: string;
  title?: string;
  calendar?: string;
  allDay?: boolean;
  /** start от LLM содержит всё, что нашёл extract.ts (справочно: даты всё равно берутся из текста). */
  startFull?: boolean;
  // R1: итог как в карточке бота
  /** Поручение: имя участника; null — «кто-то»; "?<как сказано>" — не нашёлся; "self" — себе; "ambiguous". */
  assignee?: string | null;
  task?: string | null;
  /** Срок поручения / начало события: "2026-10-09T16:00" или "2026-10-09"; null — нет. */
  due?: string | null;
  start?: string | null;
  recurrence?: boolean;
  forWhom?: string | null;
  responsible?: string | null;
  query?: string | null;
  next?: boolean;
  reminders?: number[] | string;
}

/** Фрагмент даты → «2026-10-09T16:00» / «2026-10-09» (как resolveDue в bot/assign/start.ts); нет/ошибка — null. */
function resolvePoint(text: string | undefined): string | null {
  if (!text) return null;
  return firstValue(parseDateFragment({ text, kind: "point", now, tz }));
}

function firstValue(parsed: ReturnType<typeof parseDateFragment>): string | null {
  if ("error" in parsed) return parsed.error === "in_past" ? "past" : null;
  const v = "ambiguous" in parsed ? parsed.ambiguous[0]! : parsed;
  if ("datetime" in v) return v.datetime;
  if ("interval" in v) return v.interval.start;
  if ("date" in v) return typeof v.date === "string" ? v.date : v.date.date;
  if ("range" in v) return v.range.from;
  return null;
}

/** Как startAssign: кому (по тексту, иначе от LLM), срок из текста после исполнителя, название, ребёнок. */
function assignOutcome(text: string, intent: Extract<Intent, { name: "assign_task" }>, out: Outcome): void {
  const phrase = parseAssignPhrase(text);
  const llmWho = intent.someone ? undefined : intent.assignee;
  const who =
    phrase && "someone" in phrase ? undefined : HOME ? pickAssignee(phrase, llmWho, HOME.members) : phrase && "assignee" in phrase ? phrase.assignee : llmWho;
  if (!who) out.assignee = null;
  else if (!HOME) out.assignee = `?${who}`;
  else {
    const found = matchNamed(who, HOME.members);
    out.assignee = found.length === 0 ? `?${who}` : found.length > 1 ? "ambiguous" : found[0]!.owner ? "self" : found[0]!.name;
  }
  const body = phrase?.rest ?? text;
  const spans = extractDateSpans(body, now, tz, "point");
  out.due = resolvePoint(spans.point ?? intent.when);
  out.task = taskTitle(intent.task ?? body, [spans.point, ...(spans.pointParts ?? []), intent.when, ...(who && intent.task ? [who] : [])]);
  out.forWhom = (out.task && HOME && findMentioned(out.task, HOME.dependents)?.name) || null;
}

/** Как routeIntent: поручение по тексту — только если LLM сама сказала assign_task или в доме есть такой участник. */
function applyAssign(text: string, intent: Intent): Intent | null {
  const a = assignOverride(text, intent);
  if (a?.name !== "assign_task" || intent.name === "assign_task") return a;
  if (!HOME) return a;
  return a.someone || (a.assignee && matchNamed(a.assignee, HOME.members).length > 0) ? a : null;
}

function downstream(c: Case, intent: Intent): Outcome {
  // Те же поправки, что в боте (routeIntent): глаголы, «когда …?», «следующая встреча»
  // Как в routeIntent: поручения (US-91) — по тексту раньше остальных поправок
  const eff: Intent = applyAssign(c.text, intent) ?? effectiveIntent(c.text, intent);
  const out: Outcome = { intent: eff.name, rawIntent: intent.name };
  if (eff.name === "assign_task") assignOutcome(c.text, eff, out);
  if (eff.name === "find_event") {
    out.query = lookupQuery(c.text) ?? eff.event ?? null;
    out.next = !!(eff.next || NEXT_WORD.test(c.text));
  }
  if (eff.name === "modify_event") {
    const d = detailHints(c.text);
    if (d.reminders) out.reminders = "error" in d.reminders ? d.reminders.error : d.reminders.overrides.map((r) => r.minutes);
  }
  if (eff.name === "create_event") {
    // US-92: «…, отводит папа» — ответственный; ребёнок в тексте — «для кого» (как familyHints)
    // Не в доме — familyHints ничего не делает (как в боте)
    const resp = HOME ? householdResponsible(c.text, HOME.members, HOME.dependents) : null;
    const famRemove = resp?.remove ?? [];
    const famText = famRemove.reduce((s, r) => s.replace(r, " "), c.text);
    if (HOME) {
      out.responsible = resp ? (resp.found.length === 1 ? resp.found[0]!.name : `?${resp.who}`) : null;
      out.forWhom = findMentioned(famText, HOME.dependents)?.name ?? null;
    }
    const rec = extractRecurrenceSpan(famText, now, tz);
    const spans = extractDateSpans(rec ? rec.rest : famText, now, tz, "point");
    // Как route-intent.ts: наш кусок, структура `when` (или `start`) от LLM — второе мнение (llmDateCheck)
    const llm = { start: eff.start, ...(eff.when ? { when: eff.when } : {}) };
    const pick = rec ? {} : llmDateCheck(famText, spans.point, llm, parseLocal(now), tz).pick;
    const startText = pick.startText;
    const durationText = spans.duration ?? eff.duration;
    out.recurrence = !!rec;
    const ours = resolvePoint(startText);
    const alt = pick.altWhen ? firstValue(resolveDateStructure(pick.altWhen, "point", parseLocal(now), tz)) : resolvePoint(pick.altStartText);
    out.start = rec ? null : !ours?.includes("T") && alt?.includes("T") ? alt : ours;
    out.title = cleanTitle(
      eff.title,
      [rec?.span, ...(rec?.remove ?? []), rec ? eff.start : undefined, startText, ...(spans.pointParts ?? []), durationText, ...famRemove].filter(
        (x): x is string => !!x,
      ),
    );
    // create-logic.ts: диапазон дат без времени («с 5 по 8 декабря») — всегда на весь день, флаг не нужен
    const parsed = startText ? parseDateFragment({ text: startText, kind: "point", now, tz }) : undefined;
    const values = !parsed || "error" in parsed ? [] : "ambiguous" in parsed ? parsed.ambiguous : [parsed];
    const dateRange = values.some((v) => "range" in v && !v.range.from.includes("T"));
    out.allDay = !!(eff.allDay || looksAllDay(c.text) || dateRange);
    if (eff.calendar) out.calendar = findCalendarByName(calendars, eff.calendar)?.title ?? `?${eff.calendar}`;
    const want = rec?.span ?? spans.point;
    if (want) out.startFull = norm(eff.start).includes(norm(want));
  }
  if (eff.name === "list_events" && eff.calendar) {
    // read-events.ts: точное имя или алиас, без падежей
    const needle = eff.calendar.trim().toLowerCase();
    const cal = calendars.find((k) => k.aliases.some((a) => a.toLowerCase() === needle) || k.title.toLowerCase() === needle);
    out.calendar = cal?.title ?? `?${eff.calendar}`;
  }
  return out;
}

const norm = (s: string | undefined | null) =>
  (s ?? "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[«»"'.,!?:;()\-—]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const asList = <T>(v: T | T[]) => (Array.isArray(v) ? v : [v]);

interface Check {
  intent: boolean;
  title?: boolean;
  calendar?: boolean;
  allDay?: boolean;
  assignee?: boolean;
  task?: boolean;
  due?: boolean;
  start?: boolean;
  forWhom?: boolean;
  responsible?: boolean;
  query?: boolean;
  next?: boolean;
  reminders?: boolean;
}
function check(c: Case, o: Outcome): Check {
  const intentOk = asList(c.intent).includes(o.intent);
  const r: Check = { intent: intentOk };
  // Поля create/list проверяем, только если ожидается и получен нужный интент — иначе ошибка уже в intent
  const fieldsApply = intentOk && (o.intent === "create_event" || o.intent === "list_events");
  if (fieldsApply && c.title !== undefined && o.intent === "create_event") r.title = asList(c.title).some((t) => norm(t) === norm(o.title));
  if (fieldsApply && c.calendar !== undefined)
    r.calendar = asList(c.calendar).some((k) => (k === "?" ? !!o.calendar?.startsWith("?") : (k ?? undefined) === o.calendar));
  if (fieldsApply && c.all_day !== undefined && o.intent === "create_event") r.allDay = c.all_day === o.allDay;
  // R1-поля: только при верном интенте, у которого такое поле есть; "?" — «не нашёлся» (любое значение с «?»)
  const same = (exp: Expect, got: string | null | undefined, text = false) =>
    asList(exp).some((k) => (k === "?" ? !!got?.startsWith("?") : k === null ? got == null : text ? norm(k) === norm(got) : k === got));
  const has = (k: keyof Outcome) => intentOk && k in o;
  if (c.assignee !== undefined && has("assignee")) r.assignee = same(c.assignee, o.assignee);
  if (c.task !== undefined && has("task")) r.task = same(c.task, o.task, true);
  if (c.due !== undefined && has("due")) r.due = same(c.due, o.due);
  if (c.start !== undefined && has("start")) r.start = same(c.start, o.start);
  if (c.for_whom !== undefined && has("forWhom")) r.forWhom = same(c.for_whom, o.forWhom);
  if (c.responsible !== undefined && has("responsible")) r.responsible = same(c.responsible, o.responsible);
  if (c.query !== undefined && has("query")) r.query = same(c.query, o.query, true);
  if (c.next !== undefined && has("next")) r.next = c.next === o.next;
  if (c.reminders !== undefined && intentOk && o.intent === "modify_event") r.reminders = JSON.stringify(c.reminders) === JSON.stringify(o.reminders ?? null);
  return r;
}
const passed = (k: Check) => Object.values(k).every((x) => x !== false);

// --- Прогон ---------------------------------------------------------------------------------------

interface Run {
  variant: string;
  model: string;
  caseId: string;
  rep: number;
  ms: number;
  tokensIn: number;
  tokensOut: number;
  error?: string;
  calls?: { name: string; raw?: string }[];
  brokenJson?: boolean;
  outcome?: Outcome;
  check?: Check;
}

// --- Живой журнал (--live файл): каждый вызов дописывается сразу, с заголовками лимитов провайдера ---
const LIVE = arg("live");
let liveDone = 0;
let liveOk = 0;
function live(line: string): void {
  if (!LIVE) return;
  mkdirSync(dirname(LIVE), { recursive: true });
  appendFileSync(LIVE, `${new Date().toISOString().slice(11, 19)} ${line}\n`);
}
const headersText = (h: Record<string, string> | undefined) =>
  h && Object.keys(h).length
    ? ` | ${Object.entries(h)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ")}`
    : "";

async function withRetry<T>(f: () => Promise<T>, label: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await f();
    } catch (e) {
      const msg = String(e);
      const retry = attempt < 3 && /llm (429|5\d\d)|timeout|aborted|fetch failed/i.test(msg);
      // Квота (429) — ждём минуту: короткие повторы только сжигают лимит (урок 2026-10-05)
      const waitMs = /llm 429/.test(msg) ? 60_000 : 2000 * (attempt + 1);
      live(
        `ERR  ${label} попытка ${attempt + 1}: ${msg.replace(/\s+/g, " ").slice(0, 220)}${headersText(e instanceof LlmHttpError ? e.rateHeaders : undefined)}${retry ? ` → ждём ${waitMs / 1000} с` : " → сдаёмся"}`,
      );
      if (retry) {
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      throw e;
    }
  }
}

// OpenRouter иногда отвечает 200 с {"error":{…}} вместо choices (2026-10-08, Nemotron Nano free: «ResourceExhausted …
// provider_unavailable»). callTools видит в этом «нет вызова», и замер засчитал бы сбой провайдера как ответ модели —
// в замере превращаем такой ответ в HTTP-ошибку с кодом из тела (502 → повтор в withRetry).
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const res = await realFetch(input, init);
  if (!res.ok || !String(input).startsWith("https://openrouter.ai/")) return res;
  const body = await res.text();
  const err = (() => {
    try {
      return (JSON.parse(body) as { error?: { code?: number } }).error;
    } catch {
      return undefined;
    }
  })();
  return new Response(body, { status: err ? (Number(err.code) >= 400 && Number(err.code) < 600 ? Number(err.code) : 502) : res.status, headers: res.headers });
};

/** Пауза между вызовами (--delay-ms) — под поминутные лимиты бесплатных тарифов. */
const DELAY_MS = Number(arg("delay-ms") ?? 0);
/** Модель, у которой столько фраз подряд кончились ошибкой (после повторов), дальше не вызываем — бережём квоту. */
const MAX_FAIL_STREAK = Number(arg("max-fail-streak") ?? 5);
const failStreak = new Map<string, number>();
/** OR_MAX_TOKENS — больше токенов ответа для OpenRouter-модели с включённым рассуждением (по умолчанию 300). */
const modelOpts = (model: string) =>
  model.startsWith("or:") && process.env.OR_MAX_TOKENS ? { ...MODEL_OPTS[model], maxTokens: Number(process.env.OR_MAX_TOKENS) } : MODEL_OPTS[model];

async function runOne(variant: string, model: string, c: Case, rep: number): Promise<Run> {
  if ((failStreak.get(model) ?? 0) >= MAX_FAIL_STREAK)
    return { variant, model, caseId: c.id, rep, ms: 0, tokensIn: 0, tokensOut: 0, error: `пропущено: ${MAX_FAIL_STREAK} сбоев подряд` };
  if (DELAY_MS) await new Promise((r) => setTimeout(r, DELAY_MS));
  const v = VARIANTS[variant]!;
  // «or:<модель>» — OpenRouter (без «размышления», как в проде); «gg:<модель>» — Google AI Studio (OpenAI-совместимый
  // эндпоинт Gemini API); иначе — Workers AI
  // «ds:<модель>» — DeepSeek (OpenAI-совместимый, «размышление» выключено: по умолчанию включено и медленно)
  const cfg = model.startsWith("ds:")
    ? {
        baseUrl: "https://api.deepseek.com",
        apiKey: process.env.DEEPSEEK_API_KEY ?? "",
        model: model.slice(3),
        extraBody: process.env.DS_EXTRA ? JSON.parse(process.env.DS_EXTRA) : { thinking: { type: "disabled" } },
      }
    : model.startsWith("gg:")
      ? {
          baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
          apiKey: process.env.GEMINI_API_KEY ?? "",
          model: model.slice(3),
          ...(process.env.GG_EXTRA ? { extraBody: JSON.parse(process.env.GG_EXTRA) } : {}),
        }
      : model.startsWith("or:")
        ? {
            baseUrl: "https://openrouter.ai/api/v1",
            apiKey: process.env.OPENROUTER_API_KEY ?? "",
            model: model.slice(3),
            // OR_EXTRA — свои поля запроса вместо reasoning off (модель с рассуждением, которая его не выключает)
            extraBody: {
              ...(process.env.OR_EXTRA ? JSON.parse(process.env.OR_EXTRA) : { reasoning: { enabled: false } }),
              ...(process.env.OR_SORT ? { provider: { sort: process.env.OR_SORT } } : {}),
            },
          }
        : { baseUrl: `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/v1`, apiKey: process.env.LLM_API_KEY ?? "", model };
  const base: Run = { variant, model, caseId: c.id, rep, ms: 0, tokensIn: 0, tokensOut: 0 };
  // «none» — без LLM (модель не ответила tool call): что дают одни детерминированные поправки
  if (model === "none") return grade({ ...base, calls: [] });
  let ms = 0;
  let lastHeaders: Record<string, string> | undefined;
  try {
    const parsed = await withRetry(async () => {
      const t0 = Date.now();
      const p = await parseIntent(cfg, c.text, { calendars: calendarNames }, { systemPrompt: v.systemPrompt, tools: v.tools, ...modelOpts(model) });
      ms = Date.now() - t0;
      lastHeaders = p.rateHeaders;
      return p;
    }, `${c.id} «${c.text}»`);
    const calls = (parsed.toolCalls ?? []).map((k) => ({ name: k.name, raw: k.rawArguments }));
    const brokenJson = calls.some((k) => {
      if (k.raw === undefined || typeof k.raw !== "string") return false;
      try {
        JSON.parse(k.raw);
        return false;
      } catch {
        return true;
      }
    });
    failStreak.set(model, 0);
    const run = grade({ ...base, ms, tokensIn: parsed.tokensIn, tokensOut: parsed.tokensOut, calls, brokenJson });
    const ok = !!run.check && Object.values(run.check).every((x) => x !== false);
    liveDone++;
    if (ok) liveOk++;
    live(
      `${ok ? "OK  " : "FAIL"} ${c.id} ${ms} мс «${c.text}» → ${calls.map((k) => `${k.name} ${k.raw ?? ""}`).join(" + ") || "(нет вызова)"}` +
        `${ok ? "" : ` | проверка: ${JSON.stringify(run.check)}`}${headersText(lastHeaders)} | итого ${liveOk}/${liveDone}`,
    );
    return run;
  } catch (e) {
    liveDone++;
    failStreak.set(model, (failStreak.get(model) ?? 0) + 1);
    if (failStreak.get(model) === MAX_FAIL_STREAK) live(`DEAD ${model}: ${MAX_FAIL_STREAK} сбоев подряд — остальные фразы пропускаем`);
    live(`GAVE ${c.id} «${c.text}» | итого ${liveOk}/${liveDone}`);
    return { ...base, ms, error: String(e).slice(0, 300) };
  }
}

/** Оценка по сохранённым вызовам — тот же путь, что в проде (intentFromCalls → downstream). */
function grade(r: Run): Run {
  if (r.error) return r;
  const c = SET.cases.find((k) => k.id === r.caseId)!;
  const intent = intentFromCalls((r.calls ?? []).map((k) => ({ name: k.name, arguments: typeof k.raw === "string" ? safeParse(k.raw) : {} })));
  const outcome = downstream(c, intent);
  return { ...r, outcome, check: check(c, outcome) };
}

async function pool<T>(items: (() => Promise<T>)[], n: number, onDone: (done: number) => void): Promise<T[]> {
  const out: T[] = new Array(items.length);
  let next = 0,
    done = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await items[i]!();
        onDone(++done);
      }
    }),
  );
  return out;
}

// --- Сводка ---------------------------------------------------------------------------------------

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "—");
const quantile = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
};

function summarize(runs: Run[], showFailures: boolean): string {
  const byKey = new Map<string, Run[]>();
  for (const r of runs) byKey.set(`${r.variant}|${r.model}`, [...(byKey.get(`${r.variant}|${r.model}`) ?? []), r]);
  const cases = new Map(SET.cases.map((c) => [c.id, c]));
  const allExamples = new Set(Object.values(VARIANTS).flatMap((v) => v.examples.map(norm)));
  const lines: string[] = [];
  lines.push(
    "| Вариант | Модель | Прогонов | Все поля | Все поля (отлож.) | Интент | Интент до глаголов | Название | Календарь | Весь день | Пусто/ошибка/битый JSON | start полный | p50, мс | p95, мс | Ток. вх/вых | $ на 1k |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  const failures: string[] = [];
  for (const [key, rs] of byKey) {
    const [variant, model] = key.split("|") as [string, string];
    const ok = rs.filter((r) => r.check);
    const heldOut = ok.filter((r) => !allExamples.has(norm(cases.get(r.caseId)!.text)));
    const field = (f: keyof Check) => {
      const xs = ok.filter((r) => r.check![f] !== undefined);
      return pct(xs.filter((r) => r.check![f]).length, xs.length);
    };
    const rawIntentOk = ok.filter((r) => asList(cases.get(r.caseId)!.intent).includes(r.outcome!.rawIntent)).length;
    const empty = ok.filter((r) => (r.calls ?? []).length === 0 && !asList(cases.get(r.caseId)!.intent).includes("unsupported")).length;
    const errors = rs.filter((r) => r.error).length;
    const broken = ok.filter((r) => r.brokenJson).length;
    const sf = ok.filter((r) => r.outcome!.startFull !== undefined);
    const lat = ok.map((r) => r.ms);
    const tin = ok.reduce((s, r) => s + r.tokensIn, 0) / (ok.length || 1);
    const tout = ok.reduce((s, r) => s + r.tokensOut, 0) / (ok.length || 1);
    const price = PRICES[model];
    const cost = price ? ((tin * price[0] + tout * price[1]) / 1e6) * 1000 : NaN;
    lines.push(
      `| ${variant} | ${model.replace("@cf/", "")} | ${rs.length} | ${pct(ok.filter((r) => passed(r.check!)).length, rs.length)} | ` +
        `${pct(heldOut.filter((r) => passed(r.check!)).length, heldOut.length)} | ${pct(ok.filter((r) => r.check!.intent).length, rs.length)} | ` +
        `${pct(rawIntentOk, rs.length)} | ${field("title")} | ${field("calendar")} | ${field("allDay")} | ${empty}/${errors}/${broken} | ` +
        `${pct(sf.filter((r) => r.outcome!.startFull).length, sf.length)} | ${quantile(lat, 0.5)} | ${quantile(lat, 0.95)} | ` +
        `${tin.toFixed(0)}/${tout.toFixed(1)} | ${Number.isNaN(cost) ? "?" : cost.toFixed(3)} |`,
    );
    if (showFailures) {
      const byCase = new Map<string, Run[]>();
      for (const r of rs) if (r.error || !passed(r.check!)) byCase.set(r.caseId, [...(byCase.get(r.caseId) ?? []), r]);
      if (byCase.size) failures.push(`\n### ${variant} × ${model}`);
      for (const [id, fr] of byCase) {
        const c = cases.get(id)!;
        const total = rs.filter((r) => r.caseId === id).length;
        const { id: _i, cat: _c, text: _t, ...expected } = c;
        const exp = JSON.stringify(expected);
        failures.push(`- ${id} [${c.cat}] ${fr.length}/${total} «${c.text}»  ожидалось ${exp}`);
        for (const r of fr.slice(0, 2)) {
          const got = r.error ? `ERROR ${r.error}` : `${JSON.stringify(r.outcome)}  ← ${JSON.stringify(r.calls)}`;
          failures.push(`    получено: ${got}`);
        }
      }
    }
  }
  // По категориям: доля фраз со всеми верными полями (R1-набор считается по областям)
  const cats = [...new Set(SET.cases.map((c) => c.cat))].filter((cat) => runs.some((r) => cases.get(r.caseId)?.cat === cat));
  const keys = [...byKey.keys()];
  const byCat = [`| Категория | ${keys.map((k) => k.split("|")[1]!.replace("@cf/", "")).join(" | ")} |`, `|---|${keys.map(() => "---").join("|")}|`];
  for (const cat of cats) {
    const cells = keys.map((k) => {
      const rs = byKey.get(k)!.filter((r) => cases.get(r.caseId)!.cat === cat);
      return `${pct(rs.filter((r) => r.check && passed(r.check)).length, rs.length)} (${rs.length})`;
    });
    byCat.push(`| ${cat} | ${cells.join(" | ")} |`);
  }
  return `${lines.join("\n")}\n\n${byCat.join("\n")}${failures.length ? `\n\n## Ошибки по фразам\n${failures.join("\n")}` : ""}`;
}

// --- main -----------------------------------------------------------------------------------------

const reportFiles = list(arg("report"));
if (reportFiles.length) {
  const runs = reportFiles
    .flatMap((f) => JSON.parse(readFileSync(f, "utf8")) as Run[])
    .filter((r) => SET.cases.some((k) => k.id === r.caseId))
    .map(grade);
  console.log(summarize(runs, process.argv.includes("--failures")));
} else {
  const variants = list(arg("variants") ?? "A");
  const models = list(arg("models") ?? "@cf/qwen/qwen3-30b-a3b-fp8");
  const n = Number(arg("n") ?? 1);
  const ids = new Set(list(arg("ids")));
  const cats = new Set(list(arg("cats")));
  let selected = SET.cases.filter((c) => (!ids.size || ids.has(c.id)) && (!cats.size || cats.has(c.cat)));
  const limit = arg("limit");
  if (limit) selected = selected.slice(0, Number(limit));
  for (const v of variants) if (!VARIANTS[v]) throw new Error(`нет варианта ${v}`);

  const jobs: (() => Promise<Run>)[] = [];
  for (const model of models) for (const v of variants) for (let rep = 0; rep < n; rep++) for (const c of selected) jobs.push(() => runOne(v, model, c, rep));
  console.error(`${jobs.length} вызовов: ${variants.join(",")} × ${models.length} моделей × ${selected.length} фраз × ${n}`);
  // Квота Workers AI Free — 10 000 neurons/сутки на весь аккаунт, общая с ботом в проде (docs/research/llm-intents-eval.md):
  // замер 2026-10-05 выбрал её целиком, и бот до сброса не разбирал команды. Большой прогон — только осознанно.
  const workersAiCalls = models.filter((m) => !m.startsWith("or:") && !m.startsWith("gg:") && m !== "none").length * variants.length * n * selected.length;
  if (workersAiCalls)
    console.error(`  из них Workers AI: ${workersAiCalls} ≈ ${workersAiCalls * NEURONS_PER_CALL} neurons из ${WORKERS_AI_FREE_NEURONS}/сутки`);
  const freeOrCalls = models.filter((m) => m.startsWith("or:") && m.endsWith(":free")).length * variants.length * n * selected.length;
  if (freeOrCalls) console.error(`  из них бесплатный OpenRouter: ${freeOrCalls} (лимит ~50/сутки без кредитов, 1000 с балансом ≥ $10 — общий с ботом)`);
  if (process.argv.includes("--dry-run")) process.exit(0);
  if (workersAiCalls > WORKERS_AI_SAFE_CALLS && !process.argv.includes("--spend-quota")) {
    throw new Error(
      `больше ${WORKERS_AI_SAFE_CALLS} вызовов Workers AI съедят квоту прода; уменьшите набор или добавьте --spend-quota (с разрешения владельца)`,
    );
  }
  if (models.some((m) => m !== "none") && (!process.env.CLOUDFLARE_ACCOUNT_ID || !process.env.LLM_API_KEY))
    throw new Error("нужны CLOUDFLARE_ACCOUNT_ID и LLM_API_KEY (сервис deploy)");
  const runs = await pool(jobs, Number(arg("concurrency") ?? 4), (d) => {
    if (d % 25 === 0 || d === jobs.length) console.error(`  ${d}/${jobs.length}`);
  });
  const out = arg("out");
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(runs, null, 1));
  }
  console.log(summarize(runs, process.argv.includes("--failures")));
}
