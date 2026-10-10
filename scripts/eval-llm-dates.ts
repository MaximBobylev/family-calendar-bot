// Может ли DeepSeek разрешать даты без нашей грамматики. Режимы: A — модель отдаёт итог в формате корпуса; B — структуру,
// итог считает src/dates/structured.ts; C — поле `when` в настоящем вызове разбора команды (только point).
// Модель платная — только с разрешения владельца, сначала --dry-run. Итоги — docs/research/llm-date-resolution-eval.md.
//   docker compose run --rm --entrypoint npx deploy tsx scripts/eval-llm-dates.ts --modes A,B --sample 300 --out reports/llm-dates/sample.json
//   … --full [--kinds point,range]        — весь корпус;  --holdout — testdata/dates/holdout-*.yaml;  --ids a,b — выборочно
//   … --modes C --kinds point               — структура в вызове интента, как в проде
//   … --dry-run                            — только список кейсов и число вызовов (без ключа, можно в сервисе test)
//   … --report reports/llm-dates/a.json[,b.json] [--failures 20] — сводка по сохранённым прогонам, без вызовов
//   --model deepseek-flash (по умолчанию), --concurrency 3, --seed 7

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseDateFragment } from "../src/dates";
import { parseLocal, weekday } from "../src/dates/calendar";
import { extractDateSpans } from "../src/dates/extract";
import { resolveRawStructure } from "../src/dates/structured";
import type { DayPart, ParseResult, ParseValue, ValueKind } from "../src/dates/types";
import { DATE_STRUCTURE_RULES, DATE_STRUCTURE_SCHEMA } from "../src/nlu/date-structure";
import { parseIntent } from "../src/nlu/intents";
import { CORPUS_DIR, type CorpusCase, canonical, loadCorpus, loadFiles } from "../test/support/date-corpus";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const flag = (name: string) => process.argv.includes(`--${name}`);
const list = (s: string | undefined) =>
  s
    ? s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
    : [];

const MODEL = arg("model") ?? "deepseek-flash";
// $ за 1M токенов: [низкая, высокая]
const PRICE = { miss: [0.15, 0.3], hit: [0.003, 0.006], out: [0.6, 1.2] } as const;
const WD_EN = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const INPUT_DOC = `Input: the fragment (Russian or English), kind — point (start of an event to create), range (a period to read/show), shift (move an event), duration, recurrence; now — the user's local date/time with weekday; tz — the user's IANA zone.`;

