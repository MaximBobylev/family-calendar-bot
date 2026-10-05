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
  | { expect_no_telegram: true }
  | { google_account: { email: string; calendars: unknown[] } }
  | { oauth: OAuthStep }
  | { oauth_reuse_last_link: { expect_status: number } }
  | { google_revoke: string }
  | { google_touch: { email: string; calendar: string; id: string } }
  | { expect_google_patches: { count?: number; sendUpdates?: string; id?: string } }
  /** Голосовое: распознаётся в transcript; stt_error — Whisper отвечает ошибкой; download_fails — файла нет. */
  | { voice: { from: number; transcript?: string; duration?: number; stt_error?: number; download_fails?: boolean; reply_to_question?: boolean } }
  | { http_get: { path: string; expect_status?: number; text_contains?: string[]; location?: string; basic_auth?: string } }
  | { llm: Record<string, unknown> }
  /** Нажать кнопку с этим текстом в последнем сообщении бота, где она есть. */
  | { press: string | { button: string; from?: number; again?: boolean } }
  /** Ответить (reply) на последний вопрос бота с ForceReply. */
  | { reply: { from: number; text: string } }
  | { expect_callback_answer: { text_contains?: string[]; empty?: boolean } }
  | { expect_google_events: { email: string; calendar: string; events: ExpectedEvent[]; count?: number } }
  /** Подключённый пользователь «одним шагом»: аккаунт Google + /start + согласие; сообщения привязки проверены и пропущены. */
  | { connected_user: { from: number; email: string; calendars: unknown[]; language?: string } };

/**
 * Пользователь нажимает последнюю кнопку «Подключить» и на экране Google соглашается (consent: email)
 * или отказывает (deny: true).
 */
interface OAuthStep {
  consent?: string;
  deny?: boolean;
  expect_status?: number;
}

interface TelegramInput {
  from: number;
  text?: string;
  chat_type?: "private" | "group";
  chat_id?: number;
  language?: string;
  edited?: boolean;
  /** Повторить последний update_id — имитация повторной доставки Telegram. */
  redeliver?: boolean;
  /** message_id сообщения бота, на которое это reply. */
  reply_to?: number;
  voice?: { file_id: string; duration: number };
}

interface ExpectedEvent {
  summary: string;
  /** Момент со смещением («2026-10-08T15:00:00+03:00») или дата для событий на весь день. */
  start: string;
  end: string;
  location?: string;
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
  messageId?: number;
  body: {
    chat_id?: number | string;
    message_id?: number;
    text?: string;
    reply_markup?: { inline_keyboard?: { text: string; url?: string; callback_data?: string }[][]; force_reply?: boolean };
  };
}

async function allTelegramCalls(): Promise<TelegramCall[]> {
  return (await (await fetch(`${FAKES}/__fake/telegram/calls`)).json()) as TelegramCall[];
}

/** URL последней кнопки привязки Google из сообщений бота. */
async function lastConnectUrl(): Promise<string> {
  const urls = (await allTelegramCalls())
    .flatMap((c) => (c.body.reply_markup?.inline_keyboard ?? []).flat())
    .map((b) => b.url)
    .filter((u): u is string => !!u && u.includes("/oauth/google/start"));
  const last = urls.at(-1);
  if (!last) throw new AssertionError("no «connect Google» button was sent");
  // Бот формирует ссылку с PUBLIC_BASE_URL; раннер ходит в SUT по своему адресу
  const u = new URL(last);
  return `${SUT}${u.pathname}${u.search}`;
}

// --- Выполнение --------------------------------------------------------------

/** Служебные вызовы Telegram — не сообщения пользователю; в expect_telegram не учитываются. */
const SERVICE_METHODS = new Set(["answerCallbackQuery", "getFile", "sendChatAction"]);

class AssertionError extends Error {}

