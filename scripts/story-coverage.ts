// Трассировка «история → сценарии → код»: для каждой US-xx из docs/user-stories.md — сколько приёмочных
// сценариев (acceptance/scenarios, поле story) и какие файлы src/ на неё ссылаются в комментариях.
// Без сети и без запуска бота. Использование:
//   docker compose run --rm test npm run -s stories [-- --missing]   (--missing — только истории без сценариев)

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parse as parseYaml } from "yaml";

const root = join(import.meta.dirname, "..");
const missingOnly = process.argv.includes("--missing");

// Истории: «### US-30. Создать разовое событие» (суффиксы вида «(P2)», «(R1)» остаются в названии)
const stories = [...readFileSync(join(root, "docs/user-stories.md"), "utf8").matchAll(/^### (US-\d+[a-z]?)\. (.+)$/gm)].map((m) => ({
  id: m[1]!,
  title: m[2]!.trim(),
}));

const scenarioDir = join(root, "acceptance/scenarios");
const byStory = new Map<string, number>();
for (const f of readdirSync(scenarioDir).filter((f) => f.endsWith(".yaml"))) {
  for (const s of parseYaml(readFileSync(join(scenarioDir, f), "utf8")) as { story: string }[]) {
    byStory.set(s.story, (byStory.get(s.story) ?? 0) + 1);
  }
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}
const codeRefs = new Map<string, string[]>();
for (const file of walk(join(root, "src")).filter((f) => f.endsWith(".ts"))) {
  // \b после номера: US-10 не должен засчитываться за US-10a и наоборот
  for (const id of new Set(readFileSync(file, "utf8").match(/US-\d+[a-z]?\b/g) ?? [])) {
    codeRefs.set(id, [...(codeRefs.get(id) ?? []), relative(root, file)]);
  }
}

const rows = stories.filter((s) => !missingOnly || !byStory.get(s.id));
for (const s of rows) {
  const n = byStory.get(s.id) ?? 0;
  const code = codeRefs.get(s.id) ?? [];
  console.log(`${n ? " " : "✗"} ${s.id.padEnd(7)} ${String(n).padStart(3)} сцен.  ${s.title}`);
  if (!missingOnly && code.length) console.log(`            код: ${code.join(", ")}`);
}

const known = new Set(stories.map((s) => s.id));
const foreign = [...byStory.keys()].filter((k) => !known.has(k));
const without = stories.filter((s) => !byStory.get(s.id));
console.log(`\nИсторий: ${stories.length}, со сценариями: ${stories.length - without.length}, без: ${without.length} (${without.map((s) => s.id).join(", ")})`);
if (foreign.length) console.log(`story в сценариях, которых нет в user-stories.md: ${foreign.join(", ")}`);
