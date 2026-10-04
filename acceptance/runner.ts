// Раннер приёмочных сценариев (ADR-0006). Работает с ботом только по HTTP — как с чёрным ящиком,
// поэтому те же сценарии пригодны для любой реализации (TypeScript сейчас, Go потом).
//
// Окружение: SUT_URL (бот), FAKES_URL (фейки), WEBHOOK_SECRET.
// Запуск: docker compose run --rm acceptance [-- фильтр-по-id]

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const SUT = process.env.SUT_URL ?? "http://localhost:8787";
const FAKES = process.env.FAKES_URL ?? "http://localhost:9100";
const SECRET = process.env.WEBHOOK_SECRET ?? "test-secret";
const filter = process.argv[2];

// --- Формат сценария ---------------------------------------------------------

type Step =
  | { clock: string }
  | { telegram: TelegramInput }
  | { webhook_raw: { body: unknown; secret?: string | null; expect_status: number } }
  | { expect_telegram: TelegramExpectation[] }
  | { expect_no_telegram: true };

interface TelegramInput {
  from: number;
  text?: string;
  chat_type?: "private" | "group";
  chat_id?: number;
  language?: string;
  edited?: boolean;
  /** Повторить последний update_id — имитация повторной доставки Telegram. */
  redeliver?: boolean;
}

interface TelegramExpectation {
  method?: string;
  chat_id?: number;
  text_contains?: string[];
  text_not_contains?: string[];
  buttons?: string[];
}

interface Scenario {
  id: string;
  story: string;
  title?: string;
  steps: Step[];
}

// --- HTTP --------------------------------------------------------------------

async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

interface TelegramCall {
  method: string;
  body: { chat_id?: number; text?: string; reply_markup?: { inline_keyboard?: { text: string }[][] } };
}

// --- Выполнение --------------------------------------------------------------

class AssertionError extends Error {}

async function runScenario(s: Scenario): Promise<void> {
  await post(`${SUT}/__test/reset`, {});
  await post(`${FAKES}/__fake/reset`, {});
  let updateId = 1000;
  let seen = 0; // сколько вызовов Telegram уже проверено

  const newCalls = async (): Promise<TelegramCall[]> => {
    const all = (await (await fetch(`${FAKES}/__fake/telegram/calls`)).json()) as TelegramCall[];
    const fresh = all.slice(seen);
    seen = all.length;
    return fresh;
  };

  for (const [n, step] of s.steps.entries()) {
    const where = `step ${n + 1}`;
    if ("clock" in step) {
      const res = await post(`${SUT}/__test/clock`, { now: step.clock });
      if (!res.ok) throw new AssertionError(`${where}: clock → ${res.status}`);
    } else if ("telegram" in step) {
      const t = step.telegram;
      if (!t.redeliver) updateId++;
      const message = {
        message_id: updateId,
        date: 0,
        chat: { id: t.chat_id ?? t.from, type: t.chat_type ?? "private" },
        from: { id: t.from, is_bot: false, first_name: "Test", language_code: t.language ?? "ru" },
        ...(t.text !== undefined ? { text: t.text } : {}),
      };
      const update = { update_id: updateId, [t.edited ? "edited_message" : "message"]: message };
      const res = await post(`${SUT}/telegram/webhook`, update, { "x-telegram-bot-api-secret-token": SECRET });
      if (res.status !== 200) throw new AssertionError(`${where}: webhook → ${res.status}`);
      const drain = await post(`${SUT}/__test/drain`, {});
      if (!drain.ok) throw new AssertionError(`${where}: drain → ${drain.status} ${await drain.text()}`);
    } else if ("webhook_raw" in step) {
      const w = step.webhook_raw;
      const headers: Record<string, string> = w.secret === null ? {} : { "x-telegram-bot-api-secret-token": w.secret ?? SECRET };
      const res = await post(`${SUT}/telegram/webhook`, w.body, headers);
      if (res.status !== w.expect_status) throw new AssertionError(`${where}: webhook status ${res.status}, expected ${w.expect_status}`);
    } else if ("expect_telegram" in step) {
      const calls = await newCalls();
      if (calls.length !== step.expect_telegram.length) {
        throw new AssertionError(`${where}: expected ${step.expect_telegram.length} Telegram call(s), got ${calls.length}: ${JSON.stringify(calls.map((c) => [c.method, c.body.text]))}`);
      }
      step.expect_telegram.forEach((exp, k) => checkCall(`${where}.${k + 1}`, calls[k]!, exp));
    } else if ("expect_no_telegram" in step) {
      const calls = await newCalls();
      if (calls.length) throw new AssertionError(`${where}: expected no Telegram calls, got ${JSON.stringify(calls.map((c) => [c.method, c.body.text]))}`);
    }
  }
}

function checkCall(where: string, call: TelegramCall, exp: TelegramExpectation) {
  const method = exp.method ?? "sendMessage";
  if (call.method !== method) throw new AssertionError(`${where}: method ${call.method}, expected ${method}`);
  if (exp.chat_id !== undefined && call.body.chat_id !== exp.chat_id) {
    throw new AssertionError(`${where}: chat_id ${call.body.chat_id}, expected ${exp.chat_id}`);
  }
  const text = call.body.text ?? "";
  for (const part of exp.text_contains ?? []) {
    if (!text.toLowerCase().includes(part.toLowerCase())) throw new AssertionError(`${where}: text does not contain «${part}»:\n${text}`);
  }
  for (const part of exp.text_not_contains ?? []) {
    if (text.toLowerCase().includes(part.toLowerCase())) throw new AssertionError(`${where}: text unexpectedly contains «${part}»`);
  }
  if (exp.buttons) {
    const got = (call.body.reply_markup?.inline_keyboard ?? []).flat().map((b) => b.text);
    if (JSON.stringify(got) !== JSON.stringify(exp.buttons)) throw new AssertionError(`${where}: buttons ${JSON.stringify(got)}, expected ${JSON.stringify(exp.buttons)}`);
  }
}

// --- Main ----------------------------------------------------------------------

const dir = join(import.meta.dirname, "scenarios");
const scenarios = readdirSync(dir)
  .filter((f) => f.endsWith(".yaml"))
  .sort()
  .flatMap((f) => parseYaml(readFileSync(join(dir, f), "utf8")) as Scenario[])
  .filter((s) => !filter || s.id.includes(filter));

let failed = 0;
for (const s of scenarios) {
  try {
    await runScenario(s);
    console.log(`  ✓ ${s.id}  (${s.story})`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${s.id}  (${s.story})\n      ${String(e instanceof Error ? e.message : e).replaceAll("\n", "\n      ")}`);
  }
}
console.log(`\n${scenarios.length - failed} / ${scenarios.length} scenarios passed`);
process.exitCode = failed ? 1 : 0;
