// Золотой корпус дат (ADR-0006, набор 1): каждый кейс — отдельный тест.

import { describe, expect, it } from "vitest";
import { parseDateFragment } from "../src/dates";
import { canonical, loadCorpus } from "./support/date-corpus";

const corpus = loadCorpus();

describe.each([...new Set(corpus.map((c) => c.file))])("%s", (file) => {
  it.each(corpus.filter((c) => c.file === file).map((c) => [`${c.id} «${c.input.text}»`, c] as const))("%s", (_name, c) => {
    expect(canonical(parseDateFragment(c.input))).toBe(canonical(c.expect));
  });
});
