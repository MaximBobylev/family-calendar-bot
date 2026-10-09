// Квоты провайдеров (src/ops/quota-rules.ts): разбор ответов OpenRouter /key, DeepSeek /user/balance, GraphQL
// Cloudflare и заголовков Groq; пороги жёлтого и алерта; ни ключей, ни меток ключей в строках.

import { describe, expect, it } from "vitest";
import {
  CF_LIMITS,
  cfWindow,
  cloudflareGraphql,
  d1Query,
  d1Rows,
  GEMINI_RESET_TZ,
  geminiRow,
  groqAudioRow,
  groqRows,
  lowQuotas,
  neuronsFromCost,
  neuronsQuery,
  parseDeepSeekBalance,
  parseD1,
  parseDuration,
  parseNeurons,
  parseOpenRouterKey,
  parseQueues,
  parseWorkers,
  queuesQuery,
  queuesRows,
  shareLevel,
  workersAiRow,
  workersQuery,
  workersRows,
  zoneDay,
} from "../src/ops/quota-rules";

const NOW = Date.parse("2026-10-09T15:30:00Z");
const NEXT_UTC = Date.parse("2026-10-10T00:00:00Z");

describe("OpenRouter /key", () => {
  const key = (over: Record<string, unknown> = {}) => ({
    data: {
      label: "sk-or-v1-abc…xyz",
      limit: null,
      limit_reset: null,
      limit_remaining: null,
      usage: 1.25,
      usage_daily: 0.01,
      is_free_tier: true,
      free_model_daily_requests: { used: 12, limit: 50, remaining: 38 },
      ...over,
    },
  });

  it("free daily requests from the API, reset at UTC midnight", () => {
    const [free, paid] = parseOpenRouterKey(key(), NOW, 0);
    expect(free).toMatchObject({ provider: "OpenRouter", remaining: 38, limit: 50, used: 12, source: "api", resetAt: NEXT_UTC, level: "ok", alert: false });
    expect(paid).toMatchObject({ remaining: null, limit: null, level: "unknown" });
    expect(paid!.note).toContain("$0.0100");
    // Метка ключа — частично ключ: не показываем
    expect(JSON.stringify(parseOpenRouterKey(key(), NOW, 0))).not.toContain("sk-or");
  });

  it("below 20% — warn; below 10 requests — alert", () => {
    const [free] = parseOpenRouterKey(key({ free_model_daily_requests: { used: 41, limit: 50, remaining: 9 } }), NOW, 0);
    expect(free).toMatchObject({ level: "warn", alert: true });
    expect(lowQuotas([free!])).toEqual(["OpenRouter: 9 запр. из 50"]);
    const [none] = parseOpenRouterKey(key({ free_model_daily_requests: { used: 50, limit: 50, remaining: 0 } }), NOW, 0);
    expect(none!.level).toBe("crit");
  });

  it("older response without free_model_daily_requests — estimate from the journal and tier", () => {
    const [free] = parseOpenRouterKey(key({ free_model_daily_requests: undefined, is_free_tier: false }), NOW, 7);
    expect(free).toMatchObject({ source: "estimate", limit: 1000, used: 7, remaining: 993 });
  });

  it("key with a $ limit", () => {
    const [, credit] = parseOpenRouterKey(key({ limit: 5, limit_remaining: 0.5, limit_reset: "monthly" }), NOW, 0);
    expect(credit).toMatchObject({ unit: "$", remaining: 0.5, limit: 5, level: "warn" });
    expect(credit!.note).toContain("сброс: monthly");
  });

  it("unexpected body — error", () => {
    expect(() => parseOpenRouterKey({ error: { message: "x" } }, NOW, 0)).toThrow();
  });
});

