// Замер голосовых конвейеров на синтетическом шумном наборе (scripts/voice-synth.py). Тратит квоты прода — только
// с разрешения владельца, сначала --dry-run. A — прод: Whisper → текстовая LLM; B — Gemini по аудио напрямую;
// C — мультимодальная модель через OpenRouter: VOICE_OR_MODEL, поля запроса — VOICE_OR_EXTRA (по умолчанию reasoning off).
//   docker compose run --rm --entrypoint npx deploy tsx scripts/eval-voice.ts [папка=reports/voice-synth] \
//     [--dry-run] [--only A|B|C] [--files a.ogg,b.ogg] [--filter подстрока] [--limit N] [--resume [--retry-errors]] [--report] [--results файл.jsonl]
//   --dry-run — только оценка вызовов по провайдерам, без сети; --resume — пропустить уже записанное в results.jsonl
//   (--retry-errors — ошибки повторить; в сводке последняя запись по файлу заменяет прежнюю);
//   --report — только сводка по results.jsonl. Живой журнал — <папка>/live.log. Фразы — testdata/voice/phrases.yaml.
// Итоги — docs/research/voice-synth-eval.md.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { normalizeWords, sameWord } from "../src/calendar/match";
import { effectiveIntent } from "../src/nlu/intent-overrides";
import { type Intent, parseIntent } from "../src/nlu/intents";
import type { LlmConfig } from "../src/nlu/llm";
import { fixTranscript, isEmptySpeech, type SttConfig, transcribe } from "../src/stt/whisper";
import { understandVoiceChain, type VoiceConfig } from "../src/voice/understand";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const positional = argv.filter((a, i) => !a.startsWith("--") && !["--only", "--filter", "--limit", "--results", "--files"].includes(argv[i - 1] ?? ""));
const dir = positional[0] ?? "reports/voice-synth";
const only = opt("--only");
const pipelines = (only ? [only] : ["A", "B"]) as Pipeline[];
type Pipeline = "A" | "B" | "C";
const LIVE = join(dir, "live.log");
const RESULTS = join(dir, opt("--results") ?? "results.jsonl");

interface Phrase {
  id: string;
  lang: string;
  intent: string;
  keywords: string[];
  text: string;
}
const SET = parseYaml(readFileSync(join(import.meta.dirname, "..", "testdata", "voice", "phrases.yaml"), "utf8")) as { phrases: Phrase[] };
const phrases = new Map(SET.phrases.map((p) => [p.id, p]));
interface Item {
  file: string;
  phrase: string;
  voice: string;
  condition: string;
}
let items: Item[] = readFileSync(join(dir, "index.tsv"), "utf8")
  .trim()
  .split("\n")
  .slice(1)
  .map((l) => {
    const [file, phrase, voice, condition] = l.split("\t") as [string, string, string, string];
    return { file, phrase, voice, condition };
  });
const files = new Set((opt("--files") ?? "").split(",").filter(Boolean));
if (files.size) items = items.filter((i) => files.has(i.file));
const filter = opt("--filter");
if (filter) items = items.filter((i) => i.file.includes(filter));
const limit = Number(opt("--limit") ?? 0);
if (limit) items = items.slice(0, limit);

// Как в testdata/nlu/intents.yaml: названия и алиасы
const CALENDARS = ["Иван", "Семья", "общий", "Работа", "work", "Праздники"];

interface Result {
  file: string;
  pipeline: Pipeline;
  phrase: string;
  voice: string;
  condition: string;
  ok: boolean;
  error?: string;
  transcript?: string;
  raw?: string;
  intent?: string;
  sttMs?: number;
  llmMs?: number;
  ms?: number;
  kwHit?: number;
  kwTotal?: number;
  missed?: string[];
  intentOk?: boolean;
  noSpeechOk?: boolean;
}

const done: Result[] = existsSync(RESULTS)
  ? readFileSync(RESULTS, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Result)
  : [];

function latest(rs: Result[]): Result[] {
  return [...new Map(rs.map((r) => [`${r.pipeline}|${r.file}`, r])).values()];
}

function live(line: string): void {
  appendFileSync(LIVE, `${new Date().toISOString().slice(11, 19)} ${line}\n`);
  console.log(line);
}

// С допуском на окончания
function keywordRecall(keywords: string[], transcript: string): { hit: number; missed: string[] } {
  const words = normalizeWords(transcript);
  const missed = keywords.filter((k) => {
    const kw = normalizeWords(k)[0] ?? "";
    return !words.some((w) => sameWord(kw, w));
  });
  return { hit: keywords.length - missed.length, missed };
}

