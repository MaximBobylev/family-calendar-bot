// Фейки внешних API для приёмочных тестов (ADR-0006). Не импортирует код бота.
//
//   /telegram/bot<token>/<method>   — фейк Telegram Bot API: запоминает вызовы, отвечает успехом
//   /google-oauth/token             — обмен кода на токены (код = "code-<email>")
//   /google/calendar/v3/…           — фейк Google Calendar API (токен = "at-<email>")
//
// Управление для раннера:
//   GET  /__fake/telegram/calls     — все вызовы Telegram с последнего сброса
//   POST /__fake/google/accounts    — завести Google-аккаунт: {email, calendars: [...]}
//   GET  /__fake/google/token-requests — все запросы обмена кода (для проверки параметров)
//   POST /__fake/reset              — сброс состояния

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

interface TelegramCall {
  method: string;
  token: string;
  body: Record<string, unknown>;
}

interface GoogleCalendar {
  id: string;
  summary: string;
  accessRole: string;
  primary?: boolean;
  timeZone?: string;
}

const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? "test-client-secret";

let telegramCalls: TelegramCall[] = [];
let nextMessageId = 1;
let googleAccounts = new Map<string, { calendars: GoogleCalendar[] }>();
let tokenRequests: Record<string, string>[] = [];

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
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/__fake/telegram/calls") return send(res, 200, telegramCalls);
    if (url.pathname === "/__fake/google/accounts" && req.method === "POST") {
      const body = (await readJson(req)) as { email: string; calendars: GoogleCalendar[] };
      googleAccounts.set(body.email, { calendars: body.calendars });
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/__fake/google/token-requests") return send(res, 200, tokenRequests);

    // --- Google OAuth ---
    if (url.pathname === "/google-oauth/token" && req.method === "POST") {
      const form = await readForm(req);
      tokenRequests.push(form);
      if (form.client_secret !== CLIENT_SECRET) return send(res, 401, { error: "invalid_client" });
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
      return send(res, 200, { kind: "calendar#calendarList", items: account.calendars });
    }

    const tg = /^\/telegram\/bot([^/]+)\/(\w+)$/.exec(url.pathname);
    if (tg) {
      const body = await readJson(req);
      telegramCalls.push({ token: tg[1]!, method: tg[2]!, body });
      return send(res, 200, { ok: true, result: telegramResult(tg[2]!, body) });
    }

    return send(res, 501, { ok: false, description: `fake: not implemented ${req.method} ${url.pathname}` });
  } catch (e) {
    return send(res, 500, { ok: false, description: String(e) });
  }
});

const port = Number(process.env.PORT ?? 9100);
server.listen(port, () => console.log(`fakes listening on :${port}`));
