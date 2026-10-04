// Отчёт по золотому корпусу дат: сводка по файлам и список расхождений.
// Использование: npm run corpus:dates [-- --failures]

import { parseDateFragment } from "../src/dates";
import { canonical, loadCorpus } from "../test/support/date-corpus";

const showFailures = process.argv.includes("--failures");
const byFile = new Map<string, { passed: number; total: number }>();
const failures: string[] = [];

for (const c of loadCorpus()) {
  const stat = byFile.get(c.file) ?? { passed: 0, total: 0 };
  byFile.set(c.file, stat);
  stat.total++;
  const got = parseDateFragment(c.input);
  if (canonical(got) === canonical(c.expect)) stat.passed++;
  else
    failures.push(
      `${c.id}${c.status ? ` [${c.status}]` : ""}  «${c.input.text}» (${c.input.kind}, now ${c.input.now})\n` +
        `    expected: ${canonical(c.expect)}\n    got:      ${canonical(got)}`,
    );
}

let passed = 0;
let total = 0;
console.log("file                        pass / total");
for (const [file, s] of byFile) {
  console.log(`${file.padEnd(28)}${String(s.passed).padStart(4)} / ${s.total}`);
  passed += s.passed;
  total += s.total;
}
console.log(`\nTOTAL ${passed} / ${total} (${((passed / total) * 100).toFixed(1)}%)`);
if (showFailures && failures.length) console.log(`\nFAILURES\n\n${failures.join("\n\n")}`);
process.exitCode = failures.length ? 1 : 0;
