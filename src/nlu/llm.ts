// Клиент LLM по OpenAI-совместимому протоколу (chat/completions + tools).
// Один протокол у Workers AI, Groq, OpenRouter, DeepInfra — fallback-провайдеры отличаются только адресом
// и ключом (ADR-0002); в тестах адрес указывает на фейк (ADR-0006).

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface LlmResult {
  toolCalls: ToolCall[];
  tokensIn: number;
  tokensOut: number;
}

export async function callTools(
  cfg: LlmConfig,
  system: string,
  user: string,
  tools: ToolDefinition[],
): Promise<LlmResult> {
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
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
    }),
  });
  if (!res.ok) throw new Error(`llm ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as {
    choices?: { message?: { tool_calls?: { function: { name: string; arguments: string } }[] } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const calls = json.choices?.[0]?.message?.tool_calls ?? [];
  return {
    toolCalls: calls.map((c) => ({ name: c.function.name, arguments: safeParse(c.function.arguments) })),
    tokensIn: json.usage?.prompt_tokens ?? 0,
    tokensOut: json.usage?.completion_tokens ?? 0,
  };
}

function safeParse(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
