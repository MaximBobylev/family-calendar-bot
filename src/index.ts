// Точка входа Worker'а: HTTP (webhook Telegram, тестовые маршруты), очередь inbox, cron.
// Тип Env генерируется из wrangler.jsonc (`npm run types`), секреты — в src/env.d.ts.

import { createContext, type AppContext } from "./bot/context";
import { resolveClock } from "./clock";
import { loadConfig } from "./config";
import { acceptUpdate, type InboxMessage } from "./inbox";
import { processInboxUpdate } from "./process";
import { tick } from "./scheduler";
import type { TgUpdate } from "./telegram/types";
import { handleOAuthRoute } from "./oauth-routes";
import { handlePage } from "./pages";
import { handleTestRoute } from "./testing/routes";

async function context(env: Env): Promise<AppContext> {
  const config = loadConfig(env);
  return createContext(env, config, await resolveClock(env.DB, config.testMode));
}

/** Если обработка в waitUntil оборвалась — очередь доделает апдейт позже (claim атомарный, дублей нет). */
const SAFETY_NET_DELAY_S = 60;

async function telegramWebhook(ctx: AppContext, env: Env, request: Request, exec: ExecutionContext): Promise<Response> {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (request.headers.get("x-telegram-bot-api-secret-token") !== ctx.config.telegramWebhookSecret) {
    return new Response("Forbidden", { status: 403 });
  }
  const update = (await request.json()) as TgUpdate;
  if (typeof update.update_id !== "number") return new Response("Bad request", { status: 400 });

  // Сохранить и сразу ответить 200 (ADR-0005 п.1). Обрабатываем тут же после ответа (waitUntil) —
  // очередь Cloudflare добавляет секунды задержки; она остаётся страховкой на случай обрыва.
  // В TEST_MODE обработку запускает тест через /__test/drain — детерминированно.
  if ((await acceptUpdate(ctx.db, update, ctx.clock.now())) && !ctx.config.testMode) {
    await env.INBOX.send({ updateId: update.update_id } satisfies InboxMessage, { delaySeconds: SAFETY_NET_DELAY_S });
    exec.waitUntil(processInboxUpdate(ctx, update.update_id).catch((e) => console.error("update failed", update.update_id, e)));
  }
  return new Response("ok");
}

export default {
  async fetch(request, env, exec): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    if (request.method === "GET") {
      const page = handlePage(url);
      if (page) return page;
    }

    const ctx = await context(env);
    if (url.pathname === "/telegram/webhook") return telegramWebhook(ctx, env, request, exec);
    if (url.pathname.startsWith("/oauth/")) return handleOAuthRoute(ctx, request, url);
    if (ctx.config.testMode && url.pathname.startsWith("/__test/")) return handleTestRoute(ctx, request, url.pathname);
    return new Response("Not found", { status: 404 });
  },

  async queue(batch, env): Promise<void> {
    const ctx = await context(env);
    for (const msg of batch.messages) {
      try {
        await processInboxUpdate(ctx, msg.body.updateId);
        msg.ack();
      } catch (e) {
        console.error("update failed", msg.body.updateId, e);
        msg.retry();
      }
    }
  },

  async scheduled(_controller, env): Promise<void> {
    const ctx = await context(env);
    await tick(ctx.db, ctx.clock.now());
  },
} satisfies ExportedHandler<Env, InboxMessage>;
