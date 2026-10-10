// Фейки внешних API для приёмки; код бота не импортирует (ADR-0006). Правка файла — `docker compose restart fakes`.
//
// Фейки API:
//   /telegram/bot<token>/<method>     — Telegram Bot API: запоминает вызовы, отвечает успехом
//   /telegram/file/bot<t>/<path>      — файлы Telegram (голосовые, фото, .ics — содержимое строкой)
//   /google-oauth/token               — код от /__fake/google/authorize одноразовый; был code_challenge — нужен верный
//                                       code_verifier (S256), иначе invalid_grant
//   /google-oauth/revoke              — отзыв: снимает доступ аккаунта целиком
//   /google/calendar/v3/…             — токен "at-<email>", после refresh "at-<email>~<n>"; отозванный и expire-access — 401
//   /llm/v1/chat/completions, /llm-backup/v1/chat/completions — LLM и запасная: ответ из фикстур по тексту пользователя
//   /stt/run/<model>                  — Whisper (Workers AI REST): ответ по содержимому аудио
//   /stt-openai/audio/transcriptions  — OpenAI-совместимый STT (Groq), multipart: те же фикстуры
//   /gemini/v1beta/models/<m>:generateContent — переслушивание голоса и чтение картинок
//   /vision/v1/chat/completions       — OpenAI-совместимое чтение картинок (DeepSeek): те же фикстуры, что у Gemini
//   GET /llm/v1/key, GET /llm-backup/user/balance — остатки OpenRouter и DeepSeek (панель «Квоты»)
//   POST /cf/client/v4/graphql        — GraphQL Analytics Cloudflare: набор — по имени в запросе
//                                       (aiInferenceAdaptiveGroups, workersInvocationsAdaptive, d1…, queueMessageOperations…)
//   Groq отвечает с x-ratelimit-*-requests; LLM в outage 429 — с x-ratelimit-limit/remaining/reset.
//
// Управление для раннера:
//   POST /__fake/reset                — сброс состояния
//   GET  /__fake/telegram/calls       — все вызовы Telegram с последнего сброса
//   POST /__fake/telegram/files       — {file_id, content}: файл для getFile и скачивания
//   POST /__fake/telegram/fail        — {text_contains, method?, status?, times?}: ближайшие times (1) вызовов method (sendMessage)
//                                       с этим текстом отвечают ошибкой status (500) и не попадают в calls — не доставлено
//   POST /__fake/google/accounts      — {email, calendars: [...]}; у календаря: list_error: <status> — events.list отвечает
//                                       этой ошибкой; list_error_times: <n> — первые n events.list отвечают 503;
//                                       shared: true — у аккаунтов с тем же id календаря одни и те же события
//   POST /__fake/google/authorize     — «согласие»: {email, code_challenge?, code_challenge_method?} → {code}
//   GET  /__fake/google/token-requests — все запросы к /token (обмен кода и refresh)
//   POST /__fake/google/expire-access — {email}: выданные access token → 401, refresh работает
//   POST /__fake/google/revoke        — {email}: отозвать доступ аккаунта
//   GET  /__fake/google/revocations   — журнал /google-oauth/revoke: {token, status}
//   POST /__fake/google/revoke-fails  — {status}: отзыв отвечает этой ошибкой (0 — снова работает)
//   GET  /__fake/google/patches       — журнал PATCH: {calendar, id, sendUpdates, body}
//   GET  /__fake/google/deletes       — журнал DELETE: {calendar, id, sendUpdates}
//   POST /__fake/google/touch         — {email, calendar, id}: «кто-то другой» изменил событие (новый etag)
//   GET  /__fake/google/events?email=… — календари аккаунта с событиями
//   POST /__fake/outage               — {provider, status}: провайдер отвечает этой ошибкой (0 — снова работает). provider:
//                                       llm | llm-backup | stt | stt-openai | gemini | vision | google-write (insert/patch/delete;
//                                       403 — rateLimitExceeded, а не «нет прав») | google-watch; status 200 у llm/vision —
//                                       ошибка в теле без choices, как OpenRouter при перегрузке
//   POST /__fake/llm/fixtures         — {"<текст>": {tool, args, raw_arguments?} | {tools: [...]} | {error: status}}
//   GET  /__fake/llm/requests         — все запросы к LLM
//   POST /__fake/stt/fixtures         — {"<содержимое аудио>": {text} | {error: status}}
//   GET  /__fake/stt/requests         — [{via}]
//   POST /__fake/voice/fixtures       — {"<содержимое аудио>": {transcript, tool, args} | {no_speech: true} | {error: status}}
//   GET  /__fake/voice/requests       — [{content}]
//   POST /__fake/vision/fixtures      — {"<содержимое картинки>": {text, tool?, args?} | {no_event: true, text?} | {error: status}}
//   GET  /__fake/vision/requests      — [{via: openai | gemini, content, mimeType, caption?}]
//   POST /__fake/quotas               — {openrouter?: тело /key, deepseek?: тело /user/balance, openrouter_status?, deepseek_status?,
//                                       cf_ai? | cf_workers? | cf_d1? | cf_queues?: accounts[0], cf_error?: текст ошибки GraphQL};
//                                       status ≠ 0 — ошибка; reset возвращает значения по умолчанию
//   GET  /__fake/quotas/requests      — [{via, auth}] (проверка кеша и ключа)
//
// Синхронизация и push Google:
//   events.list с syncToken — изменения с момента токена (удалённые — status=cancelled), токен st:<календарь>:<изменение>:<поколение>;
//     с syncToken нельзя timeMin/timeMax/orderBy (400), просроченный — 410; полный список тоже отдаёт nextSyncToken
//   POST …/calendars/<id>/events/watch, POST …/channels/stop — каналы push
//   POST /__fake/google/push          — {calendar, state?, token?}: уведомление в каждый канал календаря → {sent: [{id, status}]}
//   POST /__fake/google/external      — {calendar, create?: событие, move?: {id, start, end}, update?: {id, …поля}, delete?: id}:
//                                       изменение «не через бота»
//   POST /__fake/google/expire-sync-tokens — {calendar}: все выданные syncToken календаря → 410
//   POST /__fake/google/page-size     — {size}: calendarList и events.list по size записей (0 — без страниц);
//                                       nextSyncToken — только на последней странице, как у Google
//   GET  /__fake/google/channels      — {active: [{id, calendar, address, expiration}], stopped: [{id, resourceId}]}
//   GET  /__fake/google/sync-requests — [{calendar, mode: full | incremental | expired}]

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

