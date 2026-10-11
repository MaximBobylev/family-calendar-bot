import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { splitMessage } from "../src/bot/multi-split";

interface Expected {
  point?: string;
  recurrence?: string;
  title?: string;
  action?: "create" | "other";
  undated?: boolean;
  borrow?: number;
}
interface Doc {
  defaults: { now: string; tz: string };
  cases: { text: string; foreign?: boolean; expect: Expected[] }[];
}
const doc = parseYaml(readFileSync(join(import.meta.dirname, "..", "testdata", "split", "cases.yaml"), "utf8")) as Doc;

describe("splitMessage — корпус testdata/split", () => {
  it.each(doc.cases.map((c) => [c.text, c] as const))("%s", (_t, c) => {
    const pieces = splitMessage(c.text, doc.defaults.now, doc.defaults.tz, { foreign: c.foreign });
    const got = pieces.map((p, i) => {
      const e = c.expect[i] ?? {};
      return {
        ...(e.point !== undefined ? { point: p.point } : {}),
        ...(e.recurrence !== undefined ? { recurrence: p.recurrence } : {}),
        ...(e.title !== undefined ? { title: p.title } : {}),
        ...(e.action !== undefined ? { action: p.action } : {}),
        ...(e.undated !== undefined ? { undated: !!p.undated } : {}),
        ...(e.borrow !== undefined ? { borrow: p.borrowFrom } : {}),
      };
    });
    expect(got).toEqual(c.expect);
  });
});

interface NluDoc {
  defaults: { now: string; tz: string };
  cases: { id: string; cat: string; text: string }[];
}
const nlu = parseYaml(readFileSync(join(import.meta.dirname, "..", "testdata", "nlu", "intents.yaml"), "utf8")) as NluDoc;

// Ложное деление ломает обычные сообщения: весь набор разбора интентов, кроме фраз про несколько дел, — одно создание
describe("splitMessage — набор testdata/nlu/intents.yaml не делится", () => {
  const single = nlu.cases.filter((c) => c.cat !== "multi_create" && c.cat !== "multiple");
  it.each(single.map((c) => [c.id, c.text] as const))("%s %s", (_id, text) => {
    const creates = splitMessage(text, nlu.defaults.now, nlu.defaults.tz).filter((p) => p.action === "create");
    expect(creates.length).toBeLessThanOrEqual(1);
  });
});