async function runScenario(s: Scenario): Promise<void> {
  await post(`${SUT}/__test/reset`, {});
  await post(`${FAKES}/__fake/reset`, {});
  let updateId = 1000;
  let seen = 0; // сколько вызовов Telegram уже проверено

  let lastOAuth: { startUrl: string; callbackUrl: string } | undefined;

  const sendUpdate = async (t: TelegramInput, where = "") => {
    if (!t.redeliver) updateId++;
    const message = {
      message_id: updateId,
      date: 0,
      chat: { id: t.chat_id ?? t.from, type: t.chat_type ?? "private" },
      from: { id: t.from, is_bot: false, first_name: "Test", language_code: t.language ?? "ru" },
      ...(t.text !== undefined ? { text: t.text } : {}),
      ...(t.reply_to ? { reply_to_message: { message_id: t.reply_to } } : {}),
      ...(t.voice ? { voice: { ...t.voice, mime_type: "audio/ogg" } } : {}),
    };
    const update = { update_id: updateId, [t.edited ? "edited_message" : "message"]: message };
    const res = await post(`${SUT}/telegram/webhook`, update, { "x-telegram-bot-api-secret-token": SECRET });
    if (res.status !== 200) throw new AssertionError(`${where}: webhook → ${res.status}`);
    const drain = await post(`${SUT}/__test/drain`, {});
    if (!drain.ok) throw new AssertionError(`${where}: drain → ${drain.status} ${await drain.text()}`);
  };

  // Ответы на нажатия (answerCallbackQuery) проверяются отдельным шагом, в expect_telegram их нет
  const newCalls = async (): Promise<TelegramCall[]> => {
    const all = await allTelegramCalls();
    const fresh = all.slice(seen);
    seen = all.length;
    return fresh.filter((c) => !SERVICE_METHODS.has(c.method));
  };

  let callbackSeq = 0;
  let voiceSeq = 0;
  let lastPress: { from: number; chatId: number; messageId: number; data: string } | undefined;

  const sendCallback = async (p: { from: number; chatId: number; messageId: number; data: string }, where: string) => {
    updateId++;
    const update = {
      update_id: updateId,
      callback_query: {
        id: `cq${++callbackSeq}`,
        from: { id: p.from, is_bot: false, first_name: "Test", language_code: "ru" },
        message: { message_id: p.messageId, date: 0, chat: { id: p.chatId, type: "private" } },
        data: p.data,
      },
    };
    const res = await post(`${SUT}/telegram/webhook`, update, { "x-telegram-bot-api-secret-token": SECRET });
    if (res.status !== 200) throw new AssertionError(`${where}: webhook → ${res.status}`);
    const drain = await post(`${SUT}/__test/drain`, {});
    if (!drain.ok) throw new AssertionError(`${where}: drain → ${drain.status} ${await drain.text()}`);
  };

  // Общая подготовка подключается YAML-якорем как вложенный список шагов
  const steps = (s.steps as unknown[]).flat(Infinity) as Step[];
  for (const [n, step] of steps.entries()) {
    const where = `step ${n + 1}`;
    if ("clock" in step) {
      const res = await post(`${SUT}/__test/clock`, { now: step.clock });
      if (!res.ok) throw new AssertionError(`${where}: clock → ${res.status}`);
    } else if ("telegram" in step) {
      await sendUpdate(step.telegram, where);
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
    } else if ("google_account" in step) {
      await post(`${FAKES}/__fake/google/accounts`, step.google_account);
    } else if ("oauth" in step) {
      const startUrl = await lastConnectUrl();
      const start = await fetch(startUrl, { redirect: "manual" });
      if (start.status !== 302) {
        // Плохая/протухшая ссылка может быть отвергнута уже на старте
        if (step.oauth.expect_status === start.status) continue;
        throw new AssertionError(`${where}: oauth start → ${start.status}, expected 302`);
      }
      const consent = new URL(start.headers.get("location") ?? "");
      const p = consent.searchParams;
      for (const [k, v] of [["access_type", "offline"], ["prompt", "consent"], ["response_type", "code"]] as const) {
        if (p.get(k) !== v) throw new AssertionError(`${where}: consent URL ${k}=${p.get(k)}, expected ${v}`);
      }
      if (!p.get("scope")?.includes("calendar.events")) throw new AssertionError(`${where}: consent URL scope ${p.get("scope")}`);
      const callback = new URL(p.get("redirect_uri") ?? "");
      const query: Record<string, string> = step.oauth.deny
        ? { error: "access_denied", state: p.get("state") ?? "" }
        : { code: `code-${step.oauth.consent}`, state: p.get("state") ?? "" };
      const callbackUrl = `${SUT}${callback.pathname}?${new URLSearchParams(query)}`;
      lastOAuth = { startUrl, callbackUrl };
      const res = await fetch(callbackUrl);
      const expected = step.oauth.expect_status ?? 200;
      if (res.status !== expected) throw new AssertionError(`${where}: oauth callback → ${res.status}, expected ${expected}: ${await res.text()}`);
    } else if ("oauth_reuse_last_link" in step) {
      if (!lastOAuth) throw new AssertionError(`${where}: no previous oauth step`);
      for (const u of [lastOAuth.startUrl, lastOAuth.callbackUrl]) {
        const res = await fetch(u, { redirect: "manual" });
        if (res.status !== step.oauth_reuse_last_link.expect_status) {
          throw new AssertionError(`${where}: reuse ${new URL(u).pathname} → ${res.status}, expected ${step.oauth_reuse_last_link.expect_status}`);
        }
      }
    } else if ("voice" in step) {
      const v = step.voice;
      voiceSeq++;
      const fileId = `voice-${voiceSeq}`;
      const content = `audio-${voiceSeq}`;
      if (!v.download_fails) await post(`${FAKES}/__fake/telegram/files`, { file_id: fileId, content });
      await post(`${FAKES}/__fake/stt/fixtures`, { [content]: v.stt_error ? { error: v.stt_error } : { text: v.transcript ?? "" } });
      let replyTo: number | undefined;
      if (v.reply_to_question) {
        const q = [...(await allTelegramCalls())].reverse().find((c) => c.body.reply_markup?.force_reply && c.messageId);
        if (!q) throw new AssertionError(`${where}: no question with ForceReply`);
        replyTo = q.messageId;
      }
      await sendUpdate({ from: v.from, voice: { file_id: fileId, duration: v.duration ?? 3 }, ...(replyTo ? { reply_to: replyTo } : {}) }, where);
    } else if ("http_get" in step) {
      const h = step.http_get;
      const res = await fetch(`${SUT}${h.path}`, { redirect: "manual", headers: h.basic_auth ? { authorization: `Basic ${btoa(h.basic_auth)}` } : {} });
      if (res.status !== (h.expect_status ?? 200)) throw new AssertionError(`${where}: GET ${h.path} → ${res.status}`);
      if (h.location && !res.headers.get("location")?.endsWith(h.location)) throw new AssertionError(`${where}: location ${res.headers.get("location")}`);
      const body = await res.text();
      for (const part of h.text_contains ?? []) if (!body.includes(part)) throw new AssertionError(`${where}: GET ${h.path} does not contain «${part}»`);
    } else if ("google_touch" in step) {
      await post(`${FAKES}/__fake/google/touch`, step.google_touch);
    } else if ("expect_google_patches" in step) {
      const e = step.expect_google_patches;
      const list = (await (await fetch(`${FAKES}/__fake/google/patches`)).json()) as { id: string; sendUpdates: string | null }[];
      if (e.count !== undefined && list.length !== e.count) throw new AssertionError(`${where}: ${list.length} patches, expected ${e.count}`);
      const last = list.at(-1);
      if (e.id && last?.id !== e.id) throw new AssertionError(`${where}: last patch id ${last?.id}, expected ${e.id}`);
      if (e.sendUpdates && last?.sendUpdates !== e.sendUpdates) throw new AssertionError(`${where}: sendUpdates=${last?.sendUpdates}, expected ${e.sendUpdates}`);
    } else if ("google_revoke" in step) {
      await post(`${FAKES}/__fake/google/revoke`, { email: step.google_revoke });
    } else if ("llm" in step) {
      await post(`${FAKES}/__fake/llm/fixtures`, step.llm);
    } else if ("press" in step) {
      const p = typeof step.press === "string" ? { button: step.press } : step.press;
      if (p.again) {
        if (!lastPress) throw new AssertionError(`${where}: nothing pressed before`);
        await sendCallback(lastPress, where);
        continue;
      }
      const calls = await allTelegramCalls();
      let target: { call: TelegramCall; data: string } | undefined;
      for (const c of [...calls].reverse()) {
        const btn = (c.body.reply_markup?.inline_keyboard ?? []).flat().find((b) => b.text === p.button && b.callback_data);
        if (btn) {
          target = { call: c, data: btn.callback_data! };
          break;
        }
      }
      if (!target) throw new AssertionError(`${where}: no button «${p.button}»`);
      const messageId = target.call.messageId ?? target.call.body.message_id;
      if (!messageId) throw new AssertionError(`${where}: message with «${p.button}» has no id`);
      lastPress = { from: p.from ?? Number(target.call.body.chat_id), chatId: Number(target.call.body.chat_id), messageId, data: target.data };
      await sendCallback(lastPress, where);
    } else if ("reply" in step) {
      const q = [...(await allTelegramCalls())].reverse().find((c) => c.body.reply_markup?.force_reply && c.messageId);
      if (!q) throw new AssertionError(`${where}: no question with ForceReply`);
      await sendUpdate({ from: step.reply.from, text: step.reply.text, reply_to: q.messageId! }, where);
    } else if ("expect_callback_answer" in step) {
      const answers = (await allTelegramCalls()).filter((c) => c.method === "answerCallbackQuery");
      const last = answers.at(-1) as { body: { text?: string } } | undefined;
      if (!last) throw new AssertionError(`${where}: no answerCallbackQuery`);
      const text = last.body.text ?? "";
      if (step.expect_callback_answer.empty && text) throw new AssertionError(`${where}: callback answer «${text}», expected empty`);
      for (const part of step.expect_callback_answer.text_contains ?? []) {
        if (!text.includes(part)) throw new AssertionError(`${where}: callback answer «${text}» does not contain «${part}»`);
      }
    } else if ("expect_google_events" in step) {
      const e = step.expect_google_events;
      const cals = (await (await fetch(`${FAKES}/__fake/google/events?email=${encodeURIComponent(e.email)}`)).json()) as {
        id: string;
        events?: { summary?: string; location?: string; start: { dateTime?: string; date?: string }; end: { dateTime?: string; date?: string } }[];
      }[];
      const events = cals.find((c) => c.id === e.calendar)?.events ?? [];
      if (e.count !== undefined && events.length !== e.count) throw new AssertionError(`${where}: ${events.length} events in ${e.calendar}, expected ${e.count}`);
      const same = (got: { dateTime?: string; date?: string }, want: string) =>
        want.includes("T") ? !!got.dateTime && Date.parse(got.dateTime) === Date.parse(want) : got.date === want;
      for (const want of e.events) {
        const found = events.find((g) => g.summary === want.summary && same(g.start, want.start) && same(g.end, want.end) && (!want.location || g.location === want.location));
        if (!found) throw new AssertionError(`${where}: event ${JSON.stringify(want)} not found in ${e.calendar}: ${JSON.stringify(events.map((g) => [g.summary, g.start, g.end]))}`);
      }
    } else if ("connected_user" in step) {
      const c = step.connected_user;
      await post(`${FAKES}/__fake/google/accounts`, { email: c.email, calendars: c.calendars });
      await sendUpdate({ from: c.from, text: "/start", ...(c.language ? { language: c.language } : {}) });
      const startUrl = await lastConnectUrl();
      const start = await fetch(startUrl, { redirect: "manual" });
      const consent = new URL(start.headers.get("location") ?? "");
      const callback = new URL(consent.searchParams.get("redirect_uri") ?? "");
      const res = await fetch(`${SUT}${callback.pathname}?${new URLSearchParams({ code: `code-${c.email}`, state: consent.searchParams.get("state") ?? "" })}`);
      if (res.status !== 200) throw new AssertionError(`${where}: connect ${c.email} → ${res.status}`);
      await newCalls(); // приветствие и «календарь подключён» — проверены отдельными сценариями
    } else if ("expect_no_telegram" in step) {
      const calls = await newCalls();
      if (calls.length) throw new AssertionError(`${where}: expected no Telegram calls, got ${JSON.stringify(calls.map((c) => [c.method, c.body.text]))}`);
    }
  }
}

function checkCall(where: string, call: TelegramCall, exp: TelegramExpectation) {
  const method = exp.method ?? "sendMessage";
  if (call.method !== method) throw new AssertionError(`${where}: method ${call.method}, expected ${method}`);
  // Telegram принимает chat_id и числом, и строкой — сравниваем как строки
  if (exp.chat_id !== undefined && String(call.body.chat_id) !== String(exp.chat_id)) {
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
