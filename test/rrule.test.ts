// Повторения: даты, RRULE, описание (testdata/dates/rrule.yaml).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { formatDate, parseLocal } from "../src/dates/calendar";
import { describeRecurrence, occurrences, toRRule } from "../src/dates/rrule";
import type { Recurrence } from "../src/dates/types";

interface Doc {
  defaults: { from: string; time: string; tz: string };
  cases: { rule: Recurrence; next: string[]; rrule: string; text: string }[];
}
const doc = parseYaml(readFileSync(join(import.meta.dirname, "..", "testdata", "recurrence", "rrule.yaml"), "utf8")) as Doc;
const from = parseLocal(`${doc.defaults.from}T00:00`).day;
const [h, m] = doc.defaults.time.split(":").map(Number);

describe.each(doc.cases.map((c) => [c.rrule, c] as const))("%s", (_name, c) => {
  const days = occurrences(c.rule, from, 3);
  it("next dates", () => expect(days.map(formatDate)).toEqual(c.next));
  it("rrule", () => expect(toRRule(c.rule, { day: days[0]!, minutes: h! * 60 + m! }, doc.defaults.tz, false)).toBe(c.rrule));
  it("text", () => expect(describeRecurrence(c.rule, days[0]!, "ru")).toBe(c.text));
});
