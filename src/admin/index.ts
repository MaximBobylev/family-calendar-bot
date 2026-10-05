// Админка (docs/admin-console.md, первая итерация): серверный HTML в том же Worker, путь /admin*.
//   GET  /admin                       — здоровье (webhook, inbox, задачи, дайджесты, cron)
//   GET  /admin/journal               — журнал распознанного, замаскированный; фильтры u, kind, outcome, intent
//   GET  /admin/journal/:id           — запись: маска, replay дат, «В тест»
//   POST /admin/journal/:id/reveal    — показать текст строки: причина обязательна, запись в admin_audit
//   GET  /admin/usage                 — расход AI по псевдонимам, против лимитов
//   GET  /admin/audit                 — журнал действий операторов
// Вход — HTTP Basic (auth.ts); без JS, CSP default-src 'none'.

import type { AppContext } from "../bot/context";
import { OPS_LAST_HOURLY, OPS_LAST_TICK } from "../db/ops-state";
import { adminOperator, sameOrigin, unauthorized } from "./auth";
import { intentOf, maskError, maskResult, maskText, pseudonym, pseudonymKey } from "./mask";
import * as q from "./queries";
import { auditBody } from "./views/audit";
import { healthBody } from "./views/health";
import { type JournalDetailView, journalDetailBody, journalListBody, REVEAL_REASONS } from "./views/journal";
import { page } from "./views/layout";
import { usageBody } from "./views/usage";
import { webhookStatus } from "./webhook";
import { datesSnippet, extractSnippet, localNow, replay } from "./yaml-snippet";

const JOURNAL_PAGE = 50;
/** Поля интентов с фрагментами дат, как их вырезала LLM, — для сравнения с извлечением сейчас. */
const DATE_SLOTS = ["start", "range", "duration"];

type Pseudo = (userId: string | null) => Promise<string>;

function pseudonyms(ctx: AppContext): Pseudo {
  const memo = new Map<string | null, Promise<string>>();
  const key = pseudonymKey(ctx.config.tokenEncryptionKey);
  return (id) => {
    let p = memo.get(id);
    if (!p) memo.set(id, (p = key.then((k) => pseudonym(k, id))));
    return p;
  };
}

export async function handleAdmin(ctx: AppContext, request: Request, url: URL): Promise<Response> {
  const operator = adminOperator(request, ctx.config.admin.user, ctx.config.admin.password);
  if (!operator) return unauthorized();
  const now = ctx.clock.now();
  const pseudo = pseudonyms(ctx);
  const render = (title: string, active: string, body: string, status?: number) => page({ title, active, operator, now, body, status });
  const path = url.pathname.replace(/\/+$/, "") || "/admin";

  if (request.method === "POST") {
    if (!sameOrigin(request, url)) return new Response("Forbidden", { status: 403 });
    const m = /^\/admin\/journal\/([^/]+)\/reveal$/.exec(path);
    if (m) return reveal(ctx, request, decodeURIComponent(m[1]!), operator, pseudo, render);
    return new Response("Not found", { status: 404 });
  }
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });

  if (path === "/admin") return render("Здоровье", "/admin", healthBody(await health(ctx, now, pseudo)));
  if (path === "/admin/journal") return render("Журнал", "/admin/journal", await journalList(ctx, url, pseudo));
  const detail = /^\/admin\/journal\/([^/]+)$/.exec(path);
  if (detail) {
    const row = await q.journalRow(ctx.db, decodeURIComponent(detail[1]!));
    if (!row) return render("Нет записи", "/admin/journal", `<h1>Запись не найдена</h1><p>Возможно, удалена вместе с пользователем.</p>`, 404);
    return render("Запись журнала", "/admin/journal", journalDetailBody(await detailView(row, pseudo, null)));
  }
  if (path === "/admin/usage") return render("Расход", "/admin/usage", await usage(ctx, now, pseudo));
  if (path === "/admin/audit") return render("Аудит", "/admin/audit", await audit(ctx, pseudo));
  return new Response("Not found", { status: 404 });
}

// --- Здоровье ---------------------------------------------------------------------------------------

async function health(ctx: AppContext, now: number, pseudo: Pseudo) {
  const db = ctx.db;
  const [webhook, inbox, failures, jobs, lag, problems, digests, ops, totals, byDay] = await Promise.all([
    webhookStatus(ctx),
    q.inboxHealth(db, now),
    q.inboxFailures(db),
    q.jobsByKindStatus(db),
    q.jobsLag(db, now),
    q.problemJobs(db),
    q.digestDelivery(db, now),
    q.opsState(db, [OPS_LAST_TICK, OPS_LAST_HOURLY]),
    q.totals(db),
    q.updatesByDay(db, now),
  ]);
  return {
    now,
    expectedWebhookUrl: `${ctx.config.publicBaseUrl}/telegram/webhook`,
    webhook,
    inbox,
    inboxFailures: failures.map((f) => ({ ...f, maskedError: maskError(f.error) })),
    jobs,
    lag,
    problems: await Promise.all(problems.map(async (p) => ({ ...p, user: await pseudo(p.user_id), maskedError: maskError(p.last_error) }))),
    digests,
    lastTick: ops.get(OPS_LAST_TICK),
    lastHourly: ops.get(OPS_LAST_HOURLY),
    totals,
    byDay,
  };
}

// --- Журнал -------------------------------------------------------------------------------------------