const SYSTEM_A = `You resolve a date/time fragment for a calendar bot into the FINAL value, following the rules exactly. Call the tool "result" once.
${INPUT_DOC}
All values are local times in tz without offset: "YYYY-MM-DDTHH:MM" or "YYYY-MM-DD".

Output (values[] in button order):
- datetime — a moment. date (+ part: morning|day|afternoon|late_afternoon|evening|night if a part of day was named, «завтра вечером»).
- interval {start,end} — event with start and end («с 10 до 12»). range {from,to} — period; dates inclusive, datetimes end-exclusive.
- shift — signed ISO 8601 (+PT1H, -P2D). duration — ISO 8601 (PT1H30M) or "all_day". recurrence {freq, interval?, by_day?, by_month?, by_month_day?, by_set_pos?, until?, count?, time? "HH:MM", warning?}.
- result_type: value (exactly 1 value) | ambiguous (2+ values) | error (unparseable | in_past | invalid_date | invalid_time | empty).

HOURS without am/pm: 1–6 → 13:00–18:00; 7–11 → 07–11; 12 → 12:00; 13–23 and 0:30 as said. «утра»/am → before noon; «дня»/«вечера»/pm → after noon; «ночи»: 1–5 → 01–05, «11 ночи» → 23:00, «12 ночи»/«полночь» → 00:00 of the NEXT day. «полдень»/«12 дня» → 12:00, «в обед» → 13:00. A part-of-day word sets the half: «в пятницу вечером в 7» → 19:00. The rule applies to the resulting hour: «без десяти семь» = 6:50 → 18:50. «полтретьего» 14:30, «в четверть третьего» 14:15, «без пятнадцати три» 14:45, «в пять минут восьмого» 07:05; «около/где-то/часов в» = exact. «15-30», «15.30», «в 15 30» = 15:30; «10-12» = interval 10–12; «в 9-15» (A-15, A<15) → ambiguous: 9:15 first, then interval 9:00–15:00; «в 16-15» → 16:15; «в 9-15 вечера» → 21:15.
TIME WITHOUT A DAY: still ahead (strictly after now) → today. Morning hour 7–12 without part of day passed but +12h ahead → ambiguous [today evening, tomorrow morning]; «в 12» late evening → [00:00 next day, tomorrow 12:00]. Both passed → tomorrow, no question. Hour 1–6 passed → tomorrow. Explicit part of day passed → next such time («в 8 утра» → tomorrow 08:00). Time equal to now = passed.
NAMED DAY: future day → as said, no past check. Today + morning hour 7–12 passed + evening ahead → evening of that day, no question («сегодня в 9» → 21:00). Today, passed, no evening alternative → in_past. Past day («вчера») → in_past.
WEEKDAY: «в пятницу» (not today) → nearest future Friday. Weekday is today: time ahead → ambiguous [today, +7 days]; time passed → +7 days; no time → ambiguous [today, +7]. «в эту пятницу», «this Friday», «ближайшая пятница» → nearest, today if today. «в следующую пятницу», «next Friday» → ALWAYS ambiguous [nearest Friday after today, +7 after it]. «в пятницу на следующей неделе», «next week Friday» → that day of the next calendar week (Mon–Sun). «в понедельник через неделю» = «через неделю в понедельник» → nearest Monday (today if Monday) + 7. «в среду 14-го»: matches → the 14th; «в четверг 14-го» when the 14th is Wednesday → ambiguous [the 14th, Thursday of that week].
DATES: «14 октября», «14.10», «на 14-е», «23-го», «двадцать третьего» → nearest such date, today inclusive; passed this year → next year; day number passed this month → next month. «29 февраля» → nearest leap year. «30 февраля» → invalid_date; 25:00 → invalid_time.
RELATIVE: «через час», «через полтора часа», «in 2 hours», «через 24 часа» → datetime now + real time (DST-aware). «через 2 дня/неделю/день/месяц» → calendar date (value date; with a named hour — datetime). «через сутки» = now + 24h; with an hour («через сутки в 10») → like «через день в 10».
NIGHT: «завтра ночью», «<day> ночью» → the night AFTER that day: {date: day+1, part: night}; «ночью», «сегодня ночью» → {date: tomorrow, part: night}. Hours 1–5 «ночи» with a named day also go to the next date: «завтра в 2 ночи» = «завтра ночью в 2» → day after tomorrow 02:00; «в пятницу в 3 ночи» → Saturday 03:00; without a day «в 2 ночи» → nearest 02:00. English «tomorrow night», «friday night», «tonight», «at night» = evening; English «night» alone is not a date.
PARTS OF DAY: утром/с утра/в первой половине дня = morning 06–12; днём/во второй половине дня = day 12–18; после обеда/после полудня/afternoon = afternoon 13–18; ближе к вечеру/к вечеру/под вечер/late afternoon = late_afternoon 16–20; вечером = evening 18–24; ночью = night 00–06. kind=point: part without an hour → {date, part}. Part without a day already over today → tomorrow. «first thing tomorrow», «завтра первым делом», «завтра с утра пораньше» → tomorrow 09:00.
POINT SPECIALS: «на неделе», «на этой неделе», «this week» → ONE day: middle of the remaining weekdays [tomorrow … Friday], the earlier of two middles (Mon→Wed, Tue→Thu, Wed→Thu, Thu→Fri); Fri–Sun → Wednesday of next week; with an hour → that day at that hour. «в выходные», «на выходных», «this weekend» → ambiguous [Saturday, Sunday] of the nearest weekend (on Saturday: today, tomorrow; on Sunday: only today), with an hour — datetimes, each day by the usual rules. «к пятнице», «by Friday», «к 5 ноября» → that day 09:00 (with an hour — that hour); «к среде» on Wednesday after 09:00 → next Wednesday 09:00. «к 18», «к шести», «by 6pm» → like «в 18». «в начале/середине/конце месяца/недели» → unparseable for point. Other periods for point («с 10 по 20 ноября», «в ноябре», «на следующей неделе», «на следующих выходных») → range of dates as for reading.
RANGES (kind=range): week starts Monday. A day → {from: D, to: D}; a day + part → datetimes, e.g. «сегодня вечером» → {from: "D T18:00", to: "D+1 T00:00"}. «на этой неделе», «до конца недели», «покажи неделю» → today..Sunday. «на следующей неделе», «next week» → next Mon..Sun. «в выходные», «на этих выходных» → nearest Sat–Sun (only remaining days). «на следующих выходных» → ambiguous [nearest weekend, the one after]; said on Sat/Sun → [next weekend, the one after]. «в этом месяце», current month by name → today..end of month; «в следующем месяце», «в ноябре» → whole month (a past month → next year). «ближайшие 3 дня», «на две недели вперёд» → N days including today. «в начале/середине/конце месяца» → days 1–10/11–20/21–last; week: начало Mon–Wed, конец Thu–Sun; «в середине недели» → unparseable. Without «этого/следующего»: current, from today to the end of that part; if the part is over → same part of next month/week. «этого/этой» → current only; over → in_past. «следующего» → the whole part. «в конце ноября» → like «в ноябре». «с 10 по 20 ноября» → range of dates.
INTERVALS: «с часу до двух» → 13:00–14:00. End = nearest suitable time after start («с 23 до 2» → 23:00–02:00 next day). A part of day on the end applies to the start («from 1 to 2pm» → 13–14). An interval without a day that already fully ended today → tomorrow; one in progress stays today.
TIME ZONES: an explicit zone («в 15:00 по Киеву», «по МСК», «мск», «3pm London time», «по UTC+4», «Europe/Berlin») → compute in that zone (its own today/now) and convert to the user's tz. «по местному», «local time» → user's zone. A city not in the bot's dictionary (Moscow, Kyiv, Minsk, Kaliningrad, Yekaterinburg, Novosibirsk, Tbilisi, Yerevan, Almaty, Tashkent, Baku, Warsaw, Berlin, Prague, Paris, London, Lisbon, Belgrade, Istanbul, Dubai, New York, Los Angeles, São Paulo, Buenos Aires) → unparseable.
UNPARSEABLE: vague («на днях», «скоро», «когда-нибудь», «в середине недели», «после работы»), deadlines («до пятницы», «к обеду», «к утру», «к концу недели/дня», «к следующей неделе», «by end of day», «EOD»), unknown words. Typos only from a closed list («завтро», «пятнцу», «tommorow»); real different words («пятно», «завтрак») → unparseable. Latin look-alike letters inside Russian words are fine. «пара» = 2; «через недельку/часик» = неделю/час; «после завтра» = послезавтра; «будущая/след. неделя» = следующая.
SHIFT/DURATION/RECURRENCE: «на час позже» +PT1H, «на полчаса раньше» -PT30M, «на неделю вперёд» +P7D, no direction → later; «на сутки позже» +PT24H. «часа на три» PT3H, «на весь день» all_day. «каждую вторую среду» → weekly, interval 2, by_day [WE]; «каждую вторую среду месяца» → monthly, by_day [WE], by_set_pos 2; time by the hour rules («каждый понедельник в 3» → "15:00"); «31 числа каждого месяца» → warning skips_short_months; «каждое утро в 8» → daily 08:00.`;

