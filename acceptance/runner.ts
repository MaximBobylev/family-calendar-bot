// Раннер приёмочных сценариев (ADR-0006). Работает с ботом только по HTTP — как с чёрным ящиком,
// поэтому те же сценарии пригодны для любой реализации (TypeScript сейчас, Go потом).
//
// Окружение: SUT_URL (бот), FAKES_URL (фейки), WEBHOOK_SECRET.
// Запуск: docker compose run --rm acceptance                       — все сценарии
//         docker compose run --rm -e SCENARIO=undo,US-61 acceptance — выборочно (или аргументами:
//         docker compose run --rm acceptance npx tsx acceptance/runner.ts undo US-61)
//         … --list (или SCENARIO_LIST=1) — только список id / story / файл, без запуска
// Фильтр — через запятую или пробел; сценарий выбран, если подходит хоть одно слово: US-xx — по story,
// «10-undo» / «10-undo.yaml» — по файлу, иначе — подстрока id. Фильтр ничего не выбрал — ошибка.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const SUT = process.env.SUT_URL ?? "http://localhost:8787";
const FAKES = process.env.FAKES_URL ?? "http://localhost:9100";
const SECRET = process.env.WEBHOOK_SECRET ?? "test-secret";
/** Имя бота (TELEGRAM_BOT_USERNAME стенда) — для ответов боту в группе (US-94). */
const BOT_USERNAME = process.env.BOT_USERNAME ?? "cab_test_bot";
const cliArgs = process.argv.slice(2);
const listOnly = cliArgs.includes("--list") || !!process.env.SCENARIO_LIST;
const filters = [...cliArgs.filter((a) => a !== "--list"), process.env.SCENARIO ?? ""].flatMap((a) => a.split(/[\s,]+/)).filter(Boolean);

// --- Формат сценария ---------------------------------------------------------

type Step =
  | { clock: string }
  /** Проход планировщика (cron раз в минуту): наступившие задачи выполняются сразу. */
  | { tick: true }
  /** Часовые работы cron: ретеншн, страховка дайджестов. */
  | { hourly: true }
  /** Оценка правил алертов владельцу (в cron — раз в 5 минут); expect_sent — какие переходы отправлены: ["jobs:fire"]. */
  | { alerts: true | { expect_sent: string[] } }
  | { telegram: TelegramInput }
  | { webhook_raw: { body: unknown; secret?: string | null; expect_status: number } }
  | { expect_telegram: TelegramExpectation[] }
  | { expect_no_telegram: true }
  /** Сколько сообщений бот отправил с прошлой проверки (без проверки содержимого) — для длинных серий. */
  | { expect_telegram_count: number }
  /** Повторить шаги N раз (лимиты, серии запросов). */
  | { repeat: { times: number; steps: Step[] } }
  /** Сколько всего запросов получила LLM с начала сценария. */
  /** Запросы к основному LLM (запасной считается отдельно — expect_provider_calls). */
  | { expect_llm_requests: number }
  /** Провайдер отвечает ошибкой (0 — снова работает): llm | llm-backup | stt | stt-openai. */
  | { provider_outage: { provider: string; status: number } }
  /** Сколько раз вызывался каждый провайдер с последнего сброса: {llm: 1, llm-backup: 1, stt-openai: 1, stt: 0}. */
  | { expect_provider_calls: Record<string, number> }
  | { google_account: { email: string; calendars: unknown[] } }
  | { oauth: OAuthStep }
  | { oauth_reuse_last_link: { expect_status: number } }
  /** Открыть callback, придержанный шагом oauth с hold_callback (по email согласия), в браузере browser. */
  | { oauth_callback: { of: string; browser?: string; without_bind_cookie?: boolean; expect_status: number; page_contains?: string[] } }
  | { google_revoke: string }
  /** Выданные аккаунту access token Google перестают приниматься (401) — как истёкший раньше срока или отозванный. */
  | { google_expire_access: string }
  /** Сколько раз бот обновлял access token (POST /token, grant_type=refresh_token) с начала сценария. */
  | { expect_token_refreshes: number }
  /** Ближайшие times (1) вызовов Telegram method (sendMessage) с этим текстом отвечают ошибкой status (500). */
  | { telegram_fails: { text_contains: string; method?: string; status?: number; times?: number } }
  /** Ретрай очереди: повторить упавшие апдейты (tech-debt #5); expect_failure — снова упадёт. */
  | { queue_retry: true | { expect_failure?: boolean } }
  /** Отзывы токена ботом (US-03): сколько было и какой токен отозван последним. */
  | { expect_token_revocations: { count: number; last?: string } }
  /** Эндпоинт отзыва токена у Google отвечает ошибкой. */
  | { token_revoke_fails: number }
  | { google_touch: { email: string; calendar: string; id: string } }
  | { expect_google_patches: { count?: number; sendUpdates?: string; id?: string } }
  | { expect_google_deletes: { count?: number; sendUpdates?: string; id?: string } }
  /** Голосовое: распознаётся в transcript; stt_error — Whisper отвечает ошибкой; download_fails — файла нет. */
  /**
   * Голосовое: Whisper распознаёт его в transcript; heard — что услышит мультимодальная модель, если бот решит
   * переслушать (эскалация): {transcript, tool, args} | {no_speech: true} | {error: status}.
   */
  | {
      voice: {
        from: number;
        transcript?: string;
        duration?: number;
        stt_error?: number;
        download_fails?: boolean;
        reply_to_question?: boolean;
        /** Пересланное голосовое (forward_origin) — не команда пользователя (US-10). */
        forwarded?: boolean;
        /** Обработка апдейта падает (ждём ретрай очереди — шаг queue_retry). */
        expect_failure?: boolean;
        heard?: { transcript?: string; tool?: string; args?: Record<string, unknown>; no_speech?: boolean; error?: number };
      };
    }
  /** Сколько раз бот переслушивал голосовые мультимодальной моделью. */
  | { expect_voice_rehearings: number }
  /**
   * HTTP-запрос к SUT. В path, значениях form и text_(not_)contains подставляются {{имя}} из capture предыдущих шагов;
   * capture: { имя: регэксп с одной группой } — запомнить кусок ответа (например, id из ссылки).
   */
  | { http_get: HttpCheck }
  /** POST формы (application/x-www-form-urlencoded) — действия на страницах (админка). */
  | { http_post: HttpCheck & { form?: Record<string, string> } }
  | { llm: Record<string, unknown> }
  /** Нажать кнопку с этим текстом в последнем сообщении бота, где она есть. */
  | {
      press:
        | string
        | { button: string; from?: number; again?: boolean /** Только сообщение в этом чате (US-91: у каждого своё предложение). */; chat?: number };
    }
  /** Ответить (reply) на последний вопрос бота с ForceReply. */
  | { reply: { from: number; text: string } }
  | { expect_callback_answer: { text_contains?: string[]; empty?: boolean } }
  | { expect_google_events: { email: string; calendar: string; events: ExpectedEvent[]; count?: number } }
  /** Подключённый пользователь «одним шагом»: аккаунт Google + /start + согласие; сообщения привязки проверены и пропущены. */
  | { connected_user: { from: number; email: string; calendars: unknown[]; language?: string } }
  /**
   * Запомнить кусок последнего сообщения бота, где регэксп нашёлся (одна группа): {invite: "start=home_(\\S+)"}.
   * Подставляется как {{имя}} в text шага telegram (US-90: код приглашения).
   */
  | { capture_telegram: Record<string, string> };

