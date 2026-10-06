// GET /health для внешнего монитора (docs/admin-console.md, «Внешний heartbeat»): один запрос к D1 и возраст
// последнего прогона cron. 503, если D1 недоступна или cron молчит дольше CRON_SILENT_MS — монитор пришлёт письмо,
// даже когда бот не может прислать алерт сам. Без секретов и пользовательских данных.

import { resolveClock } from "../clock";
import { OPS_LAST_TICK } from "../db/ops-state";
import { errorClass, log } from "../log";

/** Cron раз в минуту; 5 минут тишины — не случайная задержка (правило cron_silent). */
export const CRON_SILENT_MS = 5 * 60_000;

export async function healthCheck(env: Env): Promise<Response> {
  let d1 = false;
  let lastTickAgeSec: number | null = null;
  try {
    const now = (await resolveClock(env.DB, env.TEST_MODE === "true")).now();
    const row = await env.DB.prepare("SELECT updated_at FROM ops_state WHERE key = ?").bind(OPS_LAST_TICK).first<{ updated_at: number }>();
    d1 = true;
    if (row) lastTickAgeSec = Math.max(0, Math.round((now - row.updated_at) / 1000));
  } catch (e) {
    log("health", { outcome: "error", error: errorClass(e) });
  }
  // Ещё ни одного прогона (свежая база) — не сбой
  const cronOk = lastTickAgeSec === null || lastTickAgeSec * 1000 <= CRON_SILENT_MS;
  const ok = d1 && cronOk;
  return Response.json({ ok, d1, lastTickAgeSec }, { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } });
}