// Те же правила и схема, что у поля `when` в create_event: замер мерит прод
const SYSTEM_B = `You convert a date/time fragment for a calendar bot into a STRUCTURE. Call the tool "structure" once.
${INPUT_DOC}
${DATE_STRUCTURE_RULES}`;

const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const PARTS = ["morning", "day", "afternoon", "late_afternoon", "evening", "night"];

const TOOL_A = {
  type: "function",
  function: {
    name: "result",
    description: "The resolved value of the fragment.",
    parameters: {
      type: "object",
      properties: {
        result_type: { type: "string", enum: ["value", "ambiguous", "error"] },
        error: { type: "string", enum: ["unparseable", "in_past", "invalid_date", "invalid_time", "empty"] },
        values: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["datetime", "date", "interval", "range", "shift", "duration", "recurrence"] },
              datetime: { type: "string" },
              date: { type: "string" },
              part: { type: "string", enum: PARTS },
              start: { type: "string" },
              end: { type: "string" },
              from: { type: "string" },
              to: { type: "string" },
              shift: { type: "string" },
              duration: { type: "string" },
              recurrence: {
                type: "object",
                properties: {
                  freq: { type: "string", enum: ["daily", "weekly", "monthly", "yearly"] },
                  interval: { type: "integer" },
                  by_day: { type: "array", items: { type: "string", enum: WEEKDAYS } },
                  by_month: { type: "integer" },
                  by_month_day: { type: "integer" },
                  by_set_pos: { type: "integer" },
                  until: { type: "string" },
                  count: { type: "integer" },
                  time: { type: "string" },
                  warning: { type: "string", enum: ["skips_short_months"] },
                },
                required: ["freq"],
              },
            },
            required: ["type"],
          },
        },
      },
      required: ["result_type"],
    },
  },
};