/**
 * Пользователь нажимает последнюю кнопку «Подключить» и на экране Google соглашается (consent: email)
 * или отказывает (deny: true).
 */
interface OAuthStep {
  consent?: string;
  deny?: boolean;
  expect_status?: number;
  /** Страница перед экраном согласия (tech-debt #1): «подключаете к Telegram-аккаунту …». */
  page_contains?: string[];
  /** Отправить форму страницы без её cookie — как чужой сайт (CSRF). */
  without_cookie?: boolean;
  /** Кнопка «Подключить» из последнего сообщения этому чату (по умолчанию — последняя вообще). */
  from?: number;
  /** Именованный браузер со своими cookie (по умолчанию — один на сценарий). */
  browser?: string;
  /** Callback без cookie oauth_bind — как будто его открыли в другом браузере (login CSRF, A4). */
  callback_without_bind_cookie?: boolean;
  /** Ответ callback содержит эти строки. */
  callback_contains?: string[];
  /** Согласиться у Google, но callback не открывать: code+state «уносит» злоумышленник (шаг oauth_callback). */
  hold_callback?: boolean;
  /** Google получил другой code_challenge — verifier бота не подойдёт, обмен кода отвергается (PKCE, A5). */
  tamper_challenge?: boolean;
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
  first_name?: string;
  username?: string;
  /** Пересланное сообщение (forward_origin от другого пользователя) — не команда (US-10). */
  forwarded?: boolean;
  /** Обработка апдейта падает (ждём ретрай очереди — шаг queue_retry). */
  expect_failure?: boolean;
  /** Ответ (reply) на последнее сообщение бота в этом чате — обращение к боту в группе (US-94). */
  reply_to_bot?: boolean;
}