describe("DeepSeek /user/balance", () => {
  it("balance per currency; below $1 or unavailable — alert", () => {
    const ok = parseDeepSeekBalance(
      { is_available: true, balance_infos: [{ currency: "USD", total_balance: "4.20", granted_balance: "0.00", topped_up_balance: "4.20" }] },
      NOW,
    );
    expect(ok).toEqual([expect.objectContaining({ provider: "DeepSeek", remaining: 4.2, unit: "$", level: "ok", alert: false, source: "api" })]);
    const low = parseDeepSeekBalance({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "0.40" }] }, NOW);
    expect(low[0]).toMatchObject({ level: "crit", alert: true });
    expect(lowQuotas(low)).toEqual(["DeepSeek: 0.40 $"]);
    const warn = parseDeepSeekBalance({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "1.50" }] }, NOW);
    expect(warn[0]!.level).toBe("warn");
    const off = parseDeepSeekBalance({ is_available: false, balance_infos: [{ currency: "CNY", total_balance: "100" }] }, NOW);
    expect(off[0]).toMatchObject({ unit: "¥", alert: true });
    expect(off[0]!.note).toContain("is_available = false");
  });

  it("unexpected body — error", () => {
    expect(() => parseDeepSeekBalance({ message: "Authentication Fails" }, NOW)).toThrow();
  });
});

describe("Workers AI", () => {
  it("GraphQL address and account only from a real Cloudflare base URL", () => {
    expect(cloudflareGraphql("https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/v1")).toEqual({
      url: "https://api.cloudflare.com/client/v4/graphql",
      accountTag: "0123456789abcdef0123456789abcdef",
    });
    expect(cloudflareGraphql("http://fakes:9100/stt")).toBeNull();
  });

  it("query covers the UTC day so far", () => {
    const body = JSON.parse(neuronsQuery("acc", Date.parse("2026-10-09T00:00:00Z"), NOW)) as { query: string; variables: Record<string, string> };
    expect(body.query).toContain("aiInferenceAdaptiveGroups");
    expect(body.query).toContain("totalNeurons");
    expect(body.variables).toEqual({ a: "acc", from: "2026-10-09T00:00:00.000Z", to: "2026-10-09T15:30:00.000Z" });
  });

  it("sums neurons across models; access error surfaces as an exception", () => {
    const json = {
      data: { viewer: { accounts: [{ aiInferenceAdaptiveGroups: [{ sum: { totalNeurons: 1200.5 } }, { sum: { totalNeurons: 300 } }] }] } },
      errors: null,
    };
    expect(parseNeurons(json)).toBe(1500.5);
    expect(() => parseNeurons({ data: null, errors: [{ message: "not authorized for that account" }] })).toThrow("not authorized");
  });

  it("estimate: $0.011 per 1000 neurons; over 80% — alert", () => {
    expect(neuronsFromCost(110)).toBe(10);
    expect(workersAiRow(2500, "estimate", NOW)).toMatchObject({ remaining: 7500, limit: 10_000, used: 2500, level: "ok", alert: false, resetAt: NEXT_UTC });
    const hot = workersAiRow(8500.4, "api", NOW);
    expect(hot).toMatchObject({ remaining: 1500, level: "warn", alert: true, source: "api" });
    expect(lowQuotas([hot])).toEqual(["Workers AI: 1500 neurons из 10000"]);
    expect(workersAiRow(12_000, "estimate", NOW)).toMatchObject({ remaining: 0, level: "crit" });
  });
});