const TOOL_B = {
  type: "function",
  function: { name: "structure", description: "Structure of the date/time fragment.", parameters: DATE_STRUCTURE_SCHEMA },
};

interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}
interface Call {
  args?: Record<string, unknown>;
  usage?: Usage;
  ms: number;
  error?: string;
}

const userMessage = (c: CorpusCase) => {
  const n = parseLocal(c.input.now);
  return `fragment: «${c.input.text}»\nkind: ${c.input.kind}\nnow: ${c.input.now} (${WD_EN[weekday(n.day)]})\ntz: ${c.input.tz}`;
};

type Mode = "A" | "B" | "C";
const MODES: Mode[] = ["A", "B", "C"];

const commandOf = (text: string) => (/[а-яё]/i.test(text) || !text.trim() ? `Поставь встречу ${text}` : `Schedule a meeting ${text}`);

async function callModel(mode: Mode, c: CorpusCase): Promise<Call> {
  if (mode === "C") return callIntent(c);
  const t0 = Date.now();
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${process.env.DEEPSEEK_API_KEY ?? ""}` },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({
          model: MODEL,
          temperature: 0,
          max_tokens: 500,
          thinking: { type: "disabled" },
          messages: [
            { role: "system", content: mode === "A" ? SYSTEM_A : SYSTEM_B },
            { role: "user", content: userMessage(c) },
          ],
          tools: [mode === "A" ? TOOL_A : TOOL_B],
          tool_choice: { type: "function", function: { name: mode === "A" ? "result" : "structure" } },
        }),
      });
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= 4) return { ms: Date.now() - t0, error: `http ${res.status}` };
        await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
        continue;
      }
      if (!res.ok) return { ms: Date.now() - t0, error: `http ${res.status}: ${(await res.text()).slice(0, 200)}` };
      const j = (await res.json()) as { choices?: { message?: { tool_calls?: { function: { arguments: string } }[] } }[]; usage?: Usage };
      const raw = j.choices?.[0]?.message?.tool_calls?.[0]?.function.arguments;
      const ms = Date.now() - t0;
      if (!raw) return { ms, usage: j.usage, error: "no tool call" };
      try {
        return { ms, usage: j.usage, args: JSON.parse(raw) as Record<string, unknown> };
      } catch {
        return { ms, usage: j.usage, error: `bad json: ${raw.slice(0, 200)}` };
      }
    } catch (e) {
      if (attempt >= 2) return { ms: Date.now() - t0, error: String(e).slice(0, 200) };
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

async function callIntent(c: CorpusCase): Promise<Call> {
  const t0 = Date.now();
  const cfg = { baseUrl: "https://api.deepseek.com", apiKey: process.env.DEEPSEEK_API_KEY ?? "", model: MODEL, extraBody: { thinking: { type: "disabled" } } };
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await parseIntent(cfg, commandOf(c.input.text), { calendars: [] });
      const call = res.toolCalls?.find((t) => t.name === "create_event");
      const usage = { prompt_tokens: res.tokensIn, completion_tokens: res.tokensOut };
      const intent = call?.name ?? res.toolCalls?.[0]?.name ?? "none";
      return { ms: Date.now() - t0, usage, args: { intent, ...(call ? { start: call.arguments.start, when: call.arguments.when } : {}) } };
    } catch (e) {
      if (attempt >= 3) return { ms: Date.now() - t0, error: String(e).slice(0, 200) };
      await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
    }
  }
}

type Obj = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

function fromA(a: Obj): ParseResult {
  if (a.result_type === "error") return { error: (str(a.error) ?? "unparseable") as "unparseable" };
  const values = (Array.isArray(a.values) ? (a.values as Obj[]) : []).map((v): ParseValue | null => {
    switch (v.type) {
      case "datetime":
        return str(v.datetime) ? { datetime: str(v.datetime)! } : null;
      case "date": {
        const d = str(v.date);
        if (!d) return null;
        return { date: str(v.part) ? { date: d, part: v.part as DayPart } : d };
      }
      case "interval":
        return str(v.start) && str(v.end) ? { interval: { start: str(v.start)!, end: str(v.end)! } } : null;
      case "range":
        return str(v.from) && str(v.to) ? { range: { from: str(v.from)!, to: str(v.to)! } } : null;
      case "shift":
        return str(v.shift) ? { shift: str(v.shift)! } : null;
      case "duration":
        return str(v.duration) ? { duration: str(v.duration)! } : null;
      case "recurrence":
        return v.recurrence && typeof v.recurrence === "object" ? { recurrence: v.recurrence as never } : null;
      default:
        return null;
    }
  });
  const ok = values.filter((v): v is ParseValue => v !== null);
  if (ok.length === 0) return { error: "unparseable" };
  return ok.length === 1 ? ok[0]! : { ambiguous: ok };
}

// Не create_event или нет/испорчена структура — бот переспросит; для замера это «не разобрал»
function fromC(a: Obj, c: CorpusCase): ParseResult | "unsupported" {
  if (c.input.kind !== "point") return "unsupported";
  if (a.intent !== "create_event") return { error: "unparseable" };
  return resolveRawStructure(a.when, "point", c.input.now, c.input.tz) ?? { error: "unparseable" };
}

function fromB(s: Obj, c: CorpusCase): ParseResult | "unsupported" {
  const kind = c.input.kind;
  if (kind !== "point" && kind !== "range") return "unsupported";
  // Испорченная структура в боте отбрасывается (второго мнения нет) — для замера это «не разобрал»
  return resolveRawStructure(s, kind, c.input.now, c.input.tz) ?? { error: "unparseable" };
}

interface Row {
  id: string;
  file: string;
  kind: ValueKind;
  now: string;
  text: string;
  status?: string;
  mode: Mode;
  expect: ParseResult;
  got?: ParseResult | "unsupported";
  args?: Record<string, unknown>;
  error?: string;
  ms: number;
  usage?: Usage;
}

const primary = (r: ParseResult): string | undefined => ("error" in r ? undefined : canonical("ambiguous" in r ? r.ambiguous[0] : r));
const options = (r: ParseResult): string[] => ("ambiguous" in r ? r.ambiguous.map((v) => canonical(v)) : "error" in r ? [] : [canonical(r)]);

// exact — точно; first — первый вариант модели = ожидаемому первому; any — первый вариант модели среди ожидаемых
function score(expect: ParseResult, got: ParseResult | "unsupported" | undefined) {
  if (!got || got === "unsupported") return { exact: false, first: false, any: false };
  const exact = canonical(got) === canonical(expect);
  if (exact) return { exact, first: true, any: true };
  if (!("ambiguous" in expect)) return { exact, first: false, any: false };
  const p = primary(got);
  return { exact, first: p === canonical(expect.ambiguous[0]), any: p !== undefined && options(expect).includes(p) };
}

const NV: Record<string, string> = {
  mon: "пн 07:00",
  fri: "пт 23:30",
  sun: "вс 23:50",
  dec31: "31.12 18:00",
  feb28: "28.02 12:00",
  dst: "ночь перехода (Берлин 01:30)",
};
const nowGroup = (r: Row) =>
  r.file === "16-now-variety.yaml"
    ? (NV[r.id.split("-").pop()!] ?? "16: прочее")
    : r.now === "2026-10-07T10:00"
      ? "ср 10:00 (основной корпус)"
      : "другое «сейчас» в 01–15";
const expGroup = (e: ParseResult) => ("error" in e ? `error:${e.error}` : "ambiguous" in e ? "ambiguous" : Object.keys(e)[0]!);

function cost(us: Usage[]): [number, number] {
  let lo = 0;
  let hi = 0;
  for (const u of us) {
    const hit = u.prompt_cache_hit_tokens ?? 0;
    const miss = u.prompt_cache_miss_tokens ?? Math.max(0, (u.prompt_tokens ?? 0) - hit);
    const out = u.completion_tokens ?? 0;
    lo += (miss * PRICE.miss[0] + hit * PRICE.hit[0] + out * PRICE.out[0]) / 1e6;
    hi += (miss * PRICE.miss[1] + hit * PRICE.hit[1] + out * PRICE.out[1]) / 1e6;
  }
  return [lo, hi];
}

const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "—");

function table(rows: Row[], key: (r: Row) => string, title: string) {
  const groups = new Map<string, Row[]>();
  for (const r of rows) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
  console.log(`\n### ${title}\n\n| группа | режим | n | exact | any (≈ решающая) | first |\n|---|---|---|---|---|---|`);
  for (const [g, rs] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    for (const mode of MODES) {
      const m = rs.filter((r) => r.mode === mode && r.got !== "unsupported");
      if (!m.length) continue;
      const s = m.map((r) => score(r.expect, r.got));
      console.log(
        `| ${g} | ${mode} | ${m.length} | ${pct(s.filter((x) => x.exact).length, m.length)} | ${pct(s.filter((x) => x.any).length, m.length)} | ${pct(s.filter((x) => x.first).length, m.length)} |`,
      );
    }
  }
}

