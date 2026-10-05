// Фейки внешних API для приёмочных тестов (ADR-0006). Не импортирует код бота.
//
//   /telegram/bot<token>/<method>   — фейк Telegram Bot API: запоминает вызовы, отвечает успехом
//   /google-oauth/token             — обмен кода на токены: код выдан /__fake/google/authorize, одноразовый;
//                                     был code_challenge — нужен верный code_verifier (PKCE S256), иначе invalid_grant
//   /google/calendar/v3/…           — фейк Google Calendar API (токен = "at-<email>")
//   /llm/v1/chat/completions        — фейк LLM: ответ берётся из фикстур по тексту пользователя
//   /llm-backup/v1/chat/completions — запасной провайдер LLM: те же фикстуры (цепочка провайдеров)
//   /stt/run/<model>                — фейк Whisper (Workers AI REST): ответ по содержимому аудио
//   /stt-openai/audio/transcriptions — фейк OpenAI-совместимого STT (Groq), multipart: те же фикстуры
//   /gemini/v1beta/models/<m>:generateContent — фейк мультимодального разбора голоса: ответ по содержимому аудио
//   /telegram/file/bot<t>/<path>    — файлы Telegram (голосовые)
//
// Управление для раннера:
//   GET  /__fake/telegram/calls     — все вызовы Telegram с последнего сброса
//   POST /__fake/google/accounts    — завести Google-аккаунт: {email, calendars: [...]}
//   POST /__fake/google/authorize   — «согласие на экране Google»: {email, code_challenge?, code_challenge_method?} → {code}
//   GET  /__fake/google/token-requests — все запросы обмена кода (для проверки параметров)
//   POST /__fake/google/revoke      — отозвать доступ аккаунта: {email}
//   POST /__fake/llm/fixtures       — {"<текст>": {tool, args} | {tools: [...]} | {error: status}}
//   GET  /__fake/llm/requests       — все запросы к LLM
//   POST /__fake/telegram/files     — {file_id, content}: файл для getFile и скачивания
//   POST /__fake/stt/fixtures       — {"<содержимое аудио>": {text} | {error: status}}
//   GET  /__fake/google/patches     — журнал PATCH событий: {calendar, id, sendUpdates, body}
//   GET  /__fake/google/deletes     — журнал DELETE событий: {calendar, id, sendUpdates}
//   POST /__fake/google/touch       — {email, calendar, id}: «кто-то другой» изменил событие (новый etag)
//   GET  /__fake/google/events?email=… — календари аккаунта с событиями (для проверок)
//   Календарь с полем list_error: <status> — events.list по нему отвечает этой ошибкой
//   GET  /__fake/google/revocations — журнал отзывов токена через /google-oauth/revoke: {token, status}
//   POST /__fake/google/revoke-fails — {status}: отзыв токена отвечает этой ошибкой (0 — снова работает)
//   POST /__fake/outage             — {provider: llm | llm-backup | stt | stt-openai, status}: провайдер отвечает
//                                     этой ошибкой (0 — снова работает); проверка переключения на запасной
//   GET  /__fake/stt/requests       — какой провайдер STT вызывался: [{via}]
//   POST /__fake/voice/fixtures     — {"<содержимое аудио>": {transcript, tool, args} | {no_speech: true} | {error: status}}
//   GET  /__fake/voice/requests     — запросы мультимодального разбора: [{content}]
//   POST /__fake/reset              — сброс состояния

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

interface TelegramCall {
  method: string;
  token: string;
  body: Record<string, unknown>;
  /** message_id, который фейк выдал отправленному сообщению. */
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
  summary: string;
  accessRole: string;
  primary?: boolean;
  timeZone?: string;
  events?: GoogleEvent[];
  /** events.list этого календаря отвечает этой ошибкой (удалён, нет доступа, 5xx). */
  list_error?: number;
}

type LlmFixture =
  /** raw_arguments — строка аргументов как есть (для имитации битого JSON). */
  { tool: string; args?: Record<string, unknown>; raw_arguments?: string } | { tools: { tool: string; args?: Record<string, unknown> }[] } | { error: number };

const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? "test-client-secret";

let telegramCalls: TelegramCall[] = [];
let nextMessageId = 1;
let googleAccounts = new Map<string, { calendars: GoogleCalendar[]; revoked?: boolean }>();
let tokenRequests: Record<string, string>[] = [];
/** Выданные коды авторизации: кому и с каким code_challenge (PKCE). */
let authCodes = new Map<string, { email: string; challenge?: string; method?: string; used: boolean }>();
let authCodeSeq = 1;
let llmFixtures = new Map<string, LlmFixture>();
let telegramFiles = new Map<string, string>();
let sttFixtures = new Map<string, { text?: string; error?: number }>();
let llmRequests: unknown[] = [];
let sttRequests: { via: string }[] = [];
let voiceFixtures = new Map<string, { transcript?: string; tool?: string; args?: Record<string, unknown>; no_speech?: boolean; error?: number }>();
let voiceRequests: { content: string }[] = [];
/** Провайдер → статус ошибки, которой он сейчас отвечает (POST /__fake/outage). */
let outages = new Map<string, number>();
let revocations: { token: string; status: number }[] = [];
let revokeFailStatus = 0;

