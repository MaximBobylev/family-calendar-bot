// Никогда не бросает: сбой алертов не должен ронять cron. В TEST_MODE запускается через POST /__test/alerts.

import { inboxHealth, jobsLag, syncCalendars } from "../admin/queries";
import { webhookStatus } from "../admin/webhook";
import type { AppContext } from "../bot/context";
import { alertCounts, loadAlertStates, saveAlertState } from "../db/alert-state";
import { errorClass, log } from "../log";
import { AI_WINDOW_MS, type AlertInputs, alertText, decide, evaluateRules } from "./alert-rules";
import { lowQuotas } from "./quota-rules";
import { quotaReport, quotaRows } from "./quotas";
import { summarizeSync } from "./sync-health";

export async function collectAlertInputs(ctx: AppContext, now: number): Promise<AlertInputs> {
  const [webhook, inbox, lag, counts, syncRows, quotas] = await Promise.all([
    webhookStatus(ctx),
    inboxHealth(ctx.db, now),
    jobsLag(ctx.db, now),
    alertCounts(ctx.db, now, AI_WINDOW_MS),
    syncCalendars(ctx.db),
    // Сбой оценки квот не должен мешать остальным правилам
    quotaReport(ctx).catch((e) => {
      log("alerts", { outcome: "quota_error", error: errorClass(e) });
      return null;
    }),
  ]);
  const sync = summarizeSync(syncRows, now);
  return {
    now,
    expectedWebhookUrl: `${ctx.config.publicBaseUrl}/telegram/webhook`,
    webhook: webhook.ok ? webhook.info : null,
    inbox,
    jobs: { overdue: lag.overdue, oldestOverdueAt: lag.oldestOverdueAt, failedHour: counts.jobsFailedHour },
    digestFailedDay: counts.digestFailedDay,
    ai: { calls: counts.aiCalls, errors: counts.aiErrors },
    sync: { stale: sync.stale, oldestStaleAt: sync.oldestStaleAt },
    quotaLow: quotas ? lowQuotas(quotaRows(quotas)) : null,
  };
}

export async function runAlerts(ctx: AppContext): Promise<string[]> {
  const sent: string[] = [];
  const started = Date.now(); // только длительность для лога, не «сейчас» логики
  try {
    const chatId = ctx.config.opsChatId;
    if (!chatId) {
      log("alerts", { outcome: "no_chat" });
      return sent;
    }
    const now = ctx.clock.now();
    const [inputs, states] = await Promise.all([collectAlertInputs(ctx, now), loadAlertStates(ctx.db)]);
    const adminUrl = `${ctx.config.publicBaseUrl}/admin`;
    for (const r of evaluateRules(inputs)) {
      const prev = states.get(r.key);
      const d = decide(prev, r, now);
      if (!d) continue;
      try {
        await ctx.telegram.sendMessage(chatId, alertText(d.action, r, prev, now, adminUrl));
        // После отправки: не дошло — повторим в следующий раз
        await saveAlertState(ctx.db, d.next);
        sent.push(`${r.key}:${d.action}`);
      } catch (e) {
        log("alert_send", { key: r.key, action: d.action, outcome: "error", error: errorClass(e) });
      }
    }
    log("alerts", { outcome: "ok", sent: sent.join(",") || undefined, ms: Date.now() - started });
  } catch (e) {
    log("alerts", { outcome: "error", error: errorClass(e), ms: Date.now() - started });
  }
  return sent;
}
