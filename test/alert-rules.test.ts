// Алерты владельцу (src/ops/alert-rules.ts): правила по счётчикам, дедупликация переходов, тексты без PII.

import { describe, expect, it } from "vitest";
import { type AlertInputs, type AlertState, alertText, decide, evaluateRules, isAlertMinute, REMIND_MS, type RuleResult } from "../src/ops/alert-rules";

const NOW = Date.parse("2026-10-08T05:20:00Z");
const MIN = 60_000;
const URL = "https://bot.example/telegram/webhook";

function inputs(over: Partial<AlertInputs> = {}): AlertInputs {
  return {
    now: NOW,
    expectedWebhookUrl: URL,
    webhook: { url: URL, pending_update_count: 0 },
    inbox: { oldestOpenAt: null, pending: 0, processing: 0, failedHour: 0 },
    jobs: { overdue: 0, oldestOverdueAt: null, failedHour: 0 },
    digestFailedDay: 0,
    ai: { calls: 0, errors: 0 },
    sync: { stale: 0, oldestStaleAt: null },
    quotaLow: [],
    ...over,
  };
}

const firing = (i: AlertInputs) =>
  evaluateRules(i)
    .filter((r) => r.firing)
    .map((r) => r.key);

describe("evaluateRules", () => {
  it("all quiet", () => {
    const rs = evaluateRules(inputs());
    expect(rs.map((r) => r.key)).toEqual(["webhook", "inbox_stuck", "inbox_failed", "jobs", "digest_failed", "ai_errors", "sync_stale", "quota_low"]);
    expect(rs.every((r) => r.firing === false)).toBe(true);
  });

  it("quota_low: low quotas fire with counts; not evaluated — state kept", () => {
    const r = evaluateRules(inputs({ quotaLow: ["OpenRouter: 4 запр. из 50", "DeepSeek: 0.40 $"] })).find((x) => x.key === "quota_low")!;
    expect(r).toEqual({ key: "quota_low", firing: true, detail: "OpenRouter: 4 запр. из 50; DeepSeek: 0.40 $" });
    expect(evaluateRules(inputs({ quotaLow: null })).find((x) => x.key === "quota_low")!.firing).toBeNull();
  });

  it.each<[string, Partial<AlertInputs>, string[]]>([
    ["webhook url mismatch", { webhook: { url: "https://other/telegram/webhook", pending_update_count: 0 } }, ["webhook"]],
    ["webhook not set", { webhook: { url: "", pending_update_count: 0 } }, ["webhook"]],
    ["webhook recent error", { webhook: { url: URL, pending_update_count: 1, last_error_date: (NOW - 9 * MIN) / 1000 } }, ["webhook"]],
    ["webhook old error is fine", { webhook: { url: URL, pending_update_count: 0, last_error_date: (NOW - 11 * MIN) / 1000 } }, []],
    ["webhook backlog", { webhook: { url: URL, pending_update_count: 21 } }, ["webhook"]],
    ["webhook backlog at threshold", { webhook: { url: URL, pending_update_count: 20 } }, []],
    ["inbox stuck", { inbox: { oldestOpenAt: NOW - 3 * MIN, pending: 1, processing: 0, failedHour: 0 } }, ["inbox_stuck"]],
    ["inbox fresh", { inbox: { oldestOpenAt: NOW - MIN, pending: 1, processing: 0, failedHour: 0 } }, []],
    ["inbox failed ×3", { inbox: { oldestOpenAt: null, pending: 0, processing: 0, failedHour: 3 } }, ["inbox_failed"]],
    ["inbox failed ×2", { inbox: { oldestOpenAt: null, pending: 0, processing: 0, failedHour: 2 } }, []],
    ["job failed", { jobs: { overdue: 0, oldestOverdueAt: null, failedHour: 1 } }, ["jobs"]],
    ["jobs overdue 6 min", { jobs: { overdue: 2, oldestOverdueAt: NOW - 6 * MIN, failedHour: 0 } }, ["jobs"]],
    ["jobs overdue 3 min", { jobs: { overdue: 2, oldestOverdueAt: NOW - 3 * MIN, failedHour: 0 } }, []],
    ["digest failed", { digestFailedDay: 1 }, ["digest_failed"]],
    ["ai errors 3/5", { ai: { calls: 5, errors: 3 } }, ["ai_errors"]],
    ["ai errors 3/3", { ai: { calls: 3, errors: 3 } }, ["ai_errors"]],
    ["ai errors 2/2 — too few", { ai: { calls: 2, errors: 2 } }, []],
    ["ai errors 3/20 — low rate", { ai: { calls: 20, errors: 3 } }, []],
    ["ai errors 4/20 — 20%", { ai: { calls: 20, errors: 4 } }, ["ai_errors"]],
    ["sync stale", { sync: { stale: 1, oldestStaleAt: NOW - 27 * 60 * MIN } }, ["sync_stale"]],
  ])("%s", (_, over, keys) => {
    expect(firing(inputs(over))).toEqual(keys);
  });

  it("sync stale detail — counters only", () => {
    const r = evaluateRules(inputs({ sync: { stale: 2, oldestStaleAt: NOW - 27 * 60 * MIN } })).find((x) => x.key === "sync_stale");
    expect(r).toEqual({ key: "sync_stale", firing: true, detail: "устарели: 2, старейший синк 27 ч назад" });
    expect(evaluateRules(inputs()).find((x) => x.key === "sync_stale")?.detail).toBe("устарели: 0");
  });

  it("webhook unknown when getWebhookInfo failed", () => {
    expect(evaluateRules(inputs({ webhook: null }))[0]).toMatchObject({ key: "webhook", firing: null });
  });
});