/** Полночь даты `date` в поясе `tz`, мс UTC — для событий на весь день. */
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

/** Локальное «2026-10-08T15:00:00» в поясе tz → мс UTC. */
function zonedToUtc(local: string, tz: string): number {
  const [date, time] = local.split("T");
  const [h, m] = (time ?? "00:00").split(":").map(Number);
  return zonedMidnight(date!, tz) + (h! * 60 + m!) * 60_000;
}

/** Приводит время события к виду, который вернул бы Google: dateTime со смещением (здесь — в UTC). */
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
  const token = /^Bearer at-(.+)$/.exec(req.headers.authorization ?? "")?.[1];
  return token ? googleAccounts.get(token) : undefined;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
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
    // Админка: панель «здоровье» (webhook установлен на SUT, очередь пуста)
    case "getWebhookInfo":
      return { url: "http://dev:8787/telegram/webhook", has_custom_certificate: false, pending_update_count: 0 };
    default:
      return true;
  }
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
      outages = new Map();
      telegramFiles = new Map();
      sttFixtures = new Map();
      nextEventId = 1;
      etagSeq = 1;
      patches = [];
      deletes = [];
      revocations = [];
      revokeFailStatus = 0;
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/__fake/telegram/calls") return send(res, 200, telegramCalls);
    if (url.pathname === "/__fake/google/accounts" && req.method === "POST") {
      const body = (await readJson(req)) as { email: string; calendars: GoogleCalendar[] };
      for (const c of body.calendars) for (const e of c.events ?? []) e.etag ??= newEtag();
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

    // --- Мультимодальный разбор голоса (Gemini generateContent): аудио → transcript + functionCall ---
    if (/^\/gemini\/v1beta\/models\/[^/]+:generateContent$/.test(url.pathname) && req.method === "POST") {
      const outage = outages.get("gemini");
      if (outage) return send(res, outage, { error: { code: outage, message: "fake outage" } });
      const body = (await readJson(req)) as { contents?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] }[] };
      const part = body.contents?.[0]?.parts?.find((p) => p.inlineData);
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

    // --- STT, OpenAI-совместимый (Groq): multipart, аудио — файл в поле file ---
    if (url.pathname === "/stt-openai/audio/transcriptions" && req.method === "POST") {
      sttRequests.push({ via: "stt-openai" });
      const outage = outages.get("stt-openai");
      if (outage) return send(res, outage, { error: { message: "fake outage" } });
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!/name="model"/.test(raw) || !/filename="voice\.ogg"/.test(raw))
        return send(res, 400, { error: { message: "fake stt: expected multipart with file and model" } });
      // Содержимое «аудио» в тестах — короткая строка; ищем фикстуру, чей ключ есть в теле
      const entry = [...sttFixtures.entries()].find(([content]) => raw.includes(`\r\n\r\n${content}\r\n`));
      if (!entry) return send(res, 400, { error: { message: "fake stt: no fixture for the uploaded file" } });
      const fx = entry[1];
      if (fx.error) return send(res, fx.error, { error: { message: "fake stt error" } });
      return send(res, 200, { text: fx.text ?? "", language: "russian", duration: 3 });
    }

    // --- Whisper (Workers AI REST) ---
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

    // --- Файлы Telegram ---
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
      if (ev) ev.etag = newEtag();
      return send(res, 200, { ok: !!ev });
    }
    if (url.pathname === "/__fake/google/events") {
      const acc = googleAccounts.get(url.searchParams.get("email") ?? "");
      return send(res, 200, acc?.calendars ?? []);
    }

    // --- LLM (OpenAI-совместимый) ---
    const llmPath = /^\/(llm|llm-backup)\/v1\/chat\/completions$/.exec(url.pathname);
    if (llmPath && req.method === "POST") {
      const via = llmPath[1]!;
      const body = (await readJson(req)) as { messages?: { role: string; content: string }[] };
      llmRequests.push({ ...body, _via: via });
      const outage = outages.get(via);
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

    // --- Google OAuth ---
    if (url.pathname === "/google-oauth/token" && req.method === "POST") {
      const form = await readForm(req);
      tokenRequests.push(form);
      if (form.client_secret !== CLIENT_SECRET) return send(res, 401, { error: "invalid_client" });
      if (form.grant_type === "refresh_token") {
        const email = /^rt-(.+)$/.exec(form.refresh_token ?? "")?.[1];
        const acc = email ? googleAccounts.get(email) : undefined;
        if (!acc || acc.revoked) return send(res, 400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
        return send(res, 200, { access_token: `at-${email}`, expires_in: 3599, token_type: "Bearer" });
      }
      const issued = authCodes.get(form.code ?? "");
      if (form.grant_type !== "authorization_code" || !issued || issued.used || !googleAccounts.has(issued.email)) {
        return send(res, 400, { error: "invalid_grant", error_description: "Bad Request" });
      }
      // Как Google: код одноразовый, даже если обмен не удался
      issued.used = true;
      // PKCE (RFC 7636): при согласии был challenge — нужен verifier, дающий тот же S256
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

    // Отзыв токена (как oauth2.googleapis.com/revoke): снимает доступ аккаунта целиком
    if (url.pathname === "/google-oauth/revoke" && req.method === "POST") {
      const { token = "" } = await readForm(req);
      if (revokeFailStatus) {
        revocations.push({ token, status: revokeFailStatus });
        return send(res, revokeFailStatus, { error: "backend_error" });
      }
      const acc = googleAccounts.get(/^(?:rt|at)-(.+)$/.exec(token)?.[1] ?? "");
      const status = acc && !acc.revoked ? 200 : 400;
      revocations.push({ token, status });
      if (!acc || acc.revoked) return send(res, 400, { error: "invalid_token", error_description: "Token expired or revoked" });
      acc.revoked = true;
      return send(res, 200, {});
    }

    // --- Google Calendar API ---
    if (url.pathname === "/google/calendar/v3/users/me/calendarList") {
      const account = googleAccountByToken(req);
      if (!account) return send(res, 401, { error: { code: 401, message: "Invalid Credentials" } });
      return send(res, 200, { kind: "calendar#calendarList", items: account.calendars.map(({ events: _e, list_error: _l, ...c }) => c) });
    }
    const evOne = /^\/google\/calendar\/v3\/calendars\/([^/]+)\/events\/([^/]+)$/.exec(url.pathname);
    if (evOne && req.method === "DELETE") {
      const account = googleAccountByToken(req);
      if (!account) return send(res, 401, { error: { code: 401, message: "Invalid Credentials" } });
      const cal = account.calendars.find((c) => c.id === decodeURIComponent(evOne[1]!));
      const ev = cal?.events?.find((e) => e.id === decodeURIComponent(evOne[2]!));
      if (!cal || !ev || ev.status === "cancelled") return send(res, 410, { error: { code: 410, message: "Resource has been deleted" } });
      if (cal.accessRole !== "owner" && cal.accessRole !== "writer") return send(res, 403, { error: { code: 403, message: "Forbidden" } });
      const ifMatch = req.headers["if-match"];
      if (ifMatch && ifMatch !== ev.etag) return send(res, 412, { error: { code: 412, message: "Precondition Failed" } });
      deletes.push({ calendar: cal.id, id: ev.id, sendUpdates: url.searchParams.get("sendUpdates") });
      // Удаление серии убирает и её экземпляры
      for (const e of cal.events ?? []) if (e.id === ev.id || e.recurringEventId === ev.id) e.status = "cancelled";
      res.writeHead(204);
      return res.end();
    }
    if (evOne && (req.method === "PATCH" || req.method === "GET")) {
      const account = googleAccountByToken(req);
      if (!account) return send(res, 401, { error: { code: 401, message: "Invalid Credentials" } });
      const cal = account.calendars.find((c) => c.id === decodeURIComponent(evOne[1]!));
      const ev = cal?.events?.find((e) => e.id === decodeURIComponent(evOne[2]!));
      if (!cal || !ev || ev.status === "cancelled") return send(res, 404, { error: { code: 404, message: "Not Found" } });
      if (req.method === "GET") return send(res, 200, ev);
      if (cal.accessRole !== "owner" && cal.accessRole !== "writer") return send(res, 403, { error: { code: 403, message: "Forbidden" } });
      const ifMatch = req.headers["if-match"];
      if (ifMatch && ifMatch !== ev.etag) return send(res, 412, { error: { code: 412, message: "Precondition Failed" } });
      const body = await readJson(req);
      patches.push({ calendar: cal.id, id: ev.id, sendUpdates: url.searchParams.get("sendUpdates"), body });
      Object.assign(ev, normalizeTimes({ ...ev, ...body } as GoogleEvent, cal.timeZone ?? "UTC"), { etag: newEtag() });
      return send(res, 200, ev);
    }

    const evList = /^\/google\/calendar\/v3\/calendars\/([^/]+)\/events$/.exec(url.pathname);
    if (evList && req.method === "POST") {
      const account = googleAccountByToken(req);
      if (!account) return send(res, 401, { error: { code: 401, message: "Invalid Credentials" } });
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
      cal.events ??= [];
      cal.events.push(ev);
      return send(res, 200, ev);
    }
    if (evList && req.method === "GET") {
      const account = googleAccountByToken(req);
      if (!account) return send(res, 401, { error: { code: 401, message: "Invalid Credentials" } });
      const cal = account.calendars.find((c) => c.id === decodeURIComponent(evList[1]!));
      if (!cal) return send(res, 404, { error: { code: 404, message: "Not Found" } });
      if (cal.list_error) return send(res, cal.list_error, { error: { code: cal.list_error, message: "fake calendar error" } });
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
      return send(res, 200, { kind: "calendar#events", timeZone: tz, items });
    }

    const tg = /^\/telegram\/bot([^/]+)\/(\w+)$/.exec(url.pathname);
    if (tg) {
      const body = await readJson(req);
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