interface TelegramCall {
  method: string;
  token: string;
  body: Record<string, unknown>;
  messageId?: number;
}

interface GoogleEvent {
  id: string;
  status?: string;
  summary?: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  [k: string]: unknown;
}

interface GoogleCalendar {
  id: string;
  shared?: boolean;
  summary: string;
  accessRole: string;
  primary?: boolean;
  timeZone?: string;
  events?: GoogleEvent[];
  list_error?: number;
  list_error_times?: number;
}

type LlmFixture =
  /** raw_arguments — строка аргументов как есть, для битого JSON. */
  { tool: string; args?: Record<string, unknown>; raw_arguments?: string } | { tools: { tool: string; args?: Record<string, unknown> }[] } | { error: number };

const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? "test-client-secret";

let telegramCalls: TelegramCall[] = [];
let nextMessageId = 1;
/** accessValidFrom — access token с номером меньше не принимаются. */
let googleAccounts = new Map<string, { calendars: GoogleCalendar[]; revoked?: boolean; accessValidFrom?: number }>();
let accessSeq = 0;
let telegramFailures: { method: string; text: string; status: number; times: number }[] = [];
let tokenRequests: Record<string, string>[] = [];
let authCodes = new Map<string, { email: string; challenge?: string; method?: string; used: boolean }>();
let authCodeSeq = 1;
let llmFixtures = new Map<string, LlmFixture>();
let telegramFiles = new Map<string, string>();
let sttFixtures = new Map<string, { text?: string; error?: number }>();
let llmRequests: unknown[] = [];
let sttRequests: { via: string }[] = [];
let voiceFixtures = new Map<string, { transcript?: string; tool?: string; args?: Record<string, unknown>; no_speech?: boolean; error?: number }>();
let voiceRequests: { content: string }[] = [];
type VisionFixture = { text?: string; tool?: string; args?: Record<string, unknown>; no_event?: boolean; error?: number };
let visionFixtures = new Map<string, VisionFixture>();
let visionRequests: { via: "openai" | "gemini"; content: string; mimeType: string; caption?: string }[] = [];
const QUOTAS_DEFAULT = {
  openrouter: {
    data: {
      label: "sk-or-v1-fake…key",
      limit: null,
      limit_reset: null,
      limit_remaining: null,
      usage: 0.5,
      usage_daily: 0,
      is_free_tier: true,
      free_model_daily_requests: { used: 12, limit: 50, remaining: 38 },
    },
  } as unknown,
  deepseek: { is_available: true, balance_infos: [{ currency: "USD", total_balance: "4.20", granted_balance: "0.00", topped_up_balance: "4.20" }] } as unknown,
  openrouter_status: 0,
  deepseek_status: 0,
  cf_ai: {
    aiInferenceAdaptiveGroups: [
      { dimensions: { modelId: "@cf/qwen/qwen3-30b-a3b-fp8" }, sum: { totalNeurons: 1200 } },
      { dimensions: { modelId: "@cf/openai/whisper-large-v3-turbo" }, sum: { totalNeurons: 34.4 } },
    ],
  } as unknown,
  cf_workers: {
    workersInvocationsAdaptive: [
      {
        dimensions: { scriptName: "calendar-assist-bot" },
        sum: { requests: 3000, errors: 3, subrequests: 4500 },
        quantiles: { cpuTimeP50: 1800, cpuTimeP99: 6500 },
      },
      { dimensions: { scriptName: "other-worker" }, sum: { requests: 500, errors: 0, subrequests: 0 }, quantiles: { cpuTimeP50: 900, cpuTimeP99: 2000 } },
    ],
  } as unknown,
  cf_d1: {
    d1AnalyticsAdaptiveGroups: [{ dimensions: { databaseId: "db-1" }, sum: { rowsRead: 250000, rowsWritten: 12000, readQueries: 4000, writeQueries: 1500 } }],
    d1StorageAdaptiveGroups: [{ dimensions: { databaseId: "db-1" }, max: { databaseSizeBytes: 12_500_000 } }],
  } as unknown,
  cf_queues: {
    queueMessageOperationsAdaptiveGroups: [
      { dimensions: { actionType: "WriteMessage" }, sum: { billableOperations: 700 } },
      { dimensions: { actionType: "ReadMessage" }, sum: { billableOperations: 700 } },
      { dimensions: { actionType: "DeleteMessage" }, sum: { billableOperations: 700 } },
    ],
  } as unknown,
  cf_error: "",
};
let quotas = structuredClone(QUOTAS_DEFAULT);
let quotaRequests: { via: string; auth: string }[] = [];
let outages = new Map<string, number>();
let googlePageSize = 0;

function googlePage<T>(url: URL, items: T[]): { items: T[]; nextPageToken?: string } {
  if (!googlePageSize) return { items };
  const from = Number(/^pg:(\d+)$/.exec(url.searchParams.get("pageToken") ?? "")?.[1] ?? 0);
  const next = from + googlePageSize;
  return { items: items.slice(from, next), ...(next < items.length ? { nextPageToken: `pg:${next}` } : {}) };
}

function googleWriteOutage(res: ServerResponse, status: number) {
  if (status === 403)
    return send(res, 403, { error: { code: 403, message: "Rate Limit Exceeded", errors: [{ domain: "usageLimits", reason: "rateLimitExceeded" }] } });
  return send(res, status, { error: { code: status, message: "fake outage" } });
}
let revocations: { token: string; status: number }[] = [];
let revokeFailStatus = 0;

