// Загрузка золотого корпуса дат (testdata/dates) — общая для теста и отчёта.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ParseInput, ParseResult, ValueKind } from "../../src/dates";

export const CORPUS_DIR = join(import.meta.dirname, "..", "..", "testdata", "dates");

export interface CorpusCase {
  file: string;
  id: string;
  input: ParseInput;
  status?: "proposed";
  note?: string;
  expect: ParseResult;
}

interface RawFile {
  defaults?: { now?: string; tz?: string; kind?: ValueKind };
  cases: { id: string; text: string; kind?: ValueKind; now?: string; tz?: string; status?: "proposed"; note?: string; expect: ParseResult }[];
}

export function loadCorpus(): CorpusCase[] {
  return readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .flatMap((file) => {
      const doc = parseYaml(readFileSync(join(CORPUS_DIR, file), "utf8")) as RawFile;
      return doc.cases.map((c) => ({
        file,
        id: c.id,
        ...(c.status ? { status: c.status } : {}),
        ...(c.note ? { note: c.note } : {}),
        expect: c.expect,
        input: {
          text: c.text,
          kind: c.kind ?? doc.defaults?.kind ?? "point",
          now: c.now ?? doc.defaults?.now ?? "",
          tz: c.tz ?? doc.defaults?.tz ?? "UTC",
        },
      }));
    });
}

/** Канонический JSON: ключи по алфавиту, чтобы порядок полей в YAML не влиял на сравнение. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}