interface ExpectedEvent {
  summary: string;
  /** Момент со смещением («2026-10-08T15:00:00+03:00») или дата для событий на весь день. */
  start: string;
  end: string;
  /** "" — места нет. */
  location?: string;
  /** "" — описания нет. */
  description?: string;
  /** Правила повторения как в Google: ["RRULE:FREQ=WEEKLY;BYDAY=MO"]. */
  recurrence?: string[];
  /** Напоминания как в Google: { useDefault: false, overrides: [{ method: popup, minutes: 60 }] }; null — поля нет. */
  reminders?: unknown;
}

interface TelegramExpectation {
  method?: string;
  chat_id?: number;
  text_contains?: string[];
  text_not_contains?: string[];
  buttons?: string[];
}

interface HttpCheck {
  path: string;
  expect_status?: number;
  text_contains?: string[];
  text_not_contains?: string[];
  location?: string;
  basic_auth?: string;
  capture?: Record<string, string>;
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

/** Последнее сообщение бота в чате — как reply_to_message «ответа боту» (с автором-ботом). */
async function lastBotMessageIn(chatId: number): Promise<{ message_id: number; from: unknown }> {
  const last = (await allTelegramCalls()).filter((c) => c.method === "sendMessage" && String(c.body.chat_id) === String(chatId) && c.messageId).at(-1);
  if (!last) throw new AssertionError(`no bot message in chat ${chatId} to reply to`);
  return { message_id: last.messageId!, from: { id: 1, is_bot: true, first_name: "Bot", username: BOT_USERNAME } };
}

/** URL последней кнопки привязки Google из сообщений бота (from — только в этот чат). */
async function lastConnectUrl(from?: number): Promise<string> {
  const urls = (await allTelegramCalls())
    .filter((c) => from === undefined || String(c.body.chat_id) === String(from))
    .flatMap((c) => (c.body.reply_markup?.inline_keyboard ?? []).flat())
    .map((b) => b.url)
    .filter((u): u is string => !!u && u.includes("/oauth/google/start"));
  const last = urls.at(-1);
  if (!last) throw new AssertionError("no «connect Google» button was sent");
  // Бот формирует ссылку с PUBLIC_BASE_URL; раннер ходит в SUT по своему адресу
  const u = new URL(last);
  return `${SUT}${u.pathname}${u.search}`;
}

/** Cookie браузера для бота: имя+путь → значение. Срок (Max-Age) не отслеживается, кроме удаления (Max-Age=0). */
class CookieJar {
  private items = new Map<string, { name: string; value: string; path: string }>();

  store(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const [pair = "", ...attrs] = line.split(";").map((x) => x.trim());
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq);
      const opts = Object.fromEntries(attrs.map((a) => [a.split("=")[0]!.toLowerCase(), a.split("=").slice(1).join("=")]));
      const path = opts.path || "/";
      const key = `${name} ${path}`;
      if (opts["max-age"] !== undefined && Number(opts["max-age"]) <= 0) this.items.delete(key);
      else this.items.set(key, { name, value: pair.slice(eq + 1), path });
    }
  }

  header(url: string): string {
    const path = new URL(url).pathname;
    return [...this.items.values()]
      .filter((c) => path === c.path || path.startsWith(c.path.endsWith("/") ? c.path : `${c.path}/`))
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  }

  has(name: string): boolean {
    return [...this.items.values()].some((c) => c.name === name);
  }
}

/** Запрос «из браузера»: его cookie уходят с запросом (кроме withoutCookies), Set-Cookie из ответа запоминаются. */
async function browse(jar: CookieJar, url: string, init: RequestInit & { withoutCookies?: boolean } = {}): Promise<Response> {
  const { withoutCookies, ...rest } = init;
  const cookie = withoutCookies ? "" : jar.header(url);
  const res = await fetch(url, { redirect: "manual", ...rest, headers: { ...(rest.headers as Record<string, string>), ...(cookie ? { cookie } : {}) } });
  jar.store(res);
  return res;
}

/**
 * Экран согласия Google (фейк): согласие выдаёт код, привязанный к code_challenge из ссылки (tamper — к чужому);
 * отказ — error=access_denied. Возвращает URL callback, куда Google отправил бы браузер.
 */
async function googleConsent(consent: URL, o: { consent?: string; deny?: boolean; tamper_challenge?: boolean }): Promise<string> {
  const p = consent.searchParams;
  const callback = new URL(p.get("redirect_uri") ?? "");
  let query: Record<string, string>;
  if (o.deny) {
    query = { error: "access_denied", state: p.get("state") ?? "" };
  } else {
    const challenge = o.tamper_challenge ? "tampered-challenge-0000000000000000000000000" : p.get("code_challenge");
    const res = await post(`${FAKES}/__fake/google/authorize`, {
      email: o.consent,
      ...(challenge ? { code_challenge: challenge, code_challenge_method: p.get("code_challenge_method") } : {}),
    });
    const { code } = (await res.json()) as { code: string };
    query = { code, state: p.get("state") ?? "" };
  }
  return `${SUT}${callback.pathname}?${new URLSearchParams(query)}`;
}