let changeSeq = 0;
/** Токены прежних поколений просрочены (410). */
let syncTokenGen = new Map<string, number>();
const syncTokenOf = (calId: string) => `st:${calId}:${changeSeq}:${syncTokenGen.get(calId) ?? 0}`;
let sharedEvents = new Map<string, GoogleEvent[]>();
let channels: { id: string; token?: string; address: string; resourceId: string; calendar: string; expiration?: number }[] = [];
let stoppedChannels: { id: string; resourceId: string }[] = [];
let syncRequests: { calendar: string; mode: string }[] = [];

function bump(e: GoogleEvent): void {
  e._seq = ++changeSeq;
  e.updated = new Date().toISOString();
}

function findCalendar(id: string): GoogleCalendar | undefined {
  for (const acc of googleAccounts.values()) {
    const cal = acc.calendars.find((c) => c.id === id);
    if (cal) return cal;
  }
  return undefined;
}

const publicEvent = ({ _seq: _s, ...e }: GoogleEvent) => e;

function zonedMidnight(date: string, tz: string): number {
  const guess = Date.parse(`${date}T00:00:00Z`);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(new Date(guess))
      .map((x) => [x.type, x.value]),
  );
  const asLocal = Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00Z`);
  return guess - (asLocal - guess);
}

function zonedToUtc(local: string, tz: string): number {
  const [date, time] = local.split("T");
  const [h, m] = (time ?? "00:00").split(":").map(Number);
  return zonedMidnight(date!, tz) + (h! * 60 + m!) * 60_000;
}

/** Google вернул бы dateTime со смещением пояса календаря; фейк — в UTC. */
function normalizeTimes(e: GoogleEvent, tz: string): GoogleEvent {
  const fix = (t: { dateTime?: string; date?: string; timeZone?: string } | undefined) =>
    t?.dateTime && !/[zZ]|[+-]\d\d:\d\d$/.test(t.dateTime) ? { ...t, dateTime: new Date(zonedToUtc(t.dateTime, t.timeZone ?? tz)).toISOString() } : t;
  return { ...e, start: fix(e.start)!, end: fix(e.end)! };
}

let nextEventId = 1;
let etagSeq = 1;
let patches: { calendar: string; id: string; sendUpdates: string | null; body: unknown }[] = [];
let deletes: { calendar: string; id: string; sendUpdates: string | null }[] = [];
const newEtag = () => `"etag-${etagSeq++}"`;

function eventBounds(e: GoogleEvent, tz: string): [number, number] {
  const s = e.start.dateTime ? Date.parse(e.start.dateTime) : zonedMidnight(e.start.date!, tz);
  const en = e.end.dateTime ? Date.parse(e.end.dateTime) : zonedMidnight(e.end.date!, tz);
  return [s, en];
}

async function readForm(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
}

function googleAccountByToken(req: IncomingMessage) {
  const m = /^Bearer at-([^~]+)(?:~(\d+))?$/.exec(req.headers.authorization ?? "");
  const account = m ? googleAccounts.get(m[1]!) : undefined;
  if (!account || account.revoked) return undefined;
  return Number(m![2] ?? 0) < (account.accessValidFrom ?? 0) ? undefined : account;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function telegramResult(method: string, body: Record<string, unknown>): unknown {
  switch (method) {
    case "getFile":
      return telegramFiles.has(String(body.file_id))
        ? { file_id: body.file_id, file_path: `voice/${encodeURIComponent(String(body.file_id))}.oga` }
        : { file_id: body.file_id };
    case "sendMessage":
      return { message_id: nextMessageId++, date: 0, chat: { id: body.chat_id, type: "private" }, text: body.text };
    case "editMessageText":
      return true;
    // Для панели «здоровье» админки
    case "getWebhookInfo":
      return { url: "http://dev:8787/telegram/webhook", has_custom_certificate: false, pending_update_count: 0 };
    default:
      return true;
  }
}

function visionCall(
  via: "openai" | "gemini",
  content: string,
  mimeType: string,
  caption: string | undefined,
): { status: number; message: string } | { name: string; args: Record<string, unknown> } {
  visionRequests.push({ via, content, mimeType, ...(caption ? { caption } : {}) });
  const fx = visionFixtures.get(content);
  if (!fx) return { status: 400, message: `fake vision: no fixture for «${content}»` };
  if (fx.error) return { status: fx.error, message: "fake vision error" };
  return fx.no_event
    ? { name: "no_event", args: { text: fx.text ?? "" } }
    : { name: fx.tool ?? "create_event", args: { text: fx.text ?? "", ...(fx.args ?? {}) } };
}

function visionAnswer(res: ServerResponse, body: { contents?: { parts?: { inlineData?: { mimeType?: string; data?: string }; text?: string }[] }[] }) {
  const parts = body.contents?.[0]?.parts ?? [];
  const img = parts.find((p) => p.inlineData)!.inlineData!;
  const call = visionCall("gemini", Buffer.from(img.data ?? "", "base64").toString("utf8"), img.mimeType ?? "", parts.find((p) => p.text)?.text);
  if ("status" in call) return send(res, call.status, { error: { code: call.status, message: call.message } });
  return send(res, 200, {
    candidates: [{ content: { role: "model", parts: [{ functionCall: call }] } }],
    usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 80 },
  });
}

function visionOpenAiAnswer(res: ServerResponse, body: { messages?: { role: string; content: unknown }[] }) {
  const content = body.messages?.find((m) => m.role === "user")?.content;
  const parts = Array.isArray(content) ? (content as { type: string; text?: string; image_url?: { url?: string } }[]) : [];
  const m = /^data:([^;]+);base64,(.*)$/s.exec(parts.find((p) => p.type === "image_url")?.image_url?.url ?? "");
  if (!m) return send(res, 400, { error: { message: "fake vision: expected image_url data:URL" } });
  const call = visionCall("openai", Buffer.from(m[2]!, "base64").toString("utf8"), m[1]!, parts.find((p) => p.type === "text")?.text);
  if ("status" in call) return send(res, call.status, { error: { message: call.message } });
  return send(res, 200, {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_0", type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }],
        },
      },
    ],
    usage: { prompt_tokens: 1200, completion_tokens: 80 },
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://fakes");
  try {
    if (url.pathname === "/__fake/reset" && req.method === "POST") {
      telegramCalls = [];
      nextMessageId = 1;
      googleAccounts = new Map();
      tokenRequests = [];
      authCodes = new Map();
      authCodeSeq = 1;
      llmFixtures = new Map();
      llmRequests = [];
      sttRequests = [];
      voiceFixtures = new Map();
      voiceRequests = [];
      visionFixtures = new Map();
      visionRequests = [];
      outages = new Map();
      googlePageSize = 0;
      quotas = structuredClone(QUOTAS_DEFAULT);
      quotaRequests = [];
      telegramFiles = new Map();
      sttFixtures = new Map();
      nextEventId = 1;
      etagSeq = 1;
      patches = [];
      deletes = [];
      changeSeq = 0;
      syncTokenGen = new Map();
      sharedEvents = new Map();
      channels = [];
      stoppedChannels = [];
      syncRequests = [];
      revocations = [];
      revokeFailStatus = 0;
      accessSeq = 0;
      telegramFailures = [];
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/__fake/telegram/calls") return send(res, 200, telegramCalls);
    if (url.pathname === "/__fake/google/accounts" && req.method === "POST") {
      const body = (await readJson(req)) as { email: string; calendars: GoogleCalendar[] };
      for (const c of body.calendars) {
        // Общий календарь уже заведён другим аккаунтом — те же события
        const known = c.shared ? sharedEvents.get(c.id) : undefined;
        if (known) c.events = known;
        else {
          for (const e of c.events ?? []) {
            e.etag ??= newEtag();
            bump(e);
          }
          c.events ??= [];
          if (c.shared) sharedEvents.set(c.id, c.events);
        }
      }
      googleAccounts.set(body.email, { calendars: body.calendars });
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/__fake/google/authorize" && req.method === "POST") {
      const b = (await readJson(req)) as { email: string; code_challenge?: string; code_challenge_method?: string };
      const code = `code-${authCodeSeq++}-${b.email}`;
      authCodes.set(code, { email: b.email, challenge: b.code_challenge, method: b.code_challenge_method, used: false });
      return send(res, 200, { code });
    }
    if (url.pathname === "/__fake/google/token-requests") return send(res, 200, tokenRequests);
    if (url.pathname === "/__fake/google/revocations") return send(res, 200, revocations);
    if (url.pathname === "/__fake/google/expire-access" && req.method === "POST") {
      const { email } = (await readJson(req)) as { email: string };
      const acc = googleAccounts.get(email);
      if (acc) acc.accessValidFrom = accessSeq + 1;
      return send(res, 200, { ok: !!acc });
    }
    if (url.pathname === "/__fake/telegram/fail" && req.method === "POST") {
      const b = (await readJson(req)) as { text_contains: string; method?: string; status?: number; times?: number };
      telegramFailures.push({ method: b.method ?? "sendMessage", text: b.text_contains, status: b.status ?? 500, times: b.times ?? 1 });
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/__fake/google/revoke-fails" && req.method === "POST") {
      revokeFailStatus = Number((await readJson(req)).status ?? 0);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/__fake/google/revoke" && req.method === "POST") {
      const { email } = (await readJson(req)) as { email: string };
      const acc = googleAccounts.get(email);
      if (acc) acc.revoked = true;
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/__fake/llm/fixtures" && req.method === "POST") {
      for (const [text, fx] of Object.entries(await readJson(req))) llmFixtures.set(text, fx as LlmFixture);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/__fake/llm/requests") return send(res, 200, llmRequests);
    if (url.pathname === "/__fake/telegram/files" && req.method === "POST") {
      const { file_id, content } = (await readJson(req)) as { file_id: string; content: string };
      telegramFiles.set(file_id, content);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/__fake/stt/fixtures" && req.method === "POST") {
      for (const [content, fx] of Object.entries(await readJson(req))) sttFixtures.set(content, fx as { text?: string; error?: number });
      return send(res, 200, { ok: true });
    }

    if (url.pathname === "/__fake/google/page-size" && req.method === "POST") {
      googlePageSize = Number(((await readJson(req)) as { size?: number }).size ?? 0);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/__fake/outage" && req.method === "POST") {
      const { provider, status } = (await readJson(req)) as { provider: string; status: number };
      if (status) outages.set(provider, status);
      else outages.delete(provider);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/__fake/stt/requests") return send(res, 200, sttRequests);
    if (url.pathname === "/__fake/voice/fixtures" && req.method === "POST") {
      for (const [content, fx] of Object.entries(await readJson(req))) voiceFixtures.set(content, fx as never);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/__fake/voice/requests") return send(res, 200, voiceRequests);
    if (url.pathname === "/__fake/vision/fixtures" && req.method === "POST") {
      for (const [content, fx] of Object.entries(await readJson(req))) visionFixtures.set(content, fx as VisionFixture);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/__fake/vision/requests") return send(res, 200, visionRequests);

    if (url.pathname === "/vision/v1/chat/completions" && req.method === "POST") {
      const outage = outages.get("vision");
      // Как OpenRouter/DeepSeek при перегрузке: ошибка в теле, без choices
      if (outage === 200) return send(res, 200, { error: { message: "fake upstream overload", code: 502 } });
      if (outage) return send(res, outage, { error: { message: "fake outage" } });
      return visionOpenAiAnswer(res, (await readJson(req)) as never);
    }

    if (/^\/gemini\/v1beta\/models\/[^/]+:generateContent$/.test(url.pathname) && req.method === "POST") {
      const outage = outages.get("gemini");
      if (outage) return send(res, outage, { error: { code: outage, message: "fake outage" } });
      const body = (await readJson(req)) as { contents?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] }[] };
      const part = body.contents?.[0]?.parts?.find((p) => p.inlineData);
      if (part?.inlineData?.mimeType?.startsWith("image/")) return visionAnswer(res, body as never);
      if (part?.inlineData?.mimeType !== "audio/ogg") return send(res, 400, { error: { message: "fake voice: expected inlineData audio/ogg" } });
      const content = Buffer.from(part.inlineData.data ?? "", "base64").toString("utf8");
      voiceRequests.push({ content });
      const fx = voiceFixtures.get(content);
      if (!fx) return send(res, 400, { error: { message: `fake voice: no fixture for «${content}»` } });
      if (fx.error) return send(res, fx.error, { error: { code: fx.error, message: "fake voice error" } });
      const call = fx.no_speech
        ? { name: "no_speech", args: {} }
        : { name: fx.tool ?? "unsupported", args: { transcript: fx.transcript ?? "", ...(fx.args ?? {}) } };
      return send(res, 200, {
        candidates: [{ content: { role: "model", parts: [{ functionCall: call }] } }],
        usageMetadata: { promptTokenCount: 2000, candidatesTokenCount: 50 },
      });
    }

    if (url.pathname === "/stt-openai/audio/transcriptions" && req.method === "POST") {
      sttRequests.push({ via: "stt-openai" });
      const outage = outages.get("stt-openai");
      if (outage) return send(res, outage, { error: { message: "fake outage" } });
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!/name="model"/.test(raw) || !/filename="voice\.ogg"/.test(raw))
        return send(res, 400, { error: { message: "fake stt: expected multipart with file and model" } });
      // «Аудио» в тестах — короткая строка; ищем фикстуру, чей ключ есть в теле multipart
      const entry = [...sttFixtures.entries()].find(([content]) => raw.includes(`\r\n\r\n${content}\r\n`));
      if (!entry) return send(res, 400, { error: { message: "fake stt: no fixture for the uploaded file" } });
      const fx = entry[1];
      if (fx.error) return send(res, fx.error, { error: { message: "fake stt error" } });
      return send(
        res,
        200,
        { text: fx.text ?? "", language: "russian", duration: 3 },
        { "x-ratelimit-limit-requests": "2000", "x-ratelimit-remaining-requests": "1990", "x-ratelimit-reset-requests": "1h0m0s" },
      );
    }

    if (url.pathname.startsWith("/stt/run/") && req.method === "POST") {
      sttRequests.push({ via: "stt" });
      const outage = outages.get("stt");
      if (outage) return send(res, outage, { success: false, errors: [{ message: "fake outage" }] });
      const { audio } = (await readJson(req)) as { audio?: string };
      const content = Buffer.from(audio ?? "", "base64").toString("utf8");
      const fx = sttFixtures.get(content);
      if (!fx) return send(res, 400, { success: false, errors: [{ message: `fake stt: no fixture for «${content}»` }] });
      if (fx.error) return send(res, fx.error, { success: false, errors: [{ message: "fake stt error" }] });
      return send(res, 200, { success: true, result: { text: fx.text ?? "", transcription_info: { language: "ru", duration: 3 } } });
    }

    const tgFile = /^\/telegram\/file\/bot[^/]+\/voice\/(.+)\.oga$/.exec(url.pathname);
    if (tgFile) {
      const content = telegramFiles.get(decodeURIComponent(tgFile[1]!));
      if (content === undefined) return send(res, 404, { ok: false });
      res.writeHead(200, { "content-type": "audio/ogg" });
      return res.end(content);
    }
    if (url.pathname === "/__fake/google/patches") return send(res, 200, patches);
    if (url.pathname === "/__fake/google/deletes") return send(res, 200, deletes);
    if (url.pathname === "/__fake/google/touch" && req.method === "POST") {
      const { email, calendar, id } = (await readJson(req)) as { email: string; calendar: string; id: string };
      const ev = googleAccounts
        .get(email)
        ?.calendars.find((c) => c.id === calendar)
        ?.events?.find((e) => e.id === id);
      if (ev) {
        ev.etag = newEtag();
        bump(ev);
      }
      return send(res, 200, { ok: !!ev });
    }
    if (url.pathname === "/__fake/google/external" && req.method === "POST") {
      const b = (await readJson(req)) as {
        calendar: string;
        create?: GoogleEvent;
        move?: { id: string; start: GoogleEvent["start"]; end: GoogleEvent["end"] };
        update?: { id: string } & Record<string, unknown>;
        delete?: string;
      };
      const cal = findCalendar(b.calendar);
      if (!cal) return send(res, 404, { ok: false, error: "no calendar" });
      cal.events ??= [];
      const tz = cal.timeZone ?? "UTC";
      if (b.create) {
        const ev = normalizeTimes({ status: "confirmed", htmlLink: `https://calendar.google.com/event?eid=${b.create.id}`, ...b.create, etag: newEtag() }, tz);
        bump(ev);
        cal.events.push(ev);
      }
      const target = (id: string) => cal.events!.find((e) => e.id === id);
      if (b.move) {
        const ev = target(b.move.id);
        if (!ev) return send(res, 404, { ok: false });
        Object.assign(ev, normalizeTimes({ ...ev, start: b.move.start, end: b.move.end }, tz), { etag: newEtag() });
        bump(ev);
      }
      if (b.update) {
        const ev = target(b.update.id);
        if (!ev) return send(res, 404, { ok: false });
        Object.assign(ev, b.update, { etag: newEtag() });
        bump(ev);
      }
      if (b.delete) {
        const ev = target(b.delete);
        if (!ev) return send(res, 404, { ok: false });
        for (const e of cal.events) {
          if (e.id === ev.id || e.recurringEventId === ev.id) {
            e.status = "cancelled";
            e.etag = newEtag();
            bump(e);
          }
        }
      }
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/__fake/google/expire-sync-tokens" && req.method === "POST") {
      const { calendar } = (await readJson(req)) as { calendar: string };
      syncTokenGen.set(calendar, (syncTokenGen.get(calendar) ?? 0) + 1);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/__fake/google/channels") return send(res, 200, { active: channels, stopped: stoppedChannels });
    if (url.pathname === "/__fake/google/sync-requests") return send(res, 200, syncRequests);
    if (url.pathname === "/__fake/google/push" && req.method === "POST") {
      const b = (await readJson(req)) as { calendar: string; state?: string; token?: string };
      const sent: { id: string; status: number }[] = [];
      for (const ch of channels.filter((c) => c.calendar === b.calendar)) {
        const token = b.token ?? ch.token;
        const r = await fetch(ch.address, {
          method: "POST",
          headers: {
            "x-goog-channel-id": ch.id,
            "x-goog-message-number": String(sent.length + 2),
            "x-goog-resource-id": ch.resourceId,
            "x-goog-resource-state": b.state ?? "exists",
            "x-goog-resource-uri": `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(ch.calendar)}/events`,
            ...(token ? { "x-goog-channel-token": token } : {}),
          },
        });
        await r.body?.cancel();
        sent.push({ id: ch.id, status: r.status });
      }
      return send(res, 200, { sent });
    }
    if (url.pathname === "/__fake/google/events") {
      const acc = googleAccounts.get(url.searchParams.get("email") ?? "");
      return send(res, 200, acc?.calendars ?? []);
    }

    if (url.pathname === "/__fake/quotas" && req.method === "POST") {
      quotas = { ...quotas, ...(await readJson(req)) } as typeof quotas;
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/__fake/quotas/requests") return send(res, 200, quotaRequests);
    if ((url.pathname === "/llm/v1/key" || url.pathname === "/llm-backup/user/balance") && req.method === "GET") {
      const openrouter = url.pathname === "/llm/v1/key";
      quotaRequests.push({ via: openrouter ? "openrouter" : "deepseek", auth: req.headers.authorization ?? "" });
      if (req.headers.authorization !== "Bearer test-llm-key") return send(res, 401, { error: { message: "fake: bad key" } });
      const status = openrouter ? quotas.openrouter_status : quotas.deepseek_status;
      if (status) return send(res, status, { error: { message: "fake quota endpoint outage" } });
      return send(res, 200, openrouter ? quotas.openrouter : quotas.deepseek);
    }

    if (url.pathname === "/cf/client/v4/graphql" && req.method === "POST") {
      const body = (await readJson(req)) as { query?: string };
      const q = body.query ?? "";
      const kind = q.includes("aiInferenceAdaptiveGroups")
        ? "ai"
        : q.includes("workersInvocationsAdaptive")
          ? "workers"
          : q.includes("d1AnalyticsAdaptiveGroups")
            ? "d1"
            : q.includes("queueMessageOperationsAdaptiveGroups")
              ? "queues"
              : "unknown";
      quotaRequests.push({ via: `cloudflare:${kind}`, auth: req.headers.authorization ?? "" });
      if (req.headers.authorization !== "Bearer test-llm-key") return send(res, 200, { data: null, errors: [{ message: "fake: authentication error" }] });
      // Как настоящий API: ошибка — HTTP 200 с errors
      if (quotas.cf_error || kind === "unknown") return send(res, 200, { data: null, errors: [{ message: quotas.cf_error || "fake: unknown dataset" }] });
      const acc = { ai: quotas.cf_ai, workers: quotas.cf_workers, d1: quotas.cf_d1, queues: quotas.cf_queues }[kind];
      return send(res, 200, { data: { viewer: { accounts: [acc] } }, errors: null });
    }

    const llmPath = /^\/(llm|llm-backup)\/v1\/chat\/completions$/.exec(url.pathname);
    if (llmPath && req.method === "POST") {
      const via = llmPath[1]!;
      const body = (await readJson(req)) as { messages?: { role: string; content: string }[] };
      llmRequests.push({ ...body, _via: via });
      const outage = outages.get(via);
      // Как OpenRouter при перегрузке: ошибка в теле, без choices
      if (outage === 200) return send(res, 200, { error: { message: "fake upstream overload", code: 502 } });
      // Как OpenRouter на исчерпанной суточной квоте бесплатных моделей
      if (outage === 429 && via === "llm")
        return send(
          res,
          429,
          { error: { message: "fake rate limit" } },
          { "x-ratelimit-limit": "50", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1791590400000" },
        );
      if (outage) return send(res, outage, { error: { message: "fake outage" } });
      const text = [...(body.messages ?? [])].reverse().find((m) => m.role === "user")?.content ?? "";
      const fx = llmFixtures.get(text);
      if (!fx) return send(res, 400, { error: `fake llm: no fixture for «${text}»` });
      if ("error" in fx) return send(res, fx.error, { error: "fake llm error" });
      const calls = "tools" in fx ? fx.tools : [fx];
      return send(res, 200, {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: calls.map((c, i) => ({
                id: `call_${i}`,
                type: "function",
                function: { name: c.tool, arguments: "raw_arguments" in c && c.raw_arguments !== undefined ? c.raw_arguments : JSON.stringify(c.args ?? {}) },
              })),
            },
          },
        ],
        usage: { prompt_tokens: 1000, completion_tokens: 20 },
      });
    }

    if (url.pathname === "/google-oauth/token" && req.method === "POST") {
      const form = await readForm(req);
      tokenRequests.push(form);
      if (form.client_secret !== CLIENT_SECRET) return send(res, 401, { error: "invalid_client" });
      if (form.grant_type === "refresh_token") {
        const email = /^rt-(.+)$/.exec(form.refresh_token ?? "")?.[1];
        const acc = email ? googleAccounts.get(email) : undefined;
        if (!acc || acc.revoked) return send(res, 400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
        return send(res, 200, { access_token: `at-${email}~${++accessSeq}`, expires_in: 3599, token_type: "Bearer" });
      }
      const issued = authCodes.get(form.code ?? "");
      if (form.grant_type !== "authorization_code" || !issued || issued.used || !googleAccounts.has(issued.email)) {
        return send(res, 400, { error: "invalid_grant", error_description: "Bad Request" });
      }
      // Как Google: код одноразовый, даже если обмен не удался
      issued.used = true;
      // PKCE: при согласии был challenge — нужен verifier, дающий тот же S256
      if (issued.challenge) {
        const verifier = form.code_verifier ?? "";
        const s256 = createHash("sha256").update(verifier, "ascii").digest("base64url");
        if (issued.method !== "S256" || !verifier || s256 !== issued.challenge) {
          return send(res, 400, { error: "invalid_grant", error_description: verifier ? "Invalid code verifier." : "Missing code verifier." });
        }
      }
      const email = issued.email;
      // Новое согласие — новый действующий доступ
      googleAccounts.get(email)!.revoked = false;
      return send(res, 200, {
        access_token: `at-${email}`,
        refresh_token: `rt-${email}`,
        expires_in: 3599,
        token_type: "Bearer",
        scope: "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly",
      });
    }

    // Как у Google, снимает доступ аккаунта целиком
    if (url.pathname === "/google-oauth/revoke" && req.method === "POST") {
      const { token = "" } = await readForm(req);
      if (revokeFailStatus) {
        revocations.push({ token, status: revokeFailStatus });
        return send(res, revokeFailStatus, { error: "backend_error" });
      }
      const acc = googleAccounts.get(/^(?:rt|at)-([^~]+)/.exec(token)?.[1] ?? "");
      const status = acc && !acc.revoked ? 200 : 400;
      revocations.push({ token, status });
      if (!acc || acc.revoked) return send(res, 400, { error: "invalid_token", error_description: "Token expired or revoked" });
      acc.revoked = true;
      return send(res, 200, {});
    }

    if (url.pathname === "/google/calendar/v3/users/me/calendarList") {
      const account = googleAccountByToken(req);
      if (!account) return send(res, 401, { error: { code: 401, message: "Invalid Credentials" } });
      return send(res, 200, {
        kind: "calendar#calendarList",
        ...googlePage(
          url,
          account.calendars.map(({ events: _e, list_error: _l, list_error_times: _t, shared: _s, ...c }) => c),
        ),
      });
    }
    const watch = /^\/google\/calendar\/v3\/calendars\/([^/]+)\/events\/watch$/.exec(url.pathname);
    if (watch && req.method === "POST") {
      const account = googleAccountByToken(req);
      if (!account) return send(res, 401, { error: { code: 401, message: "Invalid Credentials" } });
      const outage = outages.get("google-watch");
      if (outage) return send(res, outage, { error: { code: outage, message: "fake watch outage" } });
      const calId = decodeURIComponent(watch[1]!);
      if (!account.calendars.some((c) => c.id === calId)) return send(res, 404, { error: { code: 404, message: "Not Found" } });
      const b = (await readJson(req)) as { id: string; type: string; address: string; token?: string; expiration?: number };
      if (b.type !== "web_hook" || !b.id || !b.address) return send(res, 400, { error: { code: 400, message: "bad channel" } });
      const ch = {
        id: b.id,
        address: b.address,
        resourceId: `res-${calId}`,
        calendar: calId,
        ...(b.token ? { token: b.token } : {}),
        ...(b.expiration ? { expiration: Number(b.expiration) } : {}),
      };
      channels.push(ch);
      return send(res, 200, {
        kind: "api#channel",
        id: ch.id,
        resourceId: ch.resourceId,
        resourceUri: `https://www.googleapis.com/calendar/v3/calendars/${calId}/events`,
        ...(ch.expiration ? { expiration: String(ch.expiration) } : {}),
      });
    }
    if (url.pathname === "/google/calendar/v3/channels/stop" && req.method === "POST") {
      if (!googleAccountByToken(req)) return send(res, 401, { error: { code: 401, message: "Invalid Credentials" } });
      const b = (await readJson(req)) as { id: string; resourceId: string };
      const i = channels.findIndex((c) => c.id === b.id && c.resourceId === b.resourceId);
      if (i < 0) return send(res, 404, { error: { code: 404, message: "Channel not found" } });
      channels.splice(i, 1);
      stoppedChannels.push({ id: b.id, resourceId: b.resourceId });
      res.writeHead(204);
      return res.end();
    }
    const evOne = /^\/google\/calendar\/v3\/calendars\/([^/]+)\/events\/([^/]+)$/.exec(url.pathname);
    if (evOne && req.method === "DELETE") {
      const account = googleAccountByToken(req);
      if (!account) return send(res, 401, { error: { code: 401, message: "Invalid Credentials" } });
      const outage = outages.get("google-write");
      if (outage) return googleWriteOutage(res, outage);
      const cal = account.calendars.find((c) => c.id === decodeURIComponent(evOne[1]!));
      const ev = cal?.events?.find((e) => e.id === decodeURIComponent(evOne[2]!));
      if (!cal || !ev || ev.status === "cancelled") return send(res, 410, { error: { code: 410, message: "Resource has been deleted" } });
      if (cal.accessRole !== "owner" && cal.accessRole !== "writer") return send(res, 403, { error: { code: 403, message: "Forbidden" } });
      const ifMatch = req.headers["if-match"];
      if (ifMatch && ifMatch !== ev.etag) return send(res, 412, { error: { code: 412, message: "Precondition Failed" } });
      deletes.push({ calendar: cal.id, id: ev.id, sendUpdates: url.searchParams.get("sendUpdates") });
      // Удаление серии убирает и её экземпляры
      for (const e of cal.events ?? []) {
        if (e.id === ev.id || e.recurringEventId === ev.id) {
          e.status = "cancelled";
          bump(e);
        }
      }
      res.writeHead(204);
      return res.end();
    }
    if (evOne && (req.method === "PATCH" || req.method === "GET")) {
      const account = googleAccountByToken(req);
      if (!account) return send(res, 401, { error: { code: 401, message: "Invalid Credentials" } });
      const cal = account.calendars.find((c) => c.id === decodeURIComponent(evOne[1]!));
      const ev = cal?.events?.find((e) => e.id === decodeURIComponent(evOne[2]!));
      if (!cal || !ev || ev.status === "cancelled") return send(res, 404, { error: { code: 404, message: "Not Found" } });
      if (req.method === "GET") return send(res, 200, publicEvent(ev));
      const outage = outages.get("google-write");
      if (outage) return googleWriteOutage(res, outage);
      if (cal.accessRole !== "owner" && cal.accessRole !== "writer") return send(res, 403, { error: { code: 403, message: "Forbidden" } });
      const ifMatch = req.headers["if-match"];
      if (ifMatch && ifMatch !== ev.etag) return send(res, 412, { error: { code: 412, message: "Precondition Failed" } });
      const body = await readJson(req);
      patches.push({ calendar: cal.id, id: ev.id, sendUpdates: url.searchParams.get("sendUpdates"), body });
      Object.assign(ev, normalizeTimes({ ...ev, ...body } as GoogleEvent, cal.timeZone ?? "UTC"), { etag: newEtag() });
      bump(ev);
      return send(res, 200, publicEvent(ev));
    }

    const evList = /^\/google\/calendar\/v3\/calendars\/([^/]+)\/events$/.exec(url.pathname);
    if (evList && req.method === "POST") {
      const account = googleAccountByToken(req);
      if (!account) return send(res, 401, { error: { code: 401, message: "Invalid Credentials" } });
      const outage = outages.get("google-write");
      if (outage) return googleWriteOutage(res, outage);
      const cal = account.calendars.find((c) => c.id === decodeURIComponent(evList[1]!));
      if (!cal) return send(res, 404, { error: { code: 404, message: "Not Found" } });
      if (cal.accessRole !== "owner" && cal.accessRole !== "writer") return send(res, 403, { error: { code: 403, message: "Forbidden" } });
      const input = (await readJson(req)) as unknown as GoogleEvent;
      // Свой id клиента (идемпотентность): повтор → 409, как у Google
      if (input.id && cal.events?.some((e) => e.id === input.id))
        return send(res, 409, { error: { code: 409, message: "The requested identifier already exists." } });
      const id = input.id ?? `new${nextEventId++}`;
      const ev = normalizeTimes(
        { ...input, id, status: "confirmed", etag: newEtag(), htmlLink: `https://calendar.google.com/event?eid=${id}` },
        cal.timeZone ?? "UTC",
      );
      bump(ev);
      cal.events ??= [];
      cal.events.push(ev);
      return send(res, 200, publicEvent(ev));
    }
    if (evList && req.method === "GET") {
      const account = googleAccountByToken(req);
      if (!account) return send(res, 401, { error: { code: 401, message: "Invalid Credentials" } });
      const cal = account.calendars.find((c) => c.id === decodeURIComponent(evList[1]!));
      if (!cal) return send(res, 404, { error: { code: 404, message: "Not Found" } });
      if (cal.list_error) return send(res, cal.list_error, { error: { code: cal.list_error, message: "fake calendar error" } });
      if (cal.list_error_times) {
        cal.list_error_times--;
        return send(res, 503, { error: { code: 503, message: "fake transient error" } });
      }
      // Как у Google: окно и порядок вместе с syncToken не принимаются
      const syncToken = url.searchParams.get("syncToken");
      if (syncToken) {
        if (["timeMin", "timeMax", "orderBy", "updatedMin", "q"].some((k) => url.searchParams.has(k)))
          return send(res, 400, { error: { code: 400, message: "syncToken cannot be combined with these parameters" } });
        const m = /^st:(.+):(\d+):(\d+)$/.exec(syncToken);
        if (!m || m[1] !== cal.id) return send(res, 400, { error: { code: 400, message: "Invalid sync token" } });
        const since = Number(m[2]);
        if (Number(m[3]) !== (syncTokenGen.get(cal.id) ?? 0)) {
          syncRequests.push({ calendar: cal.id, mode: "expired" });
          return send(res, 410, { error: { code: 410, message: "Sync token is no longer valid, a full sync is required." } });
        }
        if (!url.searchParams.has("pageToken")) syncRequests.push({ calendar: cal.id, mode: "incremental" });
        const page = googlePage(url, (cal.events ?? []).filter((e) => (e._seq as number) > since).map(publicEvent));
        return send(res, 200, { kind: "calendar#events", ...page, ...(page.nextPageToken ? {} : { nextSyncToken: syncTokenOf(cal.id) }) });
      }
      // Без orderBy — полный список синхронизации (чтение расписания ботом всегда с orderBy=startTime)
      if (!url.searchParams.has("orderBy") && !url.searchParams.has("pageToken")) syncRequests.push({ calendar: cal.id, mode: "full" });
      const tz = url.searchParams.get("timeZone") ?? cal.timeZone ?? "UTC";
      const min = Date.parse(url.searchParams.get("timeMin") ?? "1970-01-01T00:00:00Z");
      const max = Date.parse(url.searchParams.get("timeMax") ?? "2100-01-01T00:00:00Z");
      const items = (cal.events ?? [])
        .filter((e) => e.status !== "cancelled")
        .filter((e) => {
          const [s, en] = eventBounds(e, tz);
          return s < max && en > min;
        })
        .sort((a, b) => eventBounds(a, tz)[0] - eventBounds(b, tz)[0]);
      // Как у Google: полный список — с токеном для следующих инкрементальных запросов
      const page = googlePage(url, items.map(publicEvent));
      return send(res, 200, { kind: "calendar#events", timeZone: tz, ...page, ...(page.nextPageToken ? {} : { nextSyncToken: syncTokenOf(cal.id) }) });
    }

    const tg = /^\/telegram\/bot([^/]+)\/(\w+)$/.exec(url.pathname);
    if (tg) {
      const body = await readJson(req);
      const failure = telegramFailures.find((f) => f.times > 0 && f.method === tg[2] && String(body.text ?? "").includes(f.text));
      if (failure) {
        failure.times--;
        return send(res, failure.status, { ok: false, error_code: failure.status, description: "fake telegram failure" });
      }
      const result = telegramResult(tg[2]!, body);
      const messageId = (result as { message_id?: number }).message_id;
      telegramCalls.push({ token: tg[1]!, method: tg[2]!, body, ...(messageId ? { messageId } : {}) });
      return send(res, 200, { ok: true, result });
    }

    return send(res, 501, { ok: false, description: `fake: not implemented ${req.method} ${url.pathname}` });
  } catch (e) {
    return send(res, 500, { ok: false, description: String(e) });
  }
});

const port = Number(process.env.PORT ?? 9100);
server.listen(port, () => console.log(`fakes listening on :${port}`));
