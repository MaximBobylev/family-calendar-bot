// Состояние webhook Telegram для панели «здоровье»: getWebhookInfo при загрузке страницы, кеш 1 минуту в ops_state.
// Сбой вызова показывается на странице, а не роняет её.

import type { AppContext } from "../bot/context";
import { fetchWithTimeout } from "../net/fetch";
import { opsState, saveOpsState } from "./queries";

export interface WebhookInfo {
  url: string;
  pending_update_count: number;
  last_error_date?: number;
  last_error_message?: string;
  max_connections?: number;
}

export type WebhookStatus = { ok: true; info: WebhookInfo; fetchedAt: number; cached: boolean } | { ok: false; error: string };

const CACHE_KEY = "webhook_info";
const CACHE_MS = 60_000;
const TIMEOUT_MS = 5_000;

export async function webhookStatus(ctx: AppContext): Promise<WebhookStatus> {
  const now = ctx.clock.now();
  const cached = (await opsState(ctx.db, [CACHE_KEY])).get(CACHE_KEY);
  if (cached && now - cached.updated_at < CACHE_MS && now >= cached.updated_at) {
    try {
      return { ok: true, info: JSON.parse(cached.value) as WebhookInfo, fetchedAt: cached.updated_at, cached: true };
    } catch {
      // битый кеш — запросим заново
    }
  }
  const token = ctx.config.telegramBotToken;
  try {
    const res = await fetchWithTimeout(
      `${ctx.config.telegramApiBase}/bot${token}/getWebhookInfo`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      TIMEOUT_MS,
    );
    const json = (await res.json().catch(() => null)) as { ok?: boolean; result?: unknown; description?: string } | null;
    if (!json?.ok) return { ok: false, error: `getWebhookInfo: ${json?.description ?? `HTTP ${res.status}`}` };
    const r = json.result as Partial<WebhookInfo> | null;
    if (!r || typeof r !== "object" || typeof r.url !== "string") return { ok: false, error: "getWebhookInfo: неожиданный ответ" };
    const info: WebhookInfo = {
      url: r.url,
      pending_update_count: Number(r.pending_update_count ?? 0),
      ...(r.last_error_date ? { last_error_date: Number(r.last_error_date) } : {}),
      ...(r.last_error_message ? { last_error_message: String(r.last_error_message).slice(0, 300) } : {}),
      ...(r.max_connections ? { max_connections: Number(r.max_connections) } : {}),
    };
    await saveOpsState(ctx.db, CACHE_KEY, JSON.stringify(info), now);
    return { ok: true, info, fetchedAt: now, cached: false };
  } catch (e) {
    // Токен бота не должен попасть на страницу, даже если он есть в тексте ошибки
    const raw = String(e instanceof Error ? e.message : e);
    const msg = token ? raw.split(token).join("<token>") : raw;
    return { ok: false, error: `getWebhookInfo: ${msg.slice(0, 200)}` };
  }
}