function report(rows: Row[], failures: number) {
  console.log(
    `\n## Сводка (${rows.length} строк)\n\n| режим | n | покрыто | exact | any | first | ошибки вызова | p50 мс | p95 мс | ток. вход/выход (ср.) | кеш-хит | $ (низк.–выс.) |\n|---|---|---|---|---|---|---|---|---|---|---|---|`,
  );
  for (const mode of MODES) {
    const m = rows.filter((r) => r.mode === mode);
    if (!m.length) continue;
    const cov = m.filter((r) => r.got !== "unsupported");
    const s = cov.map((r) => score(r.expect, r.got));
    const ms = m.map((r) => r.ms).sort((a, b) => a - b);
    const us = m.flatMap((r) => (r.usage ? [r.usage] : []));
    const inT = us.reduce((a, u) => a + (u.prompt_tokens ?? 0), 0);
    const outT = us.reduce((a, u) => a + (u.completion_tokens ?? 0), 0);
    const hitT = us.reduce((a, u) => a + (u.prompt_cache_hit_tokens ?? 0), 0);
    const [lo, hi] = cost(us);
    console.log(
      `| ${mode} | ${m.length} | ${cov.length} | ${pct(s.filter((x) => x.exact).length, cov.length)} | ${pct(s.filter((x) => x.any).length, cov.length)} | ${pct(s.filter((x) => x.first).length, cov.length)} | ${m.filter((r) => r.error).length} | ${ms[Math.floor(ms.length / 2)]} | ${ms[Math.floor(ms.length * 0.95)]} | ${Math.round(inT / us.length)}/${Math.round(outT / us.length)} | ${pct(hitT, inT)} | ${lo.toFixed(4)}–${hi.toFixed(4)} |`,
    );
  }
  table(rows, (r) => r.file, "По файлам");
  table(rows, (r) => r.kind, "По виду");
  table(rows, nowGroup, "По «сейчас»");
  table(rows, (r) => expGroup(r.expect), "По виду ожидания");
  // Ложные ошибки — модель отказалась там, где есть значение
  for (const mode of MODES) {
    const m = rows.filter((r) => r.mode === mode && r.got && r.got !== "unsupported");
    const falseErr = m.filter((r) => !("error" in r.expect) && "error" in (r.got as ParseResult)).length;
    const missedErr = m.filter((r) => "error" in r.expect && !("error" in (r.got as ParseResult))).length;
    const ambExp = m.filter((r) => "ambiguous" in r.expect);
    const ambGot = ambExp.filter((r) => "ambiguous" in (r.got as ParseResult)).length;
    const extraAmb = m.filter((r) => !("ambiguous" in r.expect) && "ambiguous" in (r.got as ParseResult)).length;
    console.log(
      `\n${mode}: ложная ошибка (ждали значение) — ${falseErr}; пропущенная ошибка (ждали ошибку, дала значение) — ${missedErr}; ждали варианты — ${ambExp.length}, модель дала варианты — ${ambGot}; лишние варианты — ${extraAmb}`,
    );
  }
  if (failures) {
    for (const mode of MODES) {
      const bad = rows.filter((r) => r.mode === mode && r.got !== "unsupported" && !score(r.expect, r.got).exact);
      console.log(`\n## Неточные ${mode} (${bad.length}), первые ${failures}\n`);
      for (const r of bad.slice(0, failures)) {
        console.log(
          `- ${r.id} «${r.text}» (${r.kind}, ${r.now}): ждали ${canonical(r.expect)}; ${r.error ? `сбой ${r.error}` : `получили ${canonical(r.got)}`}${mode !== "A" && r.args ? `; структура ${JSON.stringify(r.args)}` : ""}`,
        );
      }
    }
  }
}

