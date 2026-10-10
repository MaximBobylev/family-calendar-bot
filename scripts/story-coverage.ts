// US-xx из docs/user-stories.md → число приёмочных сценариев и файлы кода по docs/architecture-map.md (не по комментариям:
// ссылка на историю в коде права на существование не даёт).
//   docker compose run --rm test npm run -s stories [-- --missing]   (--missing — только истории без сценариев)

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const root = join(import.meta.dirname, "..");
const missingOnly = process.argv.includes("--missing");

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

/** «US-65/66/67», «US-65–67», «US-10a» → отдельные id. */
function storyIds(line: string): string[] {
  const ids: string[] = [];
  for (const m of line.matchAll(/US-(\d+)([a-z]?)((?:\/\d+[a-z]?)*)(?:[–-](\d+))?/g)) {
    ids.push(`US-${m[1]}${m[2]}`);
    for (const n of (m[3] ?? "").split("/").filter(Boolean)) ids.push(`US-${n}`);
    if (m[4]) for (let k = Number(m[1]) + 1; k <= Number(m[4]); k++) ids.push(`US-${String(k).padStart(2, "0")}`);
  }
  return ids;
}
const codeRefs = new Map<string, string[]>();
for (const line of readFileSync(join(root, "docs/architecture-map.md"), "utf8").split("\n")) {
  const ids = storyIds(line);
  if (!ids.length) continue;
  const paths = [
    ...line.matchAll(/(?<![\w/])`?((?:src\/)?(?:bot|db|dates|nlu|sync|jobs|ops|calendar|google|admin|voice|vision|stt|ics|telegram|net)\/[\w./{},*-]+)/g),
  ].map((m) => (m[1]!.startsWith("src/") ? m[1]! : `src/${m[1]}`).replace(/[.,]+$/, ""));
  for (const id of ids) codeRefs.set(id, [...new Set([...(codeRefs.get(id) ?? []), ...paths])]);
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
