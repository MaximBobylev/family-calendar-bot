// Только ставим задачу синка и сразу отвечаем 200 — тяжёлой работы в запросе Google нет. Состояние «sync» —
// подтверждение открытия канала, не изменение.

import type { AppContext } from "../bot/context";
import { timingSafeEqual } from "../crypto";
import { syncRowByChannel } from "../db/sync";
import { log } from "../log";
import { enqueuePushSync } from "./engine";

// Без sendJob задачу заберёт ближайший cron.
export async function handleGooglePush(ctx: AppContext, request: Request, sendJob?: (jobId: string) => Promise<void>): Promise<Response> {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const channelId = request.headers.get("x-goog-channel-id") ?? "";
  const state = request.headers.get("x-goog-resource-state") ?? "";
  const row = channelId ? await syncRowByChannel(ctx.db, channelId) : null;
  // Неизвестный канал (заменён при продлении, календарь отключён) — 404: Google не повторяет
  if (!row) return new Response("Unknown channel", { status: 404 });
  if (!row.channelToken || !timingSafeEqual(request.headers.get("x-goog-channel-token") ?? "", row.channelToken)) {
    return new Response("Forbidden", { status: 403 });
  }
  log("google_push", { state });
  if (state === "sync") return new Response("ok");
  const jobId = await enqueuePushSync(ctx.db, row.pcid, ctx.clock.now());
  if (jobId && sendJob) {
    // Как tick: pending → queued; не вышло — задача остаётся pending до ближайшего cron
    try {
      await ctx.db.prepare("UPDATE scheduled_jobs SET status = 'queued', queued_at = ? WHERE id = ? AND status = 'pending'").bind(ctx.clock.now(), jobId).run();
      await sendJob(jobId);
    } catch (e) {
      console.error("push job send failed", e);
      await ctx.db.prepare("UPDATE scheduled_jobs SET status = 'pending' WHERE id = ? AND status = 'queued'").bind(jobId).run();
    }
  }
  return new Response("ok");
}
