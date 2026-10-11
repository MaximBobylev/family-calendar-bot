import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { aliasForm, parseSettingsCommand } from "../src/nlu/settings-command";

const set = parseYaml(readFileSync(join(import.meta.dirname, "..", "testdata", "nlu", "settings.yaml"), "utf8")) as {
  cases: { text: string; cmd: Record<string, unknown> | null }[];
};

describe("parseSettingsCommand (US-04, US-06)", () => {
  it.each(set.cases.map((c) => [c.text, c] as const))("%s", (_t, c) => {
    expect(parseSettingsCommand(c.text)).toEqual(c.cmd);
  });
});

describe("aliasForm", () => {
  it.each([
    ["семейным", "семейный"],
    ["общим", "общий"],
    ["рабочим", "рабочий"],
    ["Максим", "Максим"],
    ["family", "family"],
  ])("%s → %s", (a, b) => expect(aliasForm(a)).toBe(b));
});