const COMMANDS = new Set(["create_event", "modify_event", "delete_event", "list_events", "find_event", "multiple"]);

function grade(r: Result, item: Item): Result {
  const p = phrases.get(item.phrase);
  if (!p) {
    // Без речи: любая команда — провал; пусто / no_speech / unsupported — верно
    r.noSpeechOk = r.ok ? !COMMANDS.has(r.intent ?? "") : undefined;
    return r;
  }
  if (!r.ok) return r;
  const { hit, missed } = keywordRecall(p.keywords, r.transcript ?? "");
  return { ...r, kwHit: hit, kwTotal: p.keywords.length, missed, intentOk: r.intent === p.intent };
}

const groq: SttConfig = {
  name: "groq",
  kind: "openai",
  baseUrl: "https://api.groq.com/openai/v1",
  apiKey: process.env.GROQ_API_KEY ?? "",
  model: process.env.GROQ_STT_MODEL || "whisper-large-v3-turbo",
};
const nemotron: LlmConfig = {
  name: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY ?? "",
  model: "nvidia/nemotron-3-super-120b-a12b:free",
  extraBody: { reasoning: { enabled: false } },
};
const gemini: VoiceConfig = {
  name: "gemini",
  kind: "gemini",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  apiKey: process.env.GEMINI_API_KEY ?? "",
  model: process.env.GEMINI_VOICE_MODEL || "gemini-3.5-flash-lite",
};

const orVoice: VoiceConfig = {
  name: "openrouter-voice",
  kind: "openai-audio",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY ?? "",
  model: process.env.VOICE_OR_MODEL || "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
};
// Прод (viaOpenAiAudio) не передаёт поля провайдера; для замера вклеиваем их в тело запросов с аудио к OpenRouter
const OR_VOICE_EXTRA: Record<string, unknown> = process.env.VOICE_OR_EXTRA ? JSON.parse(process.env.VOICE_OR_EXTRA) : { reasoning: { enabled: false } };
const realFetch = globalThis.fetch;
// OpenRouter бывает отвечает 200 с {"error":{…}} — прод принял бы это за no_speech; в замере это сбой
globalThis.fetch = async (input, init) => {
  if (!String(input).startsWith(orVoice.baseUrl)) return realFetch(input, init);
  const audio = typeof init?.body === "string" && init.body.includes('"input_audio"');
  const res = await realFetch(input, audio ? { ...init, body: JSON.stringify({ ...JSON.parse(init!.body as string), ...OR_VOICE_EXTRA }) } : init);
  if (!res.ok) return res;
  const body = await res.text();
  const code = /^\s*\{"id":"[^"]*","error":\{/.test(body) || /^\s*\{"error":\{/.test(body) ? 502 : res.status;
  return new Response(body, { status: code, headers: res.headers });
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isRateLimit = (e: unknown) => /\b(429|502|503)\b/.test(String(e));
const short = (e: unknown) =>
  String(e instanceof Error ? e.message : e)
    .replace(/\s+/g, " ")
    .slice(0, 200);

class Provider {
  calls = 0;
  failStreak = 0;
  dead = false;
  // Без паузы и ожидания после 429 — задержка самого провайдера
  lastMs = 0;
  private last = 0;
  constructor(
    readonly name: string,
    private readonly gapMs: number,
  ) {}
  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.dead) throw new Error(`${this.name}: отключён после сбоев подряд`);
    for (let attempt = 0; ; attempt++) {
      const wait = this.last + this.gapMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.last = Date.now();
      this.calls++;
      try {
        const r = await fn();
        this.lastMs = Date.now() - this.last;
        this.failStreak = 0;
        return r;
      } catch (e) {
        if (attempt === 0 && isRateLimit(e)) {
          live(`WAIT ${this.name}: ${short(e)} — пауза 60 с`);
          await sleep(60_000);
          continue;
        }
        if (++this.failStreak >= 5) {
          this.dead = true;
          live(`DEAD ${this.name}: 5 сбоев подряд — дальше без него`);
        }
        throw e;
      }
    }
  }
}
const P = {
  groq: new Provider("groq", 3_000),
  openrouter: new Provider("openrouter", 3_500),
  gemini: new Provider("gemini", 4_500),
  orvoice: new Provider("openrouter-voice", 2_500),
};

const intentName = (text: string, intent: Intent) => effectiveIntent(text, intent).name;