function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 300 = 90 из 16-now-variety (point/range) + 190 point/range из 01–15 пропорционально + 20 shift/duration/recurrence
function stratified(all: CorpusCase[], total: number, seed: number): CorpusCase[] {
  const rand = rng(seed);
  const shuffle = <T>(xs: T[]) => {
    const a = [...xs];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
  };
  const pr = (c: CorpusCase) => c.input.kind === "point" || c.input.kind === "range";
  const nOther = Math.round(total * (20 / 300));
  const nNv = Math.round(total * 0.3);
  const nRest = total - nOther - nNv;
  const out: CorpusCase[] = [];
  out.push(...shuffle(all.filter((c) => c.file === "16-now-variety.yaml" && pr(c))).slice(0, nNv));
  const byFile = new Map<string, CorpusCase[]>();
  for (const c of all.filter((c) => c.file !== "16-now-variety.yaml" && pr(c))) byFile.set(c.file, [...(byFile.get(c.file) ?? []), c]);
  const size = [...byFile.values()].reduce((a, x) => a + x.length, 0);
  const quota = [...byFile].map(([f, cs]) => ({ f, cs, q: (cs.length * nRest) / size }));
  const take = new Map(quota.map((x) => [x.f, Math.floor(x.q)]));
  let left = nRest - [...take.values()].reduce((a, b) => a + b, 0);
  for (const x of [...quota].sort((a, b) => (b.q % 1) - (a.q % 1))) if (left-- > 0) take.set(x.f, take.get(x.f)! + 1);
  for (const { f, cs } of quota) out.push(...shuffle(cs).slice(0, take.get(f)));
  const other = all.filter((c) => !pr(c));
  for (const [k, n] of [
    ["shift", Math.round(nOther * 0.3)],
    ["duration", Math.round(nOther * 0.3)],
    ["recurrence", nOther - 2 * Math.round(nOther * 0.3)],
  ] as const) {
    out.push(...shuffle(other.filter((c) => c.input.kind === k)).slice(0, n));
  }
  return out;
}