describe("Cloudflare platform (GraphQL Analytics)", () => {
  const ok = (account: Record<string, unknown>) => ({ data: { viewer: { accounts: [account] } }, errors: null });
  const SCRIPT = "calendar-assist-bot";
  const vars = (body: string) => JSON.parse(body) as { query: string; variables: Record<string, string> };

  it("window: Free — the UTC day, Paid — the UTC month", () => {
    expect(cfWindow("free", NOW)).toMatchObject({ from: Date.parse("2026-10-09T00:00:00Z"), reset: NEXT_UTC });
    expect(cfWindow("paid", NOW)).toMatchObject({ from: Date.parse("2026-10-01T00:00:00Z"), reset: Date.parse("2026-11-01T00:00:00Z") });
  });

  it("queries name the documented datasets and the window", () => {
    const from = Date.parse("2026-10-09T00:00:00Z");
    const w = vars(workersQuery("acc", from, NOW));
    expect(w.query).toContain("workersInvocationsAdaptive");
    expect(w.query).toContain("cpuTimeP99");
    expect(w.variables).toEqual({ a: "acc", from: "2026-10-09T00:00:00.000Z", to: "2026-10-09T15:30:00.000Z" });
    const d = vars(d1Query("acc", from, NOW));
    expect(d.query).toContain("d1AnalyticsAdaptiveGroups");
    expect(d.query).toContain("d1StorageAdaptiveGroups");
    expect(d.variables).toEqual({ a: "acc", from: "2026-10-09", to: "2026-10-09", sfrom: "2026-10-08" });
    expect(vars(queuesQuery("acc", from, NOW)).query).toContain("billableOperations");
  });

  it("workers: account total, our script, CPU in ms from microseconds", () => {
    const s = parseWorkers(
      ok({
        workersInvocationsAdaptive: [
          { dimensions: { scriptName: SCRIPT }, sum: { requests: 832, errors: 2, subrequests: 301 }, quantiles: { cpuTimeP50: 2800, cpuTimeP99: 6500 } },
          { dimensions: { scriptName: "other" }, sum: { requests: 168, errors: 0, subrequests: 0 }, quantiles: { cpuTimeP50: 100, cpuTimeP99: 900 } },
        ],
      }),
      SCRIPT,
    );
    expect(s).toEqual({ requests: 1000, errors: 2, scripts: 2, ours: { requests: 832, errors: 2, subrequests: 301, cpuP50Ms: 2.8, cpuP99Ms: 6.5 } });
    const [req, cpu] = workersRows(s, "free", SCRIPT, NOW);
    expect(req).toMatchObject({
      provider: "Workers",
      used: 1000,
      limit: 100_000,
      remaining: 99_000,
      source: "api",
      resetAt: NEXT_UTC,
      level: "ok",
      alert: false,
    });
    expect(req!.note).toContain(`${SCRIPT}: 832 (ошибок 2, 0.2%; подзапросов 301)`);
    expect(cpu).toMatchObject({ used: 6.5, limit: 10, remaining: 3.5, unit: "мс", level: "ok" });
    expect(cpu!.alert).toBeUndefined();
  });

  it("workers: over 80% of the daily requests — alert; CPU over the limit — warn, not crit", () => {
    const s = parseWorkers(
      ok({
        workersInvocationsAdaptive: [
          { dimensions: { scriptName: SCRIPT }, sum: { requests: 85_000, errors: 0, subrequests: 0 }, quantiles: { cpuTimeP99: 25_800 } },
        ],
      }),
      SCRIPT,
    );
    const [req, cpu] = workersRows(s, "free", SCRIPT, NOW);
    expect(req).toMatchObject({ remaining: 15_000, level: "warn", alert: true });
    expect(cpu).toMatchObject({ used: 25.8, remaining: 0, level: "warn" });
    expect(lowQuotas([req!, cpu!])).toEqual(["Workers: 15000 запр. из 100000"]);
    // Paid: месячное включённое
    expect(workersRows(s, "paid", SCRIPT, NOW)[0]).toMatchObject({ limit: CF_LIMITS.paid.requests, alert: false, resetAt: Date.parse("2026-11-01T00:00:00Z") });
  });

  it("workers: our script idle — no CPU row", () => {
    const s = parseWorkers(ok({ workersInvocationsAdaptive: [] }), SCRIPT);
    expect(s.ours).toBeNull();
    expect(workersRows(s, "free", SCRIPT, NOW)).toHaveLength(1);
  });

  it("d1: rows across databases, storage as the sum of per-database maxima", () => {
    const s = parseD1(
      ok({
        d1AnalyticsAdaptiveGroups: [
          { dimensions: { databaseId: "a" }, sum: { rowsRead: 4_000_000, rowsWritten: 85_000, readQueries: 10, writeQueries: 5 } },
          { dimensions: { databaseId: "b" }, sum: { rowsRead: 671, rowsWritten: 2, readQueries: 1, writeQueries: 1 } },
        ],
        d1StorageAdaptiveGroups: [
          { dimensions: { databaseId: "a" }, max: { databaseSizeBytes: 600_000 } },
          { dimensions: { databaseId: "a" }, max: { databaseSizeBytes: 700_000 } },
          { dimensions: { databaseId: "b" }, max: { databaseSizeBytes: 50_000 } },
        ],
      }),
    );
    expect(s).toEqual({ rowsRead: 4_000_671, rowsWritten: 85_002, queries: 17, databases: 2, bytes: 750_000 });
    const [read, written, storage] = d1Rows(s, "free", NOW);
    expect(read).toMatchObject({ provider: "D1", limit: 5_000_000, alert: true, level: "warn" });
    expect(written).toMatchObject({ limit: 100_000, remaining: 14_998, alert: true, level: "warn" });
    expect(storage).toMatchObject({ used: 0.8, limit: 5000, unit: "МБ", alert: false, resetAt: null });
    expect(lowQuotas([read!, written!, storage!])).toEqual(["D1: 999329 строк из 5000000", "D1: 14998 строк из 100000"]);
  });

  it("d1: no storage data — no storage row", () => {
    expect(d1Rows(parseD1(ok({ d1AnalyticsAdaptiveGroups: [] })), "free", NOW)).toHaveLength(2);
  });

  it("queues: billable operations by action against 10 000 a day", () => {
    const s = parseQueues(
      ok({
        queueMessageOperationsAdaptiveGroups: [
          { dimensions: { actionType: "WriteMessage" }, sum: { billableOperations: 94 } },
          { dimensions: { actionType: "ReadMessage" }, sum: { billableOperations: 94 } },
          { dimensions: { actionType: "DeleteMessage" }, sum: { billableOperations: 94 } },
        ],
      }),
    );
    expect(s.ops).toBe(282);
    const [row] = queuesRows(s, "free", NOW);
    expect(row).toMatchObject({ provider: "Queues", used: 282, remaining: 9718, limit: 10_000, alert: false });
    expect(row!.note).toContain("WriteMessage 94, ReadMessage 94, DeleteMessage 94");
    const [hot] = queuesRows({ ops: 8001, byAction: {} }, "free", NOW);
    expect(hot!.alert).toBe(true);
  });

  it("access error and unexpected body surface as exceptions", () => {
    expect(() => parseWorkers({ data: null, errors: [{ message: "authorization denied" }] }, SCRIPT)).toThrow("authorization denied");
    expect(() => parseD1({ nope: 1 })).toThrow("неожиданный ответ GraphQL");
    expect(() => parseQueues({ data: { viewer: { accounts: [] } } })).not.toThrow();
  });
});