async function runA(item: Item, audio: ArrayBuffer): Promise<Result> {
  const base = { file: item.file, pipeline: "A" as const, phrase: item.phrase, voice: item.voice, condition: item.condition };
  const t0 = Date.now();
  let raw: string;
  try {
    raw = (await P.groq.call(() => transcribe(groq, audio))).text;
  } catch (e) {
    return { ...base, ok: false, error: `stt: ${short(e)}`, ms: Date.now() - t0 };
  }
  const sttMs = P.groq.lastMs;
  if (isEmptySpeech(raw)) return { ...base, ok: true, raw, transcript: "", intent: "no_speech", sttMs, llmMs: 0, ms: sttMs };
  const heard = fixTranscript(raw);
  try {
    const parsed = await P.openrouter.call(() => parseIntent(nemotron, heard, { calendars: CALENDARS }));
    const llmMs = P.openrouter.lastMs;
    return { ...base, ok: true, raw, transcript: heard, intent: intentName(heard, parsed.intent), sttMs, llmMs, ms: sttMs + llmMs };
  } catch (e) {
    return { ...base, ok: false, raw, transcript: heard, error: `llm: ${short(e)}`, sttMs, ms: Date.now() - t0 };
  }
}

async function runB(item: Item, audio: ArrayBuffer, pl: "B" | "C" = "B"): Promise<Result> {
  const base = { file: item.file, pipeline: pl, phrase: item.phrase, voice: item.voice, condition: item.condition };
  const t0 = Date.now();
  const prov = pl === "B" ? P.gemini : P.orvoice;
  try {
    const { result } = await prov.call(() => understandVoiceChain([pl === "B" ? gemini : orVoice], audio, CALENDARS));
    const ms = prov.lastMs;
    if (result.noSpeech) return { ...base, ok: true, transcript: "", intent: "no_speech", ms };
    return { ...base, ok: true, transcript: result.transcript, intent: intentName(result.transcript, result.intent), ms };
  } catch (e) {
    return { ...base, ok: false, error: short(e), ms: Date.now() - t0 };
  }
}

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(0)}% (${a}/${b})` : "—");
function quantile(xs: number[], q: number): string {
  if (!xs.length) return "—";
  const s = [...xs].sort((a, b) => a - b);
  return (s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]! / 1000).toFixed(1);
}
function row(label: string, rs: Result[]): string {
  const speech = rs.filter((r) => phrases.has(r.phrase));
  const empty = rs.filter((r) => !phrases.has(r.phrase));
  const ok = speech.filter((r) => r.ok);
  const kwHit = ok.reduce((s, r) => s + (r.kwHit ?? 0), 0);
  const kwTotal = ok.reduce((s, r) => s + (r.kwTotal ?? 0), 0);
  const lat = rs.filter((r) => r.ok && r.ms !== undefined).map((r) => r.ms!);
  const stt = rs.filter((r) => r.ok && r.sttMs !== undefined).map((r) => r.sttMs!);
  const llm = rs.filter((r) => r.ok && r.llmMs).map((r) => r.llmMs!);
  const split = stt.length ? ` (STT ${quantile(stt, 0.5)}/${quantile(stt, 0.95)}, LLM ${quantile(llm, 0.5)}/${quantile(llm, 0.95)})` : "";
  return `| ${label} | ${rs.length} | ${pct(kwHit, kwTotal)} | ${pct(
    ok.filter((r) => r.intentOk).length,
    speech.length,
  )} | ${empty.length ? pct(empty.filter((r) => r.noSpeechOk).length, empty.length) : "—"} | ${quantile(lat, 0.5)} / ${quantile(lat, 0.95)}${split} | ${rs.filter((r) => !r.ok).length} |`;
}
function summary(all: Result[]): void {
  const head = "| | файлов | ключевые слова | интент (из всех с речью) | без речи | p50 / p95, с | ошибок |\n|---|---|---|---|---|---|---|";
  const groups: [string, (r: Result) => string][] = [
    ["Итого", () => "все"],
    ["По условию", (r) => r.condition],
    ["По голосу", (r) => r.voice],
  ];
  for (const [title, key] of groups) {
    console.log(`\n### ${title}\n\n${head}`);
    for (const pl of ["A", "B", "C"] as const) {
      const rs = all.filter((r) => r.pipeline === pl);
      const keys = [...new Set(rs.map(key))];
      for (const k of keys)
        console.log(
          row(
            `${pl} ${k}`,
            rs.filter((r) => key(r) === k),
          ),
        );
    }
  }
  const bad = all.filter((r) => !r.ok || r.intentOk === false || r.noSpeechOk === false || (r.missed?.length ?? 0) > 0);
  console.log(`\n### Промахи (${bad.length})\n`);
  for (const r of bad)
    console.log(
      `- ${r.pipeline} ${r.file}: ${r.ok ? `«${r.raw && r.raw !== r.transcript ? `${r.raw}» → «` : ""}${r.transcript}» → ${r.intent}${r.missed?.length ? `, нет: ${r.missed.join(", ")}` : ""}` : `ERR ${r.error}`}`,
    );
}

