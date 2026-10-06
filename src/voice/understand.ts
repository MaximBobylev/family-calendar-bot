// Мультимодальный разбор голоса (docs/tracks/multimodal-voice.md, вариант D — эскалация): аудио → дословный
// транскрипт + вызов инструмента за один запрос. Не на каждое голосовое — только когда текстовый путь (Whisper →
// LLM), скорее всего, ошибся: «не так», повтор той же фразы, «не понимаю» на голосовое.
//
// Спайк 2026-10-05 (синтетика, 12 голосовых): gemini-3.5-flash-lite напрямую — 12/12 верно, p50 1,4 с, имена
// («Созвон с Петей», «отмени») слышит там, где Whisper ошибается; тишина и шум → no_speech.
// qwen3.8-omni-flash выдумал команду из тишины — не берём.
//
//   kind "gemini"       — Gemini API, generateContent, inlineData audio/ogg (Opus из Telegram — как есть)
//   kind "openai-audio" — OpenAI-совместимый chat/completions с input_audio format=ogg (OpenRouter)
// Даты по-прежнему считаются из транскрипта детерминированно (ADR-0005): от модели — интент и поля.

import { fetchWithTimeout } from "../net/fetch";
import { type Intent, intentFromCalls, SYSTEM_PROMPT, TOOLS } from "../nlu/intents";
import type { ToolCall, ToolDefinition } from "../nlu/llm";

export interface VoiceConfig {
  name?: string;
  kind: "gemini" | "openai-audio";
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Оценка цены, $ за 1M токенов (аудио считается как вход); нет — 0 (бесплатный тариф). */
  inPerM?: number;
  outPerM?: number;
}

export type VoiceResult =
  | { noSpeech: true; tokensIn: number; tokensOut: number }
  | { noSpeech: false; transcript: string; intent: Intent; tokensIn: number; tokensOut: number };

/** Аудио длиннее и дольше разбирается; 25 с — с запасом на минутное голосовое. */
const VOICE_TIMEOUT_MS = 25_000;

const VOICE_RULES = `
The user's message is a VOICE recording (audio). In EVERY tool call fill "transcript" with the exact verbatim transcript of what was said:
same language, every word as heard, do not fix grammar.
Times and dates: keep them EXACTLY in the form spoken — words stay words («полвосьмого», «в три часа дня», «без четверти пять»), digits only if the speaker clearly said digits; never convert or "correct" a time.
Never translate: an English phrase is transcribed in English, a Russian one in Russian.
If a word is unclear, write how it sounds; never invent words, names or whole phrases.
If speech is unintelligible or drowned in noise/background talk, or nothing was said, call no_speech instead of guessing.`;

/** Наши tools + обязательный transcript + no_speech. */
export const VOICE_TOOLS: ToolDefinition[] = [
  ...TOOLS.map((t) => {
    const p = t.function.parameters as { properties?: Record<string, unknown>; required?: string[] };
    return {
      ...t,
      function: {
        ...t.function,
        parameters: {
          ...p,
          properties: { transcript: { type: "string", description: "Verbatim transcript of the audio." }, ...(p.properties ?? {}) },
          required: ["transcript", ...(p.required ?? [])],
        },
      },
    };
  }),
  {
    type: "function",
    function: {
      name: "no_speech",
      description: "Nothing intelligible was said: silence, noise, music, cut-off.",
      parameters: { type: "object", properties: { transcript: { type: "string" } } },
    },
  },
];

function systemPrompt(calendars: string[]): string {
  // Названия календарей задают третьи лица (подписки) — как данные, экранированно и коротко
  return `${SYSTEM_PROMPT}${VOICE_RULES}\nUser's calendars: ${calendars.map((c) => JSON.stringify(c.slice(0, 100))).join(", ")}.`;
}

