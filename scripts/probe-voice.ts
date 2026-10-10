// Спайк мультимодального разбора голоса. Тратит квоты прода — только с разрешения владельца:
//   docker compose run --rm --entrypoint npx deploy tsx scripts/probe-voice.ts reports/voice-spike [модели…]
// Модели: «groq» (база: Whisper → текст), «gg:<модель>» (Gemini API напрямую, inlineData audio/ogg),
// «or:<модель>» (OpenRouter, input_audio format=ogg).
// Живой журнал: <папка>/live.log; индекс фраз: <папка>/index.txt («v01|эталонный текст»).

import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { intentFromCalls, SYSTEM_PROMPT, TOOLS } from "../src/nlu/intents";
import type { ToolDefinition } from "../src/nlu/llm";
import { type SttConfig, transcribe } from "../src/stt/whisper";

const dir = process.argv[2] ?? "reports/voice-spike";
const models = process.argv.slice(3).length
  ? process.argv.slice(3)
  : [
      "groq",
      "gg:gemini-3.1-flash-lite",
      "gg:gemini-3.5-flash-lite",
      "or:google/gemini-3.1-flash-lite",
      "or:qwen/qwen3.8-omni-flash",
      "or:xiaomi/mimo-v2.6-flash",
    ];
const LIVE = join(dir, "live.log");
const live = (line: string) => {
  appendFileSync(LIVE, `${new Date().toISOString().slice(11, 19)} ${line}\n`);
  console.log(line);
};

const reference = new Map(
  readFileSync(join(dir, "index.txt"), "utf8")
    .trim()
    .split("\n")
    .map((l) => l.split("|") as [string, string]),
);
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".ogg"))
  .sort();
const calendars = ["Иван", "Семья", "Работа"];

const VOICE_RULES = `
The user's message is a VOICE recording (audio). In EVERY tool call fill "transcript" with the exact verbatim transcript of what was said:
same language, every word as heard, numbers as heard, do not convert or normalize dates/times, do not fix grammar.
If nothing intelligible was said (silence, noise, music), call no_speech.`;

const VOICE_TOOLS: ToolDefinition[] = [
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
const system = `${SYSTEM_PROMPT}${VOICE_RULES}\nUser's calendars: ${calendars.map((c) => JSON.stringify(c)).join(", ")}.`;

interface Out {
  transcript: string;
  calls: { name: string; arguments: Record<string, unknown> }[];
  tokens?: string;
}

async function viaGemini(model: string, b64: string): Promise<Out> {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY ?? "" },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ inlineData: { mimeType: "audio/ogg", data: b64 } }] }],
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
  });
  if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).replace(/\s+/g, " ").slice(0, 300)}`);
  const j = (await res.json()) as {
    candidates?: { content?: { parts?: { functionCall?: { name: string; args?: Record<string, unknown> } }[] } }[];
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  };
  const calls = (j.candidates?.[0]?.content?.parts ?? [])
    .filter((p) => p.functionCall)
    .map((p) => ({ name: p.functionCall!.name, arguments: p.functionCall!.args ?? {} }));
  const u = j.usageMetadata;
  return {
    transcript: String(calls[0]?.arguments.transcript ?? ""),
    calls,
    tokens: `${u?.promptTokenCount}/${u?.candidatesTokenCount}${u?.thoughtsTokenCount ? `+think ${u.thoughtsTokenCount}` : ""}`,
  };
}

async function viaOpenRouter(model: string, b64: string): Promise<Out> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.OPENROUTER_API_KEY ?? ""}` },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 512,
      reasoning: { enabled: false },
      messages: [
        { role: "system", content: system },
        { role: "user", content: [{ type: "input_audio", input_audio: { data: b64, format: "ogg" } }] },
      ],
      tools: VOICE_TOOLS,
      tool_choice: "required",
    }),
  });
  if (!res.ok) throw new Error(`openrouter ${res.status}: ${(await res.text()).replace(/\s+/g, " ").slice(0, 300)}`);
  const j = (await res.json()) as {
    choices?: { message?: { tool_calls?: { function: { name: string; arguments: string } }[]; content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  };
  const calls = (j.choices?.[0]?.message?.tool_calls ?? []).map((c) => {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(c.function.arguments);
    } catch {}
    return { name: c.function.name, arguments: args };
  });
  return {
    transcript: String(calls[0]?.arguments.transcript ?? ""),
    calls,
    tokens: `${j.usage?.prompt_tokens}/${j.usage?.completion_tokens}${j.usage?.cost !== undefined ? ` $${j.usage.cost}` : ""}${calls.length ? "" : ` text: ${(j.choices?.[0]?.message?.content ?? "").slice(0, 80)}`}`,
  };
}

const groq: SttConfig = {
  name: "groq",
  kind: "openai",
  baseUrl: "https://api.groq.com/openai/v1",
  apiKey: process.env.GROQ_API_KEY ?? "",
  model: "whisper-large-v3-turbo",
};

live(`=== спайк: ${files.length} файлов × ${models.join(", ")}`);
const stats = new Map<string, number[]>();
for (const model of models) {
  for (const f of files) {
    const id = f.replace(".ogg", "");
    const buf = readFileSync(join(dir, f));
    const t0 = Date.now();
    try {
      let line: string;
      if (model === "groq") {
        const r = await transcribe(groq, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
        line = `«${r.text}»`;
      } else {
        const b64 = buf.toString("base64");
        const out = model.startsWith("gg:") ? await viaGemini(model.slice(3), b64) : await viaOpenRouter(model.slice(3), b64);
        const intent = out.calls.some((c) => c.name === "no_speech")
          ? { name: "no_speech" }
          : intentFromCalls(out.calls.map((c) => ({ ...c, arguments: c.arguments })));
        line = `«${out.transcript}» → ${JSON.stringify(intent)} [${out.tokens}]`;
      }
      const ms = Date.now() - t0;
      stats.set(model, [...(stats.get(model) ?? []), ms]);
      live(`OK   ${model} ${id} ${ms} мс | эталон «${reference.get(id)}» | ${line}`);
    } catch (e) {
      live(`ERR  ${model} ${id} ${Date.now() - t0} мс | ${String(e).replace(/\s+/g, " ").slice(0, 300)}`);
    }
    if (model.startsWith("gg:")) await new Promise((r) => setTimeout(r, 4000));
  }
}
for (const [model, ms] of stats) {
  const s = [...ms].sort((a, b) => a - b);
  live(`--- ${model}: ответов ${s.length}/${files.length}, p50 ${s[Math.floor((s.length - 1) / 2)]} мс, max ${s[s.length - 1]} мс`);
}
