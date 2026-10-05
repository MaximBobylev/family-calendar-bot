// Точка входа Worker'а: HTTP (webhook Telegram, тестовые маршруты), очередь inbox, cron.
// Тип Env генерируется из wrangler.jsonc (`npm run types`), секреты — в src/env.d.ts.

import { createContext, type AppContext } from "./bot/context";
import { resolveClock } from "./clock";
import { loadConfig } from "./config";
import { acceptUpdate, isUnfinished, type InboxMessage } from "./inbox";
import { gateUpdate, replyToOutsider } from "./bot/gate";
import { processInboxUpdate } from "./process";
import { cleanup, tick } from "./scheduler";
import type { TgUpdate } from "./telegram/types";
import { handleOAuthRoute } from "./oauth-routes";
import { adminPage, checkAdminAuth, timingSafeEqual } from "./admin";
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
  if (!timingSafeEqual(request.headers.get("x-telegram-bot-api-secret-token") ?? "", ctx.config.telegramWebhookSecret)) {
    return new Response("Forbidden", { status: 403 });
  }
  const update = (await request.json().catch(() => null)) as TgUpdate | null;
  if (!update || typeof update.update_id !== "number") return new Response("Bad request", { status: 400 });

  // Посторонние и группы — ответ сразу, без записи в D1 и очереди: спам не тратит квоты (ревью 2026-10-05)
  const gate = gateUpdate(ctx, update);
  if (gate !== "process") {
    const reply = replyToOutsider(ctx, update, gate);
    if (ctx.config.testMode) await reply;
    else exec.waitUntil(reply);
    return new Response("ok");
  }

  // Сохранить и сразу ответить 200 (ADR-0005 п.1). Обрабатываем тут же после ответа (waitUntil) —
  // очередь Cloudflare добавляет секунды задержки; она остаётся страховкой на случай обрыва.
  // В TEST_MODE обработку запускает тест через /__test/drain — детерминированно.
  const accepted = await acceptUpdate(ctx.db, update, ctx.clock.now());
  if (!ctx.config.testMode && (accepted || (await isUnfinished(ctx.db, update.update_id)))) {
    try {
      await env.INBOX.send({ updateId: update.update_id } satisfies InboxMessage, { delaySeconds: SAFETY_NET_DELAY_S });
    } catch (e) {
      // Очередь недоступна или квота исчерпана — всё равно обрабатываем сейчас
      console.error("inbox send failed", update.update_id, e);
    }
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
    if (url.pathname === "/admin" && request.method === "GET") {
      if (!checkAdminAuth(request, ctx.config.admin.user, ctx.config.admin.password)) {
        return new Response("Unauthorized", { status: 401, headers: { "www-authenticate": 'Basic realm="admin", charset="UTF-8"' } });
      }
      return adminPage(ctx);
    }
    // Fail-closed: тестовые маршруты никогда не работают на публичном https-адресе
    if (ctx.config.testMode && !ctx.config.publicBaseUrl.startsWith("https://") && url.pathname.startsWith("/__test/")) {
      return handleTestRoute(ctx, request, url.pathname);
    }
    return new Response("Not found", { status: 404 });
  },

  async queue(batch, env): Promise<void> {
    const ctx = await context(env);
    for (const msg of batch.messages) {
      try {
        const outcome = await processInboxUpdate(ctx, msg.body.updateId);
        // Ещё обрабатывается (waitUntil жив) — проверим позже, а не теряем молча (ревью 2026-10-05)
        if (outcome === "busy") msg.retry({ delaySeconds: SAFETY_NET_DELAY_S });
        else msg.ack();
      } catch (e) {
        console.error("update failed", msg.body.updateId, e);
        msg.retry({ delaySeconds: Math.min(600, 30 * 2 ** msg.attempts) });
      }
    }
  },

  async scheduled(_controller, env): Promise<void> {
    const ctx = await context(env);
    await tick(ctx.db, ctx.clock.now());
    // Ретеншн раз в час (privacy-политика, ADR-0005)
    if (new Date(ctx.clock.now()).getUTCMinutes() === 7) await cleanup(ctx.db, ctx.clock.now());
  },
} satisfies ExportedHandler<Env, InboxMessage>;
