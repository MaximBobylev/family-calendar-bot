// Фейки внешних API для приёмочных тестов (ADR-0006). Не импортирует код бота.
//
//   /telegram/bot<token>/<method>   — фейк Telegram Bot API: запоминает вызовы, отвечает успехом
//   /google/…, /google-oauth/…      — фейк Google (появится вместе с OAuth и календарём)
//
// Управление для раннера:
//   GET  /__fake/telegram/calls     — все вызовы Telegram с последнего сброса
//   POST /__fake/reset              — сброс состояния

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

interface TelegramCall {
  method: string;
  token: string;
  body: Record<string, unknown>;
}

let telegramCalls: TelegramCall[] = [];
let nextMessageId = 1;

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
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/__fake/telegram/calls") return send(res, 200, telegramCalls);

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