/**
 * Ссылка «Подключить» → страница «подключаете к Telegram-аккаунту …» → кнопка «Продолжить» (POST формы с cookie)
 * → редирект на экран согласия Google. status — первый ответ не по пути (страница или форма).
 */
async function openConnectLink(
  jar: CookieJar,
  startUrl: string,
  opts: { withoutCookie?: boolean } = {},
): Promise<{ status: number; page: string; consent?: URL }> {
  const start = await browse(jar, startUrl);
  const page = await start.text();
  if (start.status !== 200) return { status: start.status, page };
  const field = (name: string) => new RegExp(`name="${name}" value="([^"]*)"`).exec(page)?.[1];
  const action = /<form method="post" action="([^"]+)"/.exec(page)?.[1];
  const state = field("state");
  const csrf = field("csrf");
  if (!action || state === undefined || csrf === undefined) throw new AssertionError(`connect page has no form: ${page}`);
  const res = await browse(jar, `${SUT}${action}`, {
    method: "POST",
    withoutCookies: opts.withoutCookie,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ state, csrf }),
  });
  if (res.status !== 302 && res.status !== 303) return { status: res.status, page };
  return { status: res.status, page, consent: new URL(res.headers.get("location") ?? "") };
}

// --- Выполнение --------------------------------------------------------------

/** Служебные вызовы Telegram — не сообщения пользователю; в expect_telegram не учитываются. */
const SERVICE_METHODS = new Set(["answerCallbackQuery", "getFile", "sendChatAction", "getWebhookInfo"]);

class AssertionError extends Error {}