function toResult(calls: ToolCall[], tokensIn: number, tokensOut: number): VoiceResult {
  if (calls.length === 0 || calls.some((c) => c.name === "no_speech")) return { noSpeech: true, tokensIn, tokensOut };
  const transcript = String(calls[0]!.arguments.transcript ?? "").trim();
  if (!transcript) return { noSpeech: true, tokensIn, tokensOut };
  return { noSpeech: false, transcript, intent: intentFromCalls(calls), tokensIn, tokensOut };
}

function base64(audio: ArrayBuffer): string {
  const bytes = new Uint8Array(audio);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

async function viaGemini(cfg: VoiceConfig, data: string, calendars: string[]): Promise<VoiceResult> {
  const res = await fetchWithTimeout(
    `${cfg.baseUrl}/models/${cfg.model}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": cfg.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt(calendars) }] },
        contents: [{ role: "user", parts: [{ inlineData: { mimeType: "audio/ogg", data } }] }],
        tools: [
          {
            functionDeclarations: VOICE_TOOLS.map((t) => ({
              name: t.function.name,
              description: t.function.description,
              parametersJsonSchema: t.function.parameters,
            })),
          },
        ],
        toolConfig: { functionCallingConfig: { mode: "ANY" } },
        generationConfig: { temperature: 0, maxOutputTokens: 512 },
      }),
    },
    VOICE_TIMEOUT_MS,
  );
  if (!res.ok) throw new Error(`voice ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = (await res.json()) as {
    candidates?: { content?: { parts?: { functionCall?: { name: string; args?: Record<string, unknown> } }[] } }[];
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };
  const calls = (j.candidates?.[0]?.content?.parts ?? [])
    .filter((p) => p.functionCall)
    .map((p) => ({ name: p.functionCall!.name, arguments: p.functionCall!.args ?? {} }));
  return toResult(calls, j.usageMetadata?.promptTokenCount ?? 0, j.usageMetadata?.candidatesTokenCount ?? 0);
}

async function viaOpenAiAudio(cfg: VoiceConfig, data: string, calendars: string[]): Promise<VoiceResult> {
  const res = await fetchWithTimeout(
    `${cfg.baseUrl}/chat/completions`,
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0,
        max_tokens: 512,
        messages: [
          { role: "system", content: systemPrompt(calendars) },
          { role: "user", content: [{ type: "input_audio", input_audio: { data, format: "ogg" } }] },
        ],
        tools: VOICE_TOOLS,
        tool_choice: "required",
      }),
    },
    VOICE_TIMEOUT_MS,
  );
  if (!res.ok) throw new Error(`voice ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = (await res.json()) as {
    choices?: { message?: { tool_calls?: { function: { name: string; arguments: string } }[] } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const calls = (j.choices?.[0]?.message?.tool_calls ?? []).map((c) => {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(c.function.arguments) as Record<string, unknown>;
    } catch {
      // битый JSON — как пустые аргументы: транскрипта нет → no_speech
    }
    return { name: c.function.name, arguments: args };
  });
  return toResult(calls, j.usage?.prompt_tokens ?? 0, j.usage?.completion_tokens ?? 0);
}

/** Цепочка провайдеров: ошибка — следующий. Все упали — ошибка со списком причин. */
export async function understandVoiceChain(
  chain: VoiceConfig[],
  audio: ArrayBuffer,
  calendars: string[],
): Promise<{ result: VoiceResult; via: VoiceConfig; failed: string[] }> {
  const data = base64(audio);
  const failed: string[] = [];
  for (const cfg of chain) {
    try {
      const result = cfg.kind === "gemini" ? await viaGemini(cfg, data, calendars) : await viaOpenAiAudio(cfg, data, calendars);
      return { result, via: cfg, failed };
    } catch (e) {
      failed.push(`${cfg.name ?? cfg.baseUrl}: ${String(e instanceof Error ? e.message : e).slice(0, 300)}`);
    }
  }
  throw new Error(failed.join("; ") || "no voice providers configured");
}