async function journalList(ctx: AppContext, url: URL, pseudo: Pseudo): Promise<string> {
  const p = url.searchParams;
  const f = {
    u: p.get("u")?.trim() || undefined,
    kind: p.get("kind") || undefined,
    outcome: p.get("outcome") || undefined,
    intent: p.get("intent")?.trim() || undefined,
  };
  const before = Number(p.get("before")) || undefined;
  let userIds: string[] | undefined;
  if (f.u) {
    const all = await q.userIds(ctx.db);
    const names = await Promise.all(all.map(pseudo));
    userIds = all.filter((_, i) => names[i] === f.u);
  }
  const rows = await q.journal(ctx.db, { kind: f.kind, outcome: f.outcome, intent: f.intent, userIds, before }, JOURNAL_PAGE);
  const items = await Promise.all(
    rows.map(async (r) => {
      const { now, tz } = localNow(r.created_at, r.tz ?? "UTC");
      return {
        id: r.id,
        created_at: r.created_at,
        user: await pseudo(r.user_id),
        kind: r.kind,
        intent: intentOf(r.result_json),
        outcome: r.outcome,
        maskedText: r.text ? maskText(r.text, now, tz) : r.outcome === "error" ? maskResult(r.result_json, now, tz) : "",
      };
    }),
  );
  return journalListBody(items, f, rows.length === JOURNAL_PAGE ? rows.at(-1)!.created_at : null);
}

function llmSlots(json: string | null): [string, string][] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as Record<string, unknown>;
    if (!v || typeof v !== "object") return [];
    return DATE_SLOTS.filter((k) => typeof v[k] === "string").map((k) => [k, v[k] as string]);
  } catch {
    return [];
  }
}

const pretty = (json: string | null) => {
  if (!json) return "";
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
};

async function detailView(row: q.JournalRow, pseudo: Pseudo, revealed: JournalDetailView["revealed"], revealError?: string): Promise<JournalDetailView> {
  const { now, tz } = localNow(row.created_at, row.tz ?? "UTC");
  const intent = intentOf(row.result_json);
  let r: ReturnType<typeof replay> | null = null;
  if (row.text) {
    try {
      r = replay(row.text, now, tz, intent);
    } catch (e) {
      console.warn("admin replay failed", row.id, e);
    }
  }
  const masked = (s: string) => (revealed ? s : maskText(s, now, tz));
  const text = row.text ? masked(row.text) : "";
  const result = revealed ? pretty(row.result_json) : maskResult(row.result_json, now, tz);
  return {
    id: row.id,
    created_at: row.created_at,
    user: await pseudo(row.user_id),
    kind: row.kind,
    model: row.model,
    outcome: row.outcome,
    intent,
    tokens: row.kind === "llm" ? `${row.tokens_in ?? "—"} / ${row.tokens_out ?? "—"}` : row.audio_ms ? `${(row.audio_ms / 1000).toFixed(1)} с аудио` : "—",
    costMicroUsd: row.cost_micro_usd,
    now,
    tz,
    text,
    result,
    replay: r,
    llmSlots: llmSlots(row.result_json).map(([k, s]) => [k, masked(s)]),
    datesSnippet: r ? datesSnippet(r, now, tz, `adm-${row.id.slice(0, 8)}`) : "# текста нет — заготовки нет",
    extractSnippet: r ? extractSnippet(r, text, now, tz, revealed !== null) : "# текста нет — заготовки нет",
    revealed,
    ...(revealError ? { revealError } : {}),
  };
}

async function reveal(
  ctx: AppContext,
  request: Request,
  id: string,
  operator: string,
  pseudo: Pseudo,
  render: (title: string, active: string, body: string, status?: number) => Response,
): Promise<Response> {
  const row = await q.journalRow(ctx.db, id);
  if (!row) return render("Нет записи", "/admin/journal", `<h1>Запись не найдена</h1>`, 404);
  const form = await request.formData().catch(() => null);
  const reason = String(form?.get("reason") ?? "").trim();
  const note = String(form?.get("note") ?? "").trim().slice(0, 200);
  let error: string | undefined;
  if (!(REVEAL_REASONS as readonly string[]).includes(reason)) error = "Укажите причину показа.";
  else if (reason === "Другое" && note.length < 3) error = "Для «Другое» опишите причину в комментарии.";
  if (error) return render("Запись журнала", "/admin/journal", journalDetailBody(await detailView(row, pseudo, null, error)), 400);

  const fullReason = note ? `${reason}: ${note}` : reason;
  const auditId = await q.insertAudit(ctx.db, {
    at: ctx.clock.now(),
    operator,
    action: "view_reveal",
    targetUserId: row.user_id,
    reason: fullReason,
    details: { usage_event_id: row.id },
  });
  return render("Запись журнала", "/admin/journal", journalDetailBody(await detailView(row, pseudo, { auditId, reason: fullReason })));
}

// --- Расход и аудит -------------------------------------------------------------------------------------

async function usage(ctx: AppContext, now: number, pseudo: Pseudo): Promise<string> {
  const dayStart = now - (now % 86_400_000);
  const [byUser, byModel, intents, cards] = await Promise.all([
    q.usageByUser(ctx.db, now, dayStart),
    q.usageByModel(ctx.db, now),
    q.intentCounts(ctx.db, now),
    q.cardCounts(ctx.db, now),
  ]);
  return usageBody({
    byUser: await Promise.all(byUser.map(async (u) => ({ ...u, user: await pseudo(u.user_id) }))),
    byModel,
    intents,
    cards,
    limits: ctx.config.limits,
  });
}

async function audit(ctx: AppContext, pseudo: Pseudo): Promise<string> {
  const rows = await q.auditLog(ctx.db);
  return auditBody(
    await Promise.all(
      rows.map(async (a) => ({
        id: a.id,
        at: a.at,
        operator: a.operator,
        action: a.action,
        user: a.target_user_id ? await pseudo(a.target_user_id) : "—",
        reason: a.reason,
        details: a.details_json,
      })),
    ),
  );
}