async function runScenario(s: Scenario): Promise<void> {
  for (const url of [`${SUT}/__test/reset`, `${FAKES}/__fake/reset`]) {
    const res = await post(url, {});
    if (!res.ok) throw new AssertionError(`reset ${url} → ${res.status}`);
  }
  let updateId = 1000;
  let seen = 0; // сколько вызовов Telegram уже проверено

  let lastOAuth: { startUrl: string; callbackUrl: string; jar: CookieJar } | undefined;
  // Браузеры пользователей сценария (у каждого свои cookie) и придержанные callback (hold_callback) по email
  const browsers = new Map<string, CookieJar>();
  const browser = (name = "default") => browsers.get(name) ?? browsers.set(name, new CookieJar()).get(name)!;
  const heldCallbacks = new Map<string, string>();
  // Значения, запомненные capture в http_get/http_post, — подставляются как {{имя}}
  const vars = new Map<string, string>();
  const fill = (s: string) =>
    s.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
      const v = vars.get(name);
      if (v === undefined) throw new AssertionError(`no captured value {{${name}}}`);
      return v;
    });
  const checkPage = (where: string, what: string, body: string, parts: string[] = []) => {
    for (const part of parts) if (!body.includes(part)) throw new AssertionError(`${where}: ${what} does not contain «${part}»:\n${body}`);
  };

  const sendUpdate = async (t: TelegramInput, where = "") => {
    if (!t.redeliver) updateId++;
    const message = {
      message_id: updateId,
      date: 0,
      chat: { id: t.chat_id ?? t.from, type: t.chat_type ?? "private" },
      from: {
        id: t.from,
        is_bot: false,
        first_name: t.first_name ?? "Test",
        ...(t.username ? { username: t.username } : {}),
        language_code: t.language ?? "ru",
      },
      ...(t.text !== undefined ? { text: t.text } : {}),
      ...(t.reply_to ? { reply_to_message: { message_id: t.reply_to } } : {}),
      ...(t.reply_to_bot ? { reply_to_message: await lastBotMessageIn(t.chat_id ?? t.from) } : {}),
      ...(t.voice ? { voice: { ...t.voice, mime_type: "audio/ogg" } } : {}),
      ...(t.forwarded ? { forward_origin: { type: "user", date: 0, sender_user: { id: 777, is_bot: false, first_name: "Friend" } } } : {}),
    };
    const update = { update_id: updateId, [t.edited ? "edited_message" : "message"]: message };
    const res = await post(`${SUT}/telegram/webhook`, update, { "x-telegram-bot-api-secret-token": SECRET });
    if (res.status !== 200) throw new AssertionError(`${where}: webhook → ${res.status}`);
    await drainInbox("drain", where, t.expect_failure);
  };

  /** Обработать inbox (drain) или повторить упавшие (retry); expectFailure — обработка должна упасть. */
  const drainInbox = async (kind: "drain" | "retry", where: string, expectFailure = false) => {
    const res = await post(`${SUT}/__test/${kind}`, {});
    const body = await res.text();
    if (expectFailure ? res.status !== 500 : !res.ok) {
      throw new AssertionError(`${where}: ${kind} → ${res.status}${expectFailure ? ", expected the update to fail" : ""} ${body}`);
    }
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
        // Отрицательный id — групповой чат (как в Telegram)
        message: { message_id: p.messageId, date: 0, chat: { id: p.chatId, type: p.chatId < 0 ? "group" : "private" } },
        data: p.data,
      },
    };
    const res = await post(`${SUT}/telegram/webhook`, update, { "x-telegram-bot-api-secret-token": SECRET });
    if (res.status !== 200) throw new AssertionError(`${where}: webhook → ${res.status}`);
    const drain = await post(`${SUT}/__test/drain`, {});
    if (!drain.ok) throw new AssertionError(`${where}: drain → ${drain.status} ${await drain.text()}`);
  };

  // Общая подготовка подключается YAML-якорем как вложенный список шагов; repeat разворачивается
  const expand = (list: unknown[]): Step[] =>
    (list.flat(Infinity) as Step[]).flatMap((st) => ("repeat" in st ? Array.from({ length: st.repeat.times }, () => expand(st.repeat.steps)).flat() : [st]));
  const steps = expand(s.steps);
  for (const [n, step] of steps.entries()) {
    const where = `step ${n + 1}`;
    if ("tick" in step || "hourly" in step) {
      const res = await post(`${SUT}/__test/${"tick" in step ? "tick" : "hourly"}`, {});
      if (!res.ok) throw new AssertionError(`${where}: ${"tick" in step ? "tick" : "hourly"} → ${res.status}`);
    } else if ("alerts" in step) {
      const res = await post(`${SUT}/__test/alerts`, {});
      if (!res.ok) throw new AssertionError(`${where}: alerts → ${res.status}`);
      const want = step.alerts === true ? undefined : step.alerts.expect_sent;
      const got = ((await res.json()) as { sent: string[] }).sent;
      if (want && JSON.stringify(got) !== JSON.stringify(want))
        throw new AssertionError(`${where}: alerts sent ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
    } else if ("clock" in step) {
      const res = await post(`${SUT}/__test/clock`, { now: step.clock });
      if (!res.ok) throw new AssertionError(`${where}: clock → ${res.status}`);
    } else if ("telegram" in step) {
      await sendUpdate(step.telegram.text ? { ...step.telegram, text: fill(step.telegram.text) } : step.telegram, where);
    } else if ("capture_telegram" in step) {
      const calls = (await allTelegramCalls()).filter((c) => !SERVICE_METHODS.has(c.method)).reverse();
      for (const [name, re] of Object.entries(step.capture_telegram)) {
        const m = calls.map((c) => new RegExp(re).exec(c.body.text ?? "")).find((x) => x?.[1]);
        if (!m) throw new AssertionError(`${where}: capture_telegram ${name} /${re}/ not found in bot messages`);
        vars.set(name, m[1]!);
      }
    } else if ("webhook_raw" in step) {
      const w = step.webhook_raw;
      const headers: Record<string, string> = w.secret === null ? {} : { "x-telegram-bot-api-secret-token": w.secret ?? SECRET };
      const res = await post(`${SUT}/telegram/webhook`, w.body, headers);
      if (res.status !== w.expect_status) throw new AssertionError(`${where}: webhook status ${res.status}, expected ${w.expect_status}`);
    } else if ("expect_telegram" in step) {
      const calls = await newCalls();
      if (calls.length !== step.expect_telegram.length) {
        throw new AssertionError(
          `${where}: expected ${step.expect_telegram.length} Telegram call(s), got ${calls.length}: ${JSON.stringify(calls.map((c) => [c.method, c.body.text]))}`,
        );
      }
      for (const [k, exp] of step.expect_telegram.entries()) checkCall(`${where}.${k + 1}`, calls[k]!, exp);
    } else if ("google_account" in step) {
      await post(`${FAKES}/__fake/google/accounts`, step.google_account);
    } else if ("oauth" in step) {
      const o = step.oauth;
      const jar = browser(o.browser);
      const startUrl = await lastConnectUrl(o.from);
      const start = await openConnectLink(jar, startUrl, { withoutCookie: o.without_cookie });
      checkPage(where, "connect page", start.page, o.page_contains);
      if (!start.consent) {
        // Плохая/протухшая ссылка или чужая форма отвергаются ещё до Google
        if (o.expect_status === start.status) continue;
        throw new AssertionError(`${where}: oauth start → ${start.status}, expected redirect to Google`);
      }
      const p = start.consent.searchParams;
      for (const [k, v] of [
        ["access_type", "offline"],
        ["prompt", "consent"],
        ["response_type", "code"],
        ["code_challenge_method", "S256"],
      ] as const) {
        if (p.get(k) !== v) throw new AssertionError(`${where}: consent URL ${k}=${p.get(k)}, expected ${v}`);
      }
      if (!p.get("scope")?.includes("calendar.events")) throw new AssertionError(`${where}: consent URL scope ${p.get("scope")}`);
      // S256 от verifier 43–128 символов — 43 символа base64url
      if (!/^[A-Za-z0-9_-]{43}$/.test(p.get("code_challenge") ?? ""))
        throw new AssertionError(`${where}: consent URL code_challenge=${p.get("code_challenge")}`);
      if (!jar.has("oauth_bind")) throw new AssertionError(`${where}: no oauth_bind cookie before redirect to Google`);
      const callbackUrl = await googleConsent(start.consent, o);
      lastOAuth = { startUrl, callbackUrl, jar };
      if (o.hold_callback) {
        heldCallbacks.set(o.consent ?? "deny", callbackUrl);
        continue;
      }
      const res = await browse(jar, callbackUrl, { withoutCookies: o.callback_without_bind_cookie });
      const body = await res.text();
      const expected = o.expect_status ?? 200;
      if (res.status !== expected) throw new AssertionError(`${where}: oauth callback → ${res.status}, expected ${expected}: ${body}`);
      checkPage(where, "callback page", body, o.callback_contains);
    } else if ("oauth_callback" in step) {
      const c = step.oauth_callback;
      const url = heldCallbacks.get(c.of);
      if (!url) throw new AssertionError(`${where}: no held callback for ${c.of}`);
      const res = await browse(browser(c.browser), url, { withoutCookies: c.without_bind_cookie });
      const body = await res.text();
      if (res.status !== c.expect_status) throw new AssertionError(`${where}: held callback ${c.of} → ${res.status}, expected ${c.expect_status}: ${body}`);
      checkPage(where, "callback page", body, c.page_contains);
    } else if ("oauth_reuse_last_link" in step) {
      if (!lastOAuth) throw new AssertionError(`${where}: no previous oauth step`);
      for (const u of [lastOAuth.startUrl, lastOAuth.callbackUrl]) {
        const res = await browse(lastOAuth.jar, u);
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
      if (v.heard) await post(`${FAKES}/__fake/voice/fixtures`, { [content]: v.heard });
      let replyTo: number | undefined;
      if (v.reply_to_question) {
        const q = [...(await allTelegramCalls())].reverse().find((c) => c.body.reply_markup?.force_reply && c.messageId);
        if (!q) throw new AssertionError(`${where}: no question with ForceReply`);
        replyTo = q.messageId;
      }
      await sendUpdate(
        {
          from: v.from,
          voice: { file_id: fileId, duration: v.duration ?? 3 },
          ...(replyTo ? { reply_to: replyTo } : {}),
          ...(v.forwarded ? { forwarded: true } : {}),
          ...(v.expect_failure ? { expect_failure: true } : {}),
        },
        where,
      );
    } else if ("http_get" in step || "http_post" in step) {
      const isPost = "http_post" in step;
      const h: HttpCheck & { form?: Record<string, string> } = isPost ? step.http_post : step.http_get;
      const path = fill(h.path);
      const headers: Record<string, string> = h.basic_auth ? { authorization: `Basic ${btoa(h.basic_auth)}` } : {};
      const init: RequestInit = { redirect: "manual", headers };
      if (isPost) {
        init.method = "POST";
        headers["content-type"] = "application/x-www-form-urlencoded";
        init.body = new URLSearchParams(Object.entries(h.form ?? {}).map(([k, v]) => [k, fill(v)])).toString();
      }
      const what = `${isPost ? "POST" : "GET"} ${path}`;
      const res = await fetch(`${SUT}${path}`, init);
      const body = await res.text();
      if (res.status !== (h.expect_status ?? 200)) throw new AssertionError(`${where}: ${what} → ${res.status}`);
      if (h.location && !res.headers.get("location")?.endsWith(h.location)) throw new AssertionError(`${where}: location ${res.headers.get("location")}`);
      for (const part of (h.text_contains ?? []).map(fill)) if (!body.includes(part)) throw new AssertionError(`${where}: ${what} does not contain «${part}»`);
      for (const part of (h.text_not_contains ?? []).map(fill)) if (body.includes(part)) throw new AssertionError(`${where}: ${what} contains «${part}»`);
      for (const [name, re] of Object.entries(h.capture ?? {})) {
        const m = new RegExp(re).exec(body);
        if (!m?.[1]) throw new AssertionError(`${where}: ${what}: capture ${name} /${re}/ not found`);
        vars.set(name, m[1]);
      }
    } else if ("google_touch" in step) {
      await post(`${FAKES}/__fake/google/touch`, step.google_touch);
    } else if ("expect_google_patches" in step) {
      const e = step.expect_google_patches;
      const list = (await (await fetch(`${FAKES}/__fake/google/patches`)).json()) as { id: string; sendUpdates: string | null }[];
      if (e.count !== undefined && list.length !== e.count) throw new AssertionError(`${where}: ${list.length} patches, expected ${e.count}`);
      const last = list.at(-1);
      if (e.id && last?.id !== e.id) throw new AssertionError(`${where}: last patch id ${last?.id}, expected ${e.id}`);
      if (e.sendUpdates && last?.sendUpdates !== e.sendUpdates)
        throw new AssertionError(`${where}: sendUpdates=${last?.sendUpdates}, expected ${e.sendUpdates}`);
    } else if ("expect_google_deletes" in step) {
      const e = step.expect_google_deletes;
      const list = (await (await fetch(`${FAKES}/__fake/google/deletes`)).json()) as { id: string; sendUpdates: string | null }[];
      if (e.count !== undefined && list.length !== e.count) throw new AssertionError(`${where}: ${list.length} deletes, expected ${e.count}`);
      const last = list.at(-1);
      if (e.id && last?.id !== e.id) throw new AssertionError(`${where}: last delete id ${last?.id}, expected ${e.id}`);
      if (e.sendUpdates && last?.sendUpdates !== e.sendUpdates)
        throw new AssertionError(`${where}: sendUpdates=${last?.sendUpdates}, expected ${e.sendUpdates}`);
    } else if ("expect_token_revocations" in step) {
      const e = step.expect_token_revocations;
      const list = (await (await fetch(`${FAKES}/__fake/google/revocations`)).json()) as { token: string }[];
      if (list.length !== e.count) throw new AssertionError(`${where}: ${list.length} token revocations, expected ${e.count}`);
      if (e.last && list.at(-1)?.token !== e.last) throw new AssertionError(`${where}: last revoked token ${list.at(-1)?.token}, expected ${e.last}`);
    } else if ("token_revoke_fails" in step) {
      await post(`${FAKES}/__fake/google/revoke-fails`, { status: step.token_revoke_fails });
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
        if (p.chat !== undefined && String(c.body.chat_id) !== String(p.chat)) continue;
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
      const events = (cals.find((c) => c.id === e.calendar)?.events ?? []).filter((g) => (g as { status?: string }).status !== "cancelled");
      if (e.count !== undefined && events.length !== e.count)
        throw new AssertionError(`${where}: ${events.length} events in ${e.calendar}, expected ${e.count}`);
      const same = (got: { dateTime?: string; date?: string }, want: string) =>
        want.includes("T") ? !!got.dateTime && Date.parse(got.dateTime) === Date.parse(want) : got.date === want;
      for (const want of e.events) {
        const found = events.find(
          (g) =>
            g.summary === want.summary &&
            same(g.start, want.start) &&
            same(g.end, want.end) &&
            (want.location === undefined || (g.location ?? "") === want.location) &&
            (want.description === undefined || ((g as { description?: string }).description ?? "") === want.description) &&
            (!want.recurrence || JSON.stringify((g as { recurrence?: string[] }).recurrence) === JSON.stringify(want.recurrence)) &&
            (want.reminders === undefined || JSON.stringify((g as { reminders?: unknown }).reminders ?? null) === JSON.stringify(want.reminders)),
        );
        if (!found)
          throw new AssertionError(
            `${where}: event ${JSON.stringify(want)} not found in ${e.calendar}: ${JSON.stringify(events.map((g) => [g.summary, g.start, g.end]))}`,
          );
      }
    } else if ("connected_user" in step) {
      const c = step.connected_user;
      await post(`${FAKES}/__fake/google/accounts`, { email: c.email, calendars: c.calendars });
      await sendUpdate({ from: c.from, text: "/start", ...(c.language ? { language: c.language } : {}) });
      const jar = browser(`user-${c.from}`);
      const start = await openConnectLink(jar, await lastConnectUrl(c.from));
      if (!start.consent) throw new AssertionError(`${where}: connect ${c.email}: start → ${start.status}`);
      const res = await browse(jar, await googleConsent(start.consent, { consent: c.email }));
      if (res.status !== 200) throw new AssertionError(`${where}: connect ${c.email} → ${res.status}`);
      await newCalls(); // приветствие и «календарь подключён» — проверены отдельными сценариями
    } else if ("expect_telegram_count" in step) {
      const calls = await newCalls();
      if (calls.length !== step.expect_telegram_count)
        throw new AssertionError(`${where}: expected ${step.expect_telegram_count} Telegram call(s), got ${calls.length}`);
    } else if ("expect_llm_requests" in step) {
      const list = ((await (await fetch(`${FAKES}/__fake/llm/requests`)).json()) as { _via?: string }[]).filter((r) => r._via === "llm");
      if (list.length !== step.expect_llm_requests) throw new AssertionError(`${where}: ${list.length} LLM requests, expected ${step.expect_llm_requests}`);
    } else if ("expect_voice_rehearings" in step) {
      const list = (await (await fetch(`${FAKES}/__fake/voice/requests`)).json()) as unknown[];
      if (list.length !== step.expect_voice_rehearings)
        throw new AssertionError(`${where}: ${list.length} voice re-hearings, expected ${step.expect_voice_rehearings}`);
    } else if ("provider_outage" in step) {
      await post(`${FAKES}/__fake/outage`, step.provider_outage);
    } else if ("expect_provider_calls" in step) {
      const llm = (await (await fetch(`${FAKES}/__fake/llm/requests`)).json()) as { _via?: string }[];
      const stt = (await (await fetch(`${FAKES}/__fake/stt/requests`)).json()) as { via: string }[];
      const got: Record<string, number> = {};
      for (const r of [...llm.map((x) => x._via ?? "llm"), ...stt.map((x) => x.via)]) got[r] = (got[r] ?? 0) + 1;
      for (const [provider, n] of Object.entries(step.expect_provider_calls)) {
        if ((got[provider] ?? 0) !== n)
          throw new AssertionError(`${where}: ${provider} called ${got[provider] ?? 0} time(s), expected ${n}; all: ${JSON.stringify(got)}`);
      }
    } else if ("google_expire_access" in step) {
      await post(`${FAKES}/__fake/google/expire-access`, { email: step.google_expire_access });
    } else if ("expect_token_refreshes" in step) {
      const list = (await (await fetch(`${FAKES}/__fake/google/token-requests`)).json()) as { grant_type?: string }[];
      const n = list.filter((r) => r.grant_type === "refresh_token").length;
      if (n !== step.expect_token_refreshes) throw new AssertionError(`${where}: ${n} access token refresh(es), expected ${step.expect_token_refreshes}`);
    } else if ("telegram_fails" in step) {
      await post(`${FAKES}/__fake/telegram/fail`, step.telegram_fails);
    } else if ("queue_retry" in step) {
      await drainInbox("retry", where, step.queue_retry !== true && !!step.queue_retry.expect_failure);
    } else if ("expect_no_telegram" in step) {
      const calls = await newCalls();
      if (calls.length) throw new AssertionError(`${where}: expected no Telegram calls, got ${JSON.stringify(calls.map((c) => [c.method, c.body.text]))}`);
    } else {
      // Опечатка в YAML не должна давать зелёный тест
      throw new AssertionError(`${where}: unknown step ${JSON.stringify(Object.keys(step))}`);
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
    if (JSON.stringify(got) !== JSON.stringify(exp.buttons))
      throw new AssertionError(`${where}: buttons ${JSON.stringify(got)}, expected ${JSON.stringify(exp.buttons)}`);
  }
}

// --- Main ----------------------------------------------------------------------

/** Сценарий подходит под слово фильтра: US-xx — story, имя файла (с .yaml или без) — файл, иначе подстрока id. */
function matches(s: Scenario & { file: string }, word: string): boolean {
  if (/^(US|ADR)-/i.test(word)) return s.story.toUpperCase() === word.toUpperCase();
  if (/^\d\d-/.test(word) || word.endsWith(".yaml")) return s.file === word || s.file === `${word}.yaml`;
  return s.id.includes(word);
}

const dir = join(import.meta.dirname, "scenarios");
const all = readdirSync(dir)
  .filter((f) => f.endsWith(".yaml"))
  .sort()
  .flatMap((file) => (parseYaml(readFileSync(join(dir, file), "utf8")) as Scenario[]).map((s) => ({ ...s, file })));
const scenarios = filters.length ? all.filter((s) => filters.some((w) => matches(s, w))) : all;

if (filters.length && !scenarios.length) {
  // Опечатка в фильтре не должна выглядеть как «0 / 0 passed»
  console.error(`No scenarios match ${JSON.stringify(filters)} (by story US-xx, file NN-name, or id substring); try --list`);
  process.exit(2);
}
if (listOnly) {
  for (const s of scenarios) console.log(`${s.id}\t${s.story}\t${s.file}`);
  console.log(`\n${scenarios.length} scenario(s)`);
  process.exit(0);
}

let failed = 0;
for (const s of scenarios) {
  try {
    await runScenario(s);
    console.log(`  ✓ ${s.id}  (${s.story})`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${s.id}  (${s.story}, ${s.file})\n      ${String(e instanceof Error ? e.message : e).replaceAll("\n", "\n      ")}`);
  }
}
console.log(`\n${scenarios.length - failed} / ${scenarios.length} scenarios passed`);
process.exitCode = failed ? 1 : 0;
