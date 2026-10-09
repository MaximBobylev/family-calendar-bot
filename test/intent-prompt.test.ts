import { afterEach, describe, expect, it, vi } from "vitest";
import { parseIntent, SYSTEM_PROMPT, SYSTEM_PROMPT_NO_WHEN, TOOLS, TOOLS_NO_WHEN } from "../src/nlu/intents";
import type { LlmConfig, ToolDefinition } from "../src/nlu/llm";

const createProps = (tools: ToolDefinition[]) =>
  (tools.find((t) => t.function.name === "create_event")!.function.parameters as { properties: Record<string, unknown> }).properties;

describe("промпт без структуры даты (tech-debt #27а)", () => {
  it("тот же промпт без раздела `when`", () => {
    expect(SYSTEM_PROMPT).toContain("DATE STRUCTURE");
    expect(SYSTEM_PROMPT_NO_WHEN).not.toContain("DATE STRUCTURE");
    // `"when"` у assign_task в примерах — его собственное поле (строка), не структура
    expect(SYSTEM_PROMPT_NO_WHEN).not.toContain('"when":{');
    expect(SYSTEM_PROMPT.startsWith(SYSTEM_PROMPT_NO_WHEN.split("Examples:")[0]!)).toBe(true);
    expect(SYSTEM_PROMPT.endsWith(SYSTEM_PROMPT_NO_WHEN.slice(SYSTEM_PROMPT_NO_WHEN.indexOf("Examples:")))).toBe(true);
    expect(SYSTEM_PROMPT_NO_WHEN.length).toBeLessThan(SYSTEM_PROMPT.length / 2);
  });

  it("create_event без поля `when`, остальные инструменты — те же", () => {
    expect(createProps(TOOLS)).toHaveProperty("when");
    expect(createProps(TOOLS_NO_WHEN)).not.toHaveProperty("when");
    expect(Object.keys(createProps(TOOLS_NO_WHEN))).toEqual(Object.keys(createProps(TOOLS)).filter((k) => k !== "when"));
    expect(TOOLS_NO_WHEN.filter((t) => t.function.name !== "create_event")).toEqual(TOOLS.filter((t) => t.function.name !== "create_event"));
  });

  describe("parseIntent выбирает вариант по звену цепочки", () => {
    afterEach(() => vi.unstubAllGlobals());
    const sent = async (cfg: LlmConfig) => {
      let body: { messages: { content: string }[]; tools: ToolDefinition[] } | undefined;
      vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
        body = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [] } }] }), { status: 200 });
      });
      await parseIntent(cfg, "завтра в 15 стоматолог", { calendars: ["Иван"] });
      return body!;
    };
    const link: LlmConfig = { name: "x", baseUrl: "http://llm", apiKey: "k", model: "m" };

    it("по умолчанию — со структурой", async () => {
      const b = await sent(link);
      expect(b.messages[0]!.content).toContain("DATE STRUCTURE");
      expect(createProps(b.tools)).toHaveProperty("when");
    });

    it("dateStructure: false — без неё", async () => {
      const b = await sent({ ...link, dateStructure: false });
      expect(b.messages[0]!.content).not.toContain("DATE STRUCTURE");
      expect(b.messages[0]!.content).toContain('User\'s calendars: "Иван".');
      expect(createProps(b.tools)).not.toHaveProperty("when");
    });
  });
});