describe("decide", () => {
  const fire: RuleResult = { key: "jobs", firing: true, detail: "failed за час: 1" };
  const quiet: RuleResult = { ...fire, firing: false };

  it("fires once, reminds after REMIND_MS, resolves", () => {
    const d1 = decide(undefined, fire, NOW);
    expect(d1).toEqual({ action: "fire", next: { key: "jobs", status: "firing", since: NOW, last_sent_at: NOW } });
    const s1 = d1!.next;
    expect(decide(s1, fire, NOW + 5 * MIN)).toBeNull();
    expect(decide(s1, fire, NOW + REMIND_MS - MIN)).toBeNull();
    const d2 = decide(s1, fire, NOW + REMIND_MS);
    expect(d2).toEqual({ action: "remind", next: { ...s1, last_sent_at: NOW + REMIND_MS } });
    const end = NOW + REMIND_MS + 5 * MIN;
    expect(decide(d2!.next, quiet, end)).toEqual({ action: "resolve", next: { key: "jobs", status: "ok", since: end, last_sent_at: end } });
    const ok: AlertState = { key: "jobs", status: "ok", since: end, last_sent_at: end };
    expect(decide(ok, quiet, end + 5 * MIN)).toBeNull();
    expect(decide(ok, fire, end + 5 * MIN)?.action).toBe("fire");
  });

  it("quiet without history — nothing", () => {
    expect(decide(undefined, quiet, NOW)).toBeNull();
  });

  it("unknown keeps state", () => {
    const s: AlertState = { key: "webhook", status: "firing", since: NOW - REMIND_MS * 2, last_sent_at: NOW - REMIND_MS * 2 };
    expect(decide(s, { key: "webhook", firing: null, detail: "" }, NOW)).toBeNull();
  });
});

describe("alertText", () => {
  const r: RuleResult = { key: "digest_failed", firing: true, detail: "не доставлено за сутки: 1" };
  const admin = "https://bot.example/admin";

  it("fire / remind / resolve", () => {
    expect(alertText("fire", r, undefined, NOW, admin)).toBe("🔴 Алерт: дайджесты не доставлены\nне доставлено за сутки: 1\nhttps://bot.example/admin");
    const prev: AlertState = { key: r.key, status: "firing", since: NOW - 185 * MIN, last_sent_at: NOW - 185 * MIN };
    expect(alertText("remind", r, prev, NOW, admin)).toBe(
      "🔴 Всё ещё: дайджесты не доставлены (уже 3 ч 5 мин)\nне доставлено за сутки: 1\nhttps://bot.example/admin",
    );
    const back = { ...r, firing: false, detail: "не доставлено за сутки: 0" };
    expect(alertText("resolve", back, { ...prev, since: NOW - 40 * MIN }, NOW, admin)).toBe(
      "✅ Восстановлено: дайджесты не доставлены (было 40 мин)\nне доставлено за сутки: 0\nhttps://bot.example/admin",
    );
  });
});

it("isAlertMinute — every 5 minutes", () => {
  expect(isAlertMinute(Date.parse("2026-10-08T05:00:00Z"))).toBe(true);
  expect(isAlertMinute(Date.parse("2026-10-08T05:15:30Z"))).toBe(true);
  expect(isAlertMinute(Date.parse("2026-10-08T05:07:00Z"))).toBe(false);
});
