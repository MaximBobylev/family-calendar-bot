// Клиент LLM по OpenAI-совместимому протоколу (chat/completions + tools).
// Один протокол у Workers AI, Groq, OpenRouter, DeepInfra — fallback-провайдеры отличаются только адресом
// и ключом (ADR-0002); в тестах адрес указывает на фейк (ADR-0006).

import { fetchWithTimeout, TIMEOUTS } from "../net/fetch";

export interface LlmConfig {
  /** Имя для журнала и /admin: «openrouter», «workers-ai». Нет — адрес. */
  name?: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Поля запроса провайдера: OpenRouter `reasoning`, Gemma `chat_template_kwargs` и т.п. */
  extraBody?: Record<string, unknown>;
  /** Оценка цены, $ за 1M токенов; нет — COST_ESTIMATES (Workers AI). Бесплатные — 0. */
  inPerM?: number;
  outPerM?: number;
}

export interface ToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
  /** Аргументы как пришли (строка JSON) — для замеров (scripts/eval-intents.ts). */
  rawArguments?: string;
}

/** Параметры запроса сверх обычных — только для замеров других моделей (scripts/eval-intents.ts). */
export interface CallOptions {
  maxTokens?: number;
  extraBody?: Record<string, unknown>;
}

export interface LlmResult {
  toolCalls: ToolCall[];
  tokensIn: number;
  tokensOut: number;
  /** Заголовки лимитов провайдера (x-ratelimit-*, retry-after) — для замеров и журнала. */
  rateHeaders?: Record<string, string>;
}

/** Ошибка провайдера с заголовками лимитов — чтобы замер видел, какой лимит сработал. */
export class LlmHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly rateHeaders: Record<string, string>,
  ) {
    super(message);
  }
}

function rateHeadersOf(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of res.headers) if (/^(x-ratelimit|retry-after)/i.test(k)) out[k] = v;
  return out;
}

export async function callTools(cfg: LlmConfig, system: string, user: string, tools: ToolDefinition[], opts: CallOptions = {}): Promise<LlmResult> {
  const res = await fetchWithTimeout(
    `${cfg.baseUrl}/chat/completions`,
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        tools,
        tool_choice: "required",
        // Запас под структуру даты `when` в create_event (≈ 50–100 токенов, ревью дат шаг 4)
        max_tokens: opts.maxTokens ?? 400,
        ...cfg.extraBody,
        ...opts.extraBody,
      }),
    },
    TIMEOUTS.llm,
  );
  if (!res.ok) throw new LlmHttpError(`llm ${res.status}: ${await res.text()}`, res.status, rateHeadersOf(res));
  const json = (await res.json()) as {
    choices?: { message?: { tool_calls?: { function: { name: string; arguments: string } }[] } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    error?: { message?: string; code?: number | string };
  };
  // OpenRouter иногда отвечает 200 с ошибкой в теле и без choices (перегрузка провайдера, 2026-10-08) —
  // это сбой провайдера, а не «модель не вызвала инструмент»: пусть цепочка попробует следующего
  if (json.error && !json.choices?.length) {
    throw new LlmHttpError(`llm 200 with error: ${JSON.stringify(json.error).slice(0, 300)}`, 502, rateHeadersOf(res));
  }
  const calls = json.choices?.[0]?.message?.tool_calls ?? [];
  return {
    rateHeaders: rateHeadersOf(res),
    toolCalls: calls.map((c) => ({ name: c.function.name, arguments: safeParse(c.function.arguments), rawArguments: c.function.arguments })),
    tokensIn: json.usage?.prompt_tokens ?? 0,
    tokensOut: json.usage?.completion_tokens ?? 0,
  };
}

/**
 * Аргументы tool call. Маленькие модели иногда возвращают битый JSON
 * (Qwen3: `{"start":"завтра в 15:30","title":"Созвон с Петей', "}`) — тогда достаём пары ключ-значение.
 */
export function safeParse(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    const out: Record<string, unknown> = {};
    for (const m of s.matchAll(/"(\w+)"\s*:\s*(?:"([^"']*)|(true|false))/g)) {
      out[m[1]!] = m[3] !== undefined ? m[3] === "true" : m[2]!.trim();
    }
    return out;
  }
}
