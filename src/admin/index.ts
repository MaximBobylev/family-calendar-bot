// Серверный HTML в том же Worker, путь /admin*: без JS, CSP default-src 'none'. Вход — HTTP Basic (auth.ts).

import type { AppContext } from "../bot/context";
import { OPS_LAST_HOURLY, OPS_LAST_TICK } from "../db/ops-state";
import { adminOperator, sameOrigin, unauthorized } from "./auth";
import { NOTIFY_FLUSH_JOB } from "../sync/notify";
import { PUSH_SYNC_JOB, SYNC_JOB, WATCH_RENEW_JOB } from "../sync/engine";
import { TG_REMINDER_JOB } from "../sync/reminders";
import { quotaReport } from "../ops/quotas";
import { summarizeSync } from "../ops/sync-health";
import { chatPseudonym, intentOf, maskError, maskResult, maskText, pseudonym, pseudonymKey } from "./mask";
import * as q from "./queries";
import { auditBody } from "./views/audit";
import { healthBody } from "./views/health";
import { householdDetailBody, householdsBody } from "./views/households";
import { type JournalDetailView, journalDetailBody, journalListBody, REVEAL_REASONS } from "./views/journal";
import { page } from "./views/layout";
import { quotasBody } from "./views/quotas";
import { syncBody } from "./views/sync";
import { usageBody } from "./views/usage";
import { webhookStatus } from "./webhook";
import { datesSnippet, extractSnippet, localNow, replay } from "./yaml-snippet";

const JOURNAL_PAGE = 50;
const DATE_SLOTS = ["start", "range", "duration"];
const SYNC_KINDS = [SYNC_JOB, PUSH_SYNC_JOB, WATCH_RENEW_JOB, NOTIFY_FLUSH_JOB, TG_REMINDER_JOB];

type Pseudo = (userId: string | null) => Promise<string>;

function pseudonyms(ctx: AppContext): Pseudo {
  const memo = new Map<string | null, Promise<string>>();
  const key = pseudonymKey(ctx.config.tokenEncryptionKey);
  return (id) => {
    let p = memo.get(id);
    if (!p) {
      p = key.then((k) => pseudonym(k, id));
      memo.set(id, p);
    }
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
  if (path === "/admin/sync") return render("Синхронизация", "/admin/sync", syncBody(await sync(ctx, now)));
  if (path === "/admin/households") return render("Дома", "/admin/households", await householdList(ctx, now, pseudo));
  const home = /^\/admin\/households\/([^/]+)$/.exec(path);
  if (home) {
    const body = await householdDetail(ctx, decodeURIComponent(home[1]!), now, pseudo);
    if (!body) return render("Нет дома", "/admin/households", `<h1>Дом не найден</h1><p>Возможно, распущен.</p>`, 404);
    return render("Дом", "/admin/households", body);
  }
  if (path === "/admin/usage") return render("Расход", "/admin/usage", await usage(ctx, now, pseudo));
  if (path === "/admin/quotas") return render("Квоты", "/admin/quotas", quotasBody(await quotaReport(ctx)));
  if (path === "/admin/audit") return render("Аудит", "/admin/audit", await audit(ctx, pseudo));
  return new Response("Not found", { status: 404 });
}

async function health(ctx: AppContext, now: number, pseudo: Pseudo) {
  const db = ctx.db;
  const [webhook, inbox, failures, jobs, lag, problems, digests, ops, totals, byDay, syncRows, notices, syncJobs] = await Promise.all([
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
    q.syncCalendars(db),
    q.noticeStats(db, now),
    q.jobKindStats(db, now, SYNC_KINDS),
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
    sync: { summary: summarizeSync(syncRows, now), notices, jobs: syncJobs },
  };
}

async function sync(ctx: AppContext, now: number) {
  const [rows, errors, jobs, notices, reminderUsers] = await Promise.all([
    q.syncCalendars(ctx.db),
    q.syncErrorClasses(ctx.db, now),
    q.jobKindStats(ctx.db, now, SYNC_KINDS),
    q.noticeStats(ctx.db, now),
    q.reminderUsersCount(ctx.db),
  ]);
  return { now, pushEnabled: ctx.config.googlePushEnabled, summary: summarizeSync(rows, now), errors, jobs, notices, reminderUsers };
}

async function householdList(ctx: AppContext, now: number, pseudo: Pseudo): Promise<string> {
  const rows = await q.households(ctx.db, now);
  return householdsBody(await Promise.all(rows.map(async (h) => ({ ...h, owner: await pseudo(h.owner_user_id) }))));
}

async function householdDetail(ctx: AppContext, id: string, now: number, pseudo: Pseudo): Promise<string | null> {
  const h = await q.household(ctx.db, id, now);
  if (!h) return null;
  const [members, invites, chats, key] = await Promise.all([
    q.householdMembers(ctx.db, id),
    q.householdInvites(ctx.db, id, now),
    q.householdChats(ctx.db, id),
    pseudonymKey(ctx.config.tokenEncryptionKey),
  ]);
  return householdDetailBody({
    household: { ...h, owner: await pseudo(h.owner_user_id) },
    members: await Promise.all(
      members.map(async (m) => ({ user: await pseudo(m.user_id), role: m.role, hasGoogle: m.has_google === 1, joinedAt: m.joined_at })),
    ),
    invites,
    chats: await Promise.all(chats.map((c) => chatPseudonym(key, c))),
    sections: [],
  });
}

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
  const note = String(form?.get("note") ?? "")
    .trim()
    .slice(0, 200);
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

async function usage(ctx: AppContext, now: number, pseudo: Pseudo): Promise<string> {
  const dayStart = now - (now % 86_400_000);
  const [byUser, byModel, intents, cards, features, bySource, inline, dateFixes] = await Promise.all([
    q.usageByUser(ctx.db, now, dayStart),
    q.usageByModel(ctx.db, now),
    q.intentCounts(ctx.db, now),
    q.cardCounts(ctx.db, now),
    q.featureUsage(ctx.db),
    q.llmBySource(ctx.db, now),
    q.inlineStats(ctx.db, now),
    q.dateFixDaily(ctx.db, now),
  ]);
  return usageBody({
    byUser: await Promise.all(byUser.map(async (u) => ({ ...u, user: await pseudo(u.user_id) }))),
    byModel,
    intents,
    cards,
    features,
    bySource,
    inline,
    dateFixes,
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