async function pool<T>(items: T[], n: number, fn: (x: T, i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i]!, i);
      }
    }),
  );
}

function ours(cases: CorpusCase[]) {
  console.log("\n## Наш парсер\n\n| id | фрагмент | ждали | parseDateFragment | извлечение |\n|---|---|---|---|---|");
  let ok = 0;
  for (const c of cases) {
    const got = parseDateFragment(c.input);
    if (canonical(got) === canonical(c.expect)) ok++;
    const kind = c.input.kind === "range" ? "range" : "point";
    const sp = extractDateSpans(c.input.text, c.input.now, c.input.tz, kind);
    const viaExtract = sp.unsure ? "unsure → «Когда?»" : sp.point ? `«${sp.point}» → ${canonical(parseDateFragment({ ...c.input, text: sp.point }))}` : "—";
    console.log(`| ${c.id} | ${c.input.text} | ${canonical(c.expect)} | ${canonical(got)} | ${viaExtract} |`);
  }
  console.log(`\nНаш парсер: ${ok} / ${cases.length} точно`);
}

async function main() {
  const reportFiles = list(arg("report"));
  const failures = Number(arg("failures") ?? 0);
  if (reportFiles.length) {
    const rows = reportFiles.flatMap((f) => JSON.parse(readFileSync(f, "utf8")) as Row[]);
    report(rows, failures);
    if (flag("ours")) ours(loadFiles([...new Set(rows.map((r) => r.file))]).filter((c) => rows.some((r) => r.id === c.id)));
    return;
  }

  const modes = list(arg("modes") ?? "A,B") as Mode[];
  const kinds = list(arg("kinds"));
  const ids = list(arg("ids"));
  let cases: CorpusCase[];
  if (flag("holdout")) cases = loadFiles(readdirSync(CORPUS_DIR).filter((f) => f.startsWith("holdout-") && f.endsWith(".yaml")));
  else if (flag("full")) cases = loadCorpus();
  else cases = stratified(loadCorpus(), Number(arg("sample") ?? 300), Number(arg("seed") ?? 7));
  if (kinds.length) cases = cases.filter((c) => kinds.includes(c.input.kind));
  if (ids.length) cases = cases.filter((c) => ids.includes(c.id));

  const covered = (m: Mode, c: CorpusCase) => m === "A" || c.input.kind === "point" || (m === "B" && c.input.kind === "range");
  const jobs = cases.flatMap((c) => modes.filter((m) => covered(m, c)).map((m) => ({ c, m })));
  const count = (key: (c: CorpusCase) => string) => {
    const m = new Map<string, number>();
    for (const c of cases) m.set(key(c), (m.get(key(c)) ?? 0) + 1);
    return [...m];
  };
  const byKind = count((c) => c.input.kind);
  const byFile = count((c) => c.file);
  console.log(`Кейсов: ${cases.length} (${byKind.map(([k, n]) => `${k} ${n}`).join(", ")}); вызовов ${MODEL}: ${jobs.length}`);
  console.log(byFile.map(([f, n]) => `${f} ${n}`).join("; "));
  if (flag("dry-run")) return;
  if (!process.env.DEEPSEEK_API_KEY) throw new Error("нет DEEPSEEK_API_KEY (запускать в сервисе deploy)");

  const rows: Row[] = cases.flatMap((c) =>
    modes
      .filter((m) => !covered(m, c))
      .map((m) => ({
        id: c.id,
        file: c.file,
        kind: c.input.kind,
        now: c.input.now,
        text: c.input.text,
        mode: m,
        expect: c.expect,
        got: "unsupported" as const,
        ms: 0,
      })),
  );
  let done = 0;
  await pool(jobs, Number(arg("concurrency") ?? 3), async ({ c, m }) => {
    const call = await callModel(m, c);
    let got: ParseResult | undefined;
    if (call.args) got = (m === "A" ? fromA(call.args) : m === "B" ? fromB(call.args, c) : fromC(call.args, c)) as ParseResult;
    rows.push({
      id: c.id,
      file: c.file,
      kind: c.input.kind,
      now: c.input.now,
      text: c.input.text,
      ...(c.status ? { status: c.status } : {}),
      mode: m,
      expect: c.expect,
      ...(got ? { got } : {}),
      ...(call.args ? { args: call.args } : {}),
      ...(call.error ? { error: call.error } : {}),
      ms: call.ms,
      ...(call.usage ? { usage: call.usage } : {}),
    });
    if (++done % 25 === 0) console.error(`… ${done} / ${jobs.length}`);
  });
  rows.sort((a, b) => a.file.localeCompare(b.file) || a.id.localeCompare(b.id) || a.mode.localeCompare(b.mode));
  const out = arg("out");
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(rows, null, 1));
    console.log(`Сохранено: ${out}`);
  }
  report(rows, failures);
  if (flag("holdout")) ours(cases);
}

await main();
