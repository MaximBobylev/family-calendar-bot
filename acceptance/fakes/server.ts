// Фейки внешних API для приёмочных тестов (ADR-0006). Не импортирует код бота.
//
//   /telegram/bot<token>/<method>   — фейк Telegram Bot API: запоминает вызовы, отвечает успехом
//   /google-oauth/token             — обмен кода на токены (код = "code-<email>")
//   /google/calendar/v3/…           — фейк Google Calendar API (токен = "at-<email>")
//   /llm/v1/chat/completions        — фейк LLM: ответ берётся из фикстур по тексту пользователя
//
// Управление для раннера:
//   GET  /__fake/telegram/calls     — все вызовы Telegram с последнего сброса
//   POST /__fake/google/accounts    — завести Google-аккаунт: {email, calendars: [...]}
//   GET  /__fake/google/token-requests — все запросы обмена кода (для проверки параметров)
//   POST /__fake/google/revoke      — отозвать доступ аккаунта: {email}
//   POST /__fake/llm/fixtures       — {"<текст>": {tool, args} | {tools: [...]} | {error: status}}
//   GET  /__fake/llm/requests       — все запросы к LLM
//   GET  /__fake/google/events?email=… — календари аккаунта с событиями (для проверок)
//   POST /__fake/reset              — сброс состояния

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
}

type LlmFixture =
  /** raw_arguments — строка аргументов как есть (для имитации битого JSON). */
  | { tool: string; args?: Record<string, unknown>; raw_arguments?: string }
  | { tools: { tool: string; args?: Record<string, unknown> }[] }
  | { error: number };

const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? "test-client-secret";

let telegramCalls: TelegramCall[] = [];
let nextMessageId = 1;
let googleAccounts = new Map<string, { calendars: GoogleCalendar[]; revoked?: boolean }>();
let tokenRequests: Record<string, string>[] = [];
let llmFixtures = new Map<string, LlmFixture>();
let llmRequests: unknown[] = [];

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
    t?.dateTime && !/[zZ]|[+-]\d\d:\d\d$/.test(t.dateTime)
      ? { ...t, dateTime: new Date(zonedToUtc(t.dateTime, t.timeZone ?? tz)).toISOString() }
      : t;
  return { ...e, start: fix(e.start)!, end: fix(e.end)! };
}

let nextEventId = 1;

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
    case "sendMessage":
      return { message_id: nextMessageId++, date: 0, chat: { id: body.chat_id, type: "private" }, text: body.text };
    case "editMessageText":
      return true;
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
      llmFixtures = new Map();
      llmRequests = [];
      nextEventId = 1;
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/__fake/telegram/calls") return send(res, 200, telegramCalls);
    if (url.pathname === "/__fake/google/accounts" && req.method === "POST") {
      const body = (await readJson(req)) as { email: string; calendars: GoogleCalendar[] };
      googleAccounts.set(body.email, { calendars: body.calendars });
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/__fake/google/token-requests") return send(res, 200, tokenRequests);
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
    if (url.pathname === "/__fake/google/events") {
      const acc = googleAccounts.get(url.searchParams.get("email") ?? "");
      return send(res, 200, acc?.calendars ?? []);
    }

    // --- LLM (OpenAI-совместимый) ---
    if (url.pathname === "/llm/v1/chat/completions" && req.method === "POST") {
      const body = (await readJson(req)) as { messages?: { role: string; content: string }[] };
      llmRequests.push(body);
      const text = [...(body.messages ?? [])].reverse().find((m) => m.role === "user")?.content ?? "";
      const fx = llmFixtures.get(text);
      if (!fx) return send(res, 400, { error: `fake llm: no fixture for «${text}»` });
      if ("error" in fx) return send(res, fx.error, { error: "fake llm error" });
      const calls = "tools" in fx ? fx.tools : [fx];
      return send(res, 200, {
        choices: [{ message: { role: "assistant", content: null, tool_calls: calls.map((c, i) => ({ id: `call_${i}`, type: "function", function: { name: c.tool, arguments: "raw_arguments" in c && c.raw_arguments !== undefined ? c.raw_arguments : JSON.stringify(c.args ?? {}) } })) } }],
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
      const email = /^code-(.+)$/.exec(form.code ?? "")?.[1];
      if (form.grant_type !== "authorization_code" || !email || !googleAccounts.has(email)) {
        return send(res, 400, { error: "invalid_grant" });
      }
      return send(res, 200, {
        access_token: `at-${email}`,
        refresh_token: `rt-${email}`,
        expires_in: 3599,
        token_type: "Bearer",
        scope: "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly",
      });
    }

    // --- Google Calendar API ---
    if (url.pathname === "/google/calendar/v3/users/me/calendarList") {
      const account = googleAccountByToken(req);
      if (!account) return send(res, 401, { error: { code: 401, message: "Invalid Credentials" } });
      return send(res, 200, { kind: "calendar#calendarList", items: account.calendars.map(({ events: _e, ...c }) => c) });
    }
    const evOne = /^\/google\/calendar\/v3\/calendars\/([^/]+)\/events\/([^/]+)$/.exec(url.pathname);
    if (evOne && req.method === "PATCH") {
      const account = googleAccountByToken(req);
      if (!account) return send(res, 401, { error: { code: 401, message: "Invalid Credentials" } });
      const cal = account.calendars.find((c) => c.id === decodeURIComponent(evOne[1]!));
      const ev = cal?.events?.find((e) => e.id === decodeURIComponent(evOne[2]!));
      if (!cal || !ev) return send(res, 404, { error: { code: 404, message: "Not Found" } });
      if (cal.accessRole !== "owner" && cal.accessRole !== "writer") return send(res, 403, { error: { code: 403, message: "Forbidden" } });
      Object.assign(ev, normalizeTimes({ ...ev, ...(await readJson(req)) } as GoogleEvent, cal.timeZone ?? "UTC"));
      return send(res, 200, ev);
    }

    const evList = /^\/google\/calendar\/v3\/calendars\/([^/]+)\/events$/.exec(url.pathname);
    if (evList && req.method === "POST") {
      const account = googleAccountByToken(req);
      if (!account) return send(res, 401, { error: { code: 401, message: "Invalid Credentials" } });
      const cal = account.calendars.find((c) => c.id === decodeURIComponent(evList[1]!));
      if (!cal) return send(res, 404, { error: { code: 404, message: "Not Found" } });
      if (cal.accessRole !== "owner" && cal.accessRole !== "writer") return send(res, 403, { error: { code: 403, message: "Forbidden" } });
      const id = `new${nextEventId++}`;
      const input = (await readJson(req)) as unknown as GoogleEvent;
      const ev = normalizeTimes({ ...input, id, status: "confirmed", htmlLink: `https://calendar.google.com/event?eid=${id}` }, cal.timeZone ?? "UTC");
      (cal.events ??= []).push(ev);
      return send(res, 200, ev);
    }
    if (evList && req.method === "GET") {
      const account = googleAccountByToken(req);
      if (!account) return send(res, 401, { error: { code: 401, message: "Invalid Credentials" } });
      const cal = account.calendars.find((c) => c.id === decodeURIComponent(evList[1]!));
      if (!cal) return send(res, 404, { error: { code: 404, message: "Not Found" } });
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