describe("Groq headers", () => {
  it("durations", () => {
    expect(parseDuration("2m59.56s")).toBe(179_560);
    expect(parseDuration("7.66s")).toBe(7660);
    expect(parseDuration("1h2m3s")).toBe(3_723_000);
    expect(parseDuration("250ms")).toBe(250);
    expect(parseDuration("2")).toBe(2000);
    expect(parseDuration("soon")).toBeNull();
    expect(parseDuration(undefined)).toBeNull();
  });

  it("requests per day from the last call; reset = seen + duration", () => {
    const seen = Date.parse("2026-10-09T15:00:00Z");
    const rows = groqRows(
      {
        "x-ratelimit-limit-requests": "2000",
        "x-ratelimit-remaining-requests": "1990",
        "x-ratelimit-reset-requests": "1h0m0s",
        "x-ratelimit-limit-tokens": "7200",
      },
      seen,
    );
    expect(rows).toEqual([
      expect.objectContaining({ provider: "Groq", remaining: 1990, limit: 2000, source: "headers", at: seen, resetAt: seen + 3_600_000, level: "ok" }),
    ]);
    expect(groqRows({ "retry-after": "2" }, seen)).toEqual([]);
  });

  it("audio seconds today — estimate", () => {
    expect(groqAudioRow(30_000, NOW)).toMatchObject({ used: 30, remaining: 28_770, limit: 28_800, source: "estimate" });
  });
});

describe("Gemini and levels", () => {
  it("calls since Pacific midnight, reset at the next one", () => {
    const pt = zoneDay(NOW, GEMINI_RESET_TZ);
    // 9 октября 2026 — летнее время, UTC−7
    expect(pt).toEqual({ start: Date.parse("2026-10-09T07:00:00Z"), next: Date.parse("2026-10-10T07:00:00Z") });
    expect(geminiRow(4, NOW)).toMatchObject({ used: 4, remaining: null, limit: null, level: "unknown", resetAt: pt.next });
  });

  it("share levels", () => {
    expect(shareLevel(50, 100)).toBe("ok");
    expect(shareLevel(19, 100)).toBe("warn");
    expect(shareLevel(0, 100)).toBe("crit");
    expect(shareLevel(null, 100)).toBe("unknown");
  });
});
