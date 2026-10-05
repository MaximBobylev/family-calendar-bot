// Извлечение дат из сообщения (testdata/extract/cases.yaml) + очистка названия и «весь день».

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { cleanTitle, extractDateSpans, extractModifySpans, extractRecurrenceSpan, looksAllDay } from "../src/dates/extract";

interface Doc {
  defaults: { now: string; tz: string };
  cases: { kind: "point" | "range"; text: string; expect: { point?: string; range?: string; duration?: string } }[];
}
const doc = parseYaml(readFileSync(join(import.meta.dirname, "..", "testdata", "extract", "cases.yaml"), "utf8")) as Doc;

describe("extractDateSpans", () => {
  it.each(doc.cases.map((c) => [c.text, c] as const))("%s", (_t, c) => {
    const { usedWords: _u, ...got } = extractDateSpans(c.text, doc.defaults.now, doc.defaults.tz, c.kind);
    expect(got).toEqual(c.expect);
  });
});

describe("cleanTitle", () => {
  it("drops generic titles and date words", () => {
    expect(cleanTitle("Встреча", [])).toBeUndefined();
    expect(cleanTitle("встречу", [])).toBeUndefined();
    expect(cleanTitle("Созвон с Петей завтра в 15:30", ["завтра в 15:30"])).toBe("Созвон с Петей");
    expect(cleanTitle("день рождения мамы", [])).toBe("День рождения мамы");
  });
});

describe("looksAllDay", () => {
  it.each([["Завтра день рождения мамы", true], ["Отпуск с 10 по 20 ноября", true], ["Созвон завтра", false]] as const)("%s", (t, v) => {
    expect(looksAllDay(t)).toBe(v);
  });
});

interface ModifyDoc {
  defaults: { now: string; tz: string };
  cases: { text: string; expect: Record<string, string> }[];
}
const modifyDoc = parseYaml(readFileSync(join(import.meta.dirname, "..", "testdata", "extract", "modify.yaml"), "utf8")) as ModifyDoc;

describe("extractModifySpans", () => {
  it.each(modifyDoc.cases.map((c) => [c.text, c] as const))("%s", (_t, c) => {
    expect(extractModifySpans(c.text, modifyDoc.defaults.now, modifyDoc.defaults.tz)).toEqual(c.expect);
  });
});

describe("extractRecurrenceSpan", () => {
  interface RDoc { defaults: { now: string; tz: string }; cases: { text: string; span: string | null; rest?: string }[] }
  const rdoc = parseYaml(readFileSync(join(import.meta.dirname, "..", "testdata", "extract", "recurrence.yaml"), "utf8")) as RDoc;
  it.each(rdoc.cases.map((c) => [c.text, c] as const))("%s", (_t, c) => {
    const got = extractRecurrenceSpan(c.text, rdoc.defaults.now, rdoc.defaults.tz);
    if (c.span === null) expect(got).toBeUndefined();
    else expect(got).toEqual({ span: c.span, rest: c.rest });
  });
});
