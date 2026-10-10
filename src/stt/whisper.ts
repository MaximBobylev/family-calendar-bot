// Два kind STT: у Workers AI нет OpenAI-совместимого `/audio/transcriptions` — только REST `/ai/run/<model>` (проверено).
// Замер Workers AI: OGG/Opus из Telegram принимается как есть; жёсткий language ломает английские голосовые — язык не задаём.

import { fetchWithTimeout, TIMEOUTS } from "../net/fetch";

export interface SttConfig {
  /** Имя для журнала и /admin: «groq», «workers-ai». Нет — адрес. */
  name?: string;
  /** Нет — "workers-ai". */
  kind?: "workers-ai" | "openai";
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Оценка цены, $ за минуту аудио; нет — COST_ESTIMATES (Workers AI). */
  perMin?: number;
}

export interface Transcript {
  text: string;
  language?: string;
  durationSec?: number;
  rateHeaders?: Record<string, string>;
}

export async function transcribe(cfg: SttConfig, audio: ArrayBuffer): Promise<Transcript> {
  return cfg.kind === "openai" ? transcribeOpenAi(cfg, audio) : transcribeWorkersAi(cfg, audio);
}

export async function transcribeChain(chain: SttConfig[], audio: ArrayBuffer): Promise<{ transcript: Transcript; via: SttConfig; failed: string[] }> {
  const failed: string[] = [];
  for (const cfg of chain) {
    try {
      return { transcript: await transcribe(cfg, audio), via: cfg, failed };
    } catch (e) {
      failed.push(`${cfg.name ?? cfg.baseUrl}: ${String(e instanceof Error ? e.message : e).slice(0, 300)}`);
    }
  }
  throw new SttChainError(failed);
}

export class SttChainError extends Error {
  constructor(readonly failed: string[]) {
    super(failed.join("; ") || "no STT providers configured");
  }
}

async function transcribeWorkersAi(cfg: SttConfig, audio: ArrayBuffer): Promise<Transcript> {
  const bytes = new Uint8Array(audio);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const res = await fetchWithTimeout(
    `${cfg.baseUrl}/run/${cfg.model}`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json" },
      // vad_filter убирает «Thank you.» на тишине (замер); у Groq его нет — тишину ловит HALLUCINATIONS
      body: JSON.stringify({ audio: btoa(binary), vad_filter: true }),
    },
    TIMEOUTS.stt,
  );
  if (!res.ok) throw new Error(`stt ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { result?: { text?: string; transcription_info?: { language?: string; duration?: number } } };
  const info = json.result?.transcription_info;
  return {
    text: (json.result?.text ?? "").trim(),
    ...(info?.language ? { language: info.language } : {}),
    ...(info?.duration !== undefined ? { durationSec: info.duration } : {}),
  };
}

/** verbose_json — чтобы узнать язык (сам язык не задаём: автоопределение). */
async function transcribeOpenAi(cfg: SttConfig, audio: ArrayBuffer): Promise<Transcript> {
  const form = new FormData();
  // Telegram присылает OGG/Opus; расширение подсказывает провайдеру формат
  form.append("file", new Blob([audio], { type: "audio/ogg" }), "voice.ogg");
  form.append("model", cfg.model);
  form.append("response_format", "verbose_json");
  form.append("temperature", "0");
  const res = await fetchWithTimeout(
    `${cfg.baseUrl}/audio/transcriptions`,
    { method: "POST", headers: { authorization: `Bearer ${cfg.apiKey}` }, body: form },
    TIMEOUTS.stt,
  );
  if (!res.ok) throw new Error(`stt ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { text?: string; language?: string; duration?: number };
  const rateHeaders: Record<string, string> = {};
  for (const [k, v] of res.headers) if (/^(x-ratelimit|retry-after)/i.test(k)) rateHeaders[k] = v;
  return {
    ...(Object.keys(rateHeaders).length ? { rateHeaders } : {}),
    text: (json.text ?? "").trim(),
    ...(json.language ? { language: json.language } : {}),
    ...(json.duration !== undefined ? { durationSec: json.duration } : {}),
  };
}

/** Только явный список, без нечёткой правки (как опечатки в парсере дат): «Рисование Аня от Мини» — «отмени», разрезанное надвое. */
const TRANSCRIPT_FIXES: [RegExp, string][] = [
  [/(?<!\p{L})от\s+м[еи]н(и|ь|ей)(?!\p{L})/giu, "отмени"],
  [/(?<!\p{L})созван(?!\p{L})/giu, "созвон"],
  // Синтетический замер (docs/research/voice-synth-eval.md): стабильно, 6 из 6
  [/(?<!\p{L})тем\s+лидом(?!\p{L})/giu, "тимлидом"],
  [/(?<!\p{L})спеты(?!\p{L})/giu, "с Петей"],
];

export function fixTranscript(text: string): string {
  const keepCase = (to: string) => (m: string) => (m[0] !== m[0]!.toLowerCase() ? to[0]!.toUpperCase() + to.slice(1) : to);
  return TRANSCRIPT_FIXES.reduce((t, [re, to]) => t.replace(re, keepCase(to)), text);
}

/** Типичные «галлюцинации» Whisper на тишине и шуме — считаем, что ничего не сказано. */
const HALLUCINATIONS = [
  /^продолжение следует/i,
  /субтитр/i,
  /^спасибо за (просмотр|внимание)/i,
  /^подписывайтесь/i,
  /^thank you( for watching)?\.?$/i,
  /^thanks for watching/i,
  /^you\.?$/i,
  /^\.+$/,
];

export function isEmptySpeech(text: string): boolean {
  const t = text.trim();
  return t.length === 0 || HALLUCINATIONS.some((p) => p.test(t));
}