if (flag("--report")) {
  summary(latest(done));
  process.exit(0);
}

const retryErrors = flag("--retry-errors");
const doneKeys = new Set(
  flag("--resume")
    ? latest(done)
        .filter((r) => r.ok || !retryErrors)
        .map((r) => `${r.pipeline}|${r.file}`)
    : [],
);
const todo = pipelines.flatMap((pl) => items.filter((i) => !doneKeys.has(`${pl}|${i.file}`)).map((i) => ({ pl, i })));
const nA = todo.filter((t) => t.pl === "A").length;
const nB = todo.filter((t) => t.pl === "B").length;
const nC = todo.filter((t) => t.pl === "C").length;
const nSpeechA = todo.filter((t) => t.pl === "A" && phrases.has(t.i.phrase)).length;
console.log(
  `Файлов: ${items.length}; заданий: A ${nA}, B ${nB}, C ${nC} (OpenRouter ${orVoice.model}).\n` +
    `Оценка вызовов: Groq ≤ ${nA} (лимит 2000/сутки), OpenRouter free ≤ ${nSpeechA} (+ повторы после 429; ≈1000/сутки), ` +
    `Gemini ≤ ${nB} (бесплатный тариф общий с переслушиванием в проде — держать ≤ 200, пауза ≥ 4 с).\n` +
    `Время: ≈ ${Math.ceil((nB * 6 + nA * 4) / 60)} мин последовательно. Workers AI не вызывается.`,
);
if (nB > 200) {
  console.log("Gemini > 200 вызовов — сократите набор (--filter/--limit).");
  process.exit(2);
}
if (flag("--dry-run")) process.exit(0);
for (const [k, v] of Object.entries({ GROQ_API_KEY: groq.apiKey, OPENROUTER_API_KEY: nemotron.apiKey, GEMINI_API_KEY: gemini.apiKey }))
  if (
    !v &&
    ((k === "GEMINI_API_KEY" && pipelines.includes("B")) ||
      (k !== "GEMINI_API_KEY" && pipelines.includes("A")) ||
      (k === "OPENROUTER_API_KEY" && pipelines.includes("C")))
  )
    throw new Error(`нет ${k}`);

live(`=== eval-voice: ${items.length} файлов × ${pipelines.join("+")}, LLM ${nemotron.model}, voice ${gemini.model}, C ${orVoice.model}`);
const results: Result[] = flag("--resume") ? [...done] : [];
// По файлу — все конвейеры подряд, чтобы условия сети были одинаковыми
for (const item of items) {
  const buf = readFileSync(join(dir, item.file));
  const audio = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  for (const pl of pipelines) {
    if (doneKeys.has(`${pl}|${item.file}`)) continue;
    const r = grade(pl === "A" ? await runA(item, audio) : await runB(item, audio, pl), item);
    results.push(r);
    appendFileSync(RESULTS, `${JSON.stringify(r)}\n`);
    const verdict = r.ok
      ? phrases.has(item.phrase)
        ? `${r.intentOk ? "intent✓" : "intent✗"} kw ${r.kwHit}/${r.kwTotal}${r.missed?.length ? ` (нет: ${r.missed.join(",")})` : ""}`
        : r.noSpeechOk
          ? "no-speech✓"
          : "ЛОЖНАЯ КОМАНДА"
      : "ERR";
    const timing = pl === "A" ? `${r.ms} мс (stt ${r.sttMs ?? "—"} + llm ${r.llmMs ?? "—"})` : `${r.ms} мс`;
    live(`${pl} ${item.file} ${timing} | «${r.transcript ?? ""}» → ${r.intent ?? r.error} | ${verdict}`);
  }
}
live(`=== вызовов: groq ${P.groq.calls}, openrouter ${P.openrouter.calls}, gemini ${P.gemini.calls}, openrouter-voice ${P.orvoice.calls}`);
summary(latest(results));
