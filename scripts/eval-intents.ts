// Замер разбора интентов на живой LLM (Workers AI): варианты промпта × модели × N повторов.
// Оценивается то, что бот реально использует после детерминированной обработки (как в src/bot/handle-update.ts).
// Набор — testdata/nlu/intents.yaml; итоги — docs/research/llm-intents-eval.md.
//
// Запуск (секреты есть только в сервисе deploy):
//   docker compose run --rm --entrypoint npx deploy tsx scripts/eval-intents.ts \
//     --variants A,C --models @cf/qwen/qwen3-30b-a3b-fp8,or:google/gemma-4-26b-a4b-it --n 3 [--ids c01,g01] [--limit 10] [--cats list,modify] \
//     [--concurrency 4] [--out reports/nlu-eval/run.json] [--failures]
//   --report reports/nlu-eval/a.json,reports/nlu-eval/b.json — только сводка по сохранённым прогонам, без вызовов.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { findCalendarByName } from "../src/calendar/match";
import { cleanTitle, extractDateSpans, extractRecurrenceSpan, looksAllDay } from "../src/dates/extract";
import { parseDateFragment } from "../src/dates";
import { intentFromCalls, parseIntent, type Intent } from "../src/nlu/intents";
import { safeParse } from "../src/nlu/llm";
import { DELETE_VERBS, MODIFY_VERBS } from "../src/nlu/modify-hints";
import { VARIANTS } from "./nlu-variants";

// --- Набор ----------------------------------------------------------------------------------------

interface Calendar {
  title: string;
  aliases: string[];
}
interface Case {
  id: string;
  cat: string;
  text: string;
  intent: string | string[];
  title?: string | null | (string | null)[];
  calendar?: string | null | (string | null)[];
  all_day?: boolean;
}
const SET = parseYaml(readFileSync(join(import.meta.dirname, "..", "testdata", "nlu", "intents.yaml"), "utf8")) as {
  defaults: { now: string; tz: string; calendars: Calendar[] };
  cases: Case[];
};
const { now, tz, calendars } = SET.defaults;
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
  intent: string; // после переопределения глаголами
  rawIntent: string;
  title?: string;
  calendar?: string;
  allDay?: boolean;
  /** start от LLM содержит всё, что нашёл extract.ts (справочно: даты всё равно берутся из текста). */
  startFull?: boolean;
}

function downstream(c: Case, intent: Intent): Outcome {
  let eff: Intent = intent;
  if (eff.name !== "multiple") {
    if (DELETE_VERBS.test(c.text)) {
      if (eff.name !== "delete_event") eff = { name: "delete_event" };
    } else if (eff.name !== "modify_event" && MODIFY_VERBS.test(c.text)) eff = { name: "modify_event" };
  }
  const out: Outcome = { intent: eff.name, rawIntent: intent.name };
  if (eff.name === "create_event") {
    const rec = extractRecurrenceSpan(c.text, now, tz);
    const spans = extractDateSpans(rec ? rec.rest : c.text, now, tz, "point");
    const startText = rec ? undefined : (spans.point ?? (eff.start || undefined));
    const durationText = spans.duration ?? eff.duration;
    out.title = cleanTitle(
      eff.title,
      [rec?.span, rec ? eff.start : undefined, startText, durationText].filter((x): x is string => !!x),
    );
    // create-event.ts: диапазон дат без времени («с 5 по 8 декабря») — всегда на весь день, флаг не нужен
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
  return r;
}
const passed = (k: Check) => k.intent && k.title !== false && k.calendar !== false && k.allDay !== false;

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

async function withRetry<T>(f: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await f();
    } catch (e) {
      const msg = String(e);
      if (attempt < 3 && /llm (429|5\d\d)|timeout|aborted|fetch failed/i.test(msg)) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
}

async function runOne(variant: string, model: string, c: Case, rep: number): Promise<Run> {
  const v = VARIANTS[variant]!;
  // «or:<модель>» — OpenRouter (без «размышления», как в проде); «gg:<модель>» — Google AI Studio (OpenAI-совместимый
  // эндпоинт Gemini API); иначе — Workers AI
  const cfg = model.startsWith("gg:")
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
          extraBody: { reasoning: { enabled: false }, ...(process.env.OR_SORT ? { provider: { sort: process.env.OR_SORT } } : {}) },
        }
      : { baseUrl: `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/v1`, apiKey: process.env.LLM_API_KEY ?? "", model };
  const base: Run = { variant, model, caseId: c.id, rep, ms: 0, tokensIn: 0, tokensOut: 0 };
  let ms = 0;
  try {
    const parsed = await withRetry(async () => {
      const t0 = Date.now();
      const p = await parseIntent(cfg, c.text, { calendars: calendarNames }, { systemPrompt: v.systemPrompt, tools: v.tools, ...MODEL_OPTS[model] });
      ms = Date.now() - t0;
      return p;
    });
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
    return grade({ ...base, ms, tokensIn: parsed.tokensIn, tokensOut: parsed.tokensOut, calls, brokenJson });
  } catch (e) {
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
        const exp = JSON.stringify({ intent: c.intent, title: c.title, calendar: c.calendar, all_day: c.all_day });
        failures.push(`- ${id} [${c.cat}] ${fr.length}/${total} «${c.text}»  ожидалось ${exp}`);
        for (const r of fr.slice(0, 2)) {
          const got = r.error ? `ERROR ${r.error}` : `${JSON.stringify(r.outcome)}  ← ${JSON.stringify(r.calls)}`;
          failures.push(`    получено: ${got}`);
        }
      }
    }
  }
  return `${lines.join("\n")}${failures.length ? `\n\n## Ошибки по фразам\n${failures.join("\n")}` : ""}`;
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
  if (!process.env.CLOUDFLARE_ACCOUNT_ID || !process.env.LLM_API_KEY) throw new Error("нужны CLOUDFLARE_ACCOUNT_ID и LLM_API_KEY (сервис deploy)");
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
