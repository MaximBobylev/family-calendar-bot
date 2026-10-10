// Админка R1: свежесть синхронизации (src/ops/sync-health.ts), светофор панели, подписи функций, псевдонимы чатов.

import { describe, expect, it } from "vitest";
import { chatPseudonym, pseudonym, pseudonymKey } from "../src/admin/mask";
import { FEATURE_LABELS, featureLabel } from "../src/admin/labels";
import { isSyncStale, SYNC_STALE_POLL_MS, SYNC_STALE_PUSH_MS, type SyncCalendarRow, summarizeSync, syncLevel, syncMode } from "../src/ops/sync-health";

const NOW = Date.parse("2026-10-08T07:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;

function row(over: Partial<SyncCalendarRow> = {}): SyncCalendarRow {
  return {
    last_sync_at: NOW - 5 * MIN,
    has_channel: 1,
    channel_expires_at: NOW + 5 * 24 * HOUR,
    last_outcome: "ok",
    last_error_at: null,
    last_resync_at: null,
    subscribed: 1,
    ...over,
  };
}

describe("syncMode", () => {
  it("push only with a live channel", () => {
    expect(syncMode(row(), NOW)).toBe("push");
    expect(syncMode(row({ has_channel: 0, channel_expires_at: null }), NOW)).toBe("poll");
    expect(syncMode(row({ channel_expires_at: NOW - MIN }), NOW)).toBe("poll");
  });
});

describe("isSyncStale", () => {
  it.each<[string, Partial<SyncCalendarRow>, boolean]>([
    ["push, synced 25 h ago — daily reconcile is fine", { last_sync_at: NOW - 25 * HOUR }, false],
    ["push, synced 27 h ago", { last_sync_at: NOW - 27 * HOUR }, true],
    ["poll, synced 50 min ago", { has_channel: 0, last_sync_at: NOW - 50 * MIN }, false],
    ["poll, synced 61 min ago", { has_channel: 0, last_sync_at: NOW - 61 * MIN }, true],
    ["expired channel counts as poll", { channel_expires_at: NOW - HOUR, last_sync_at: NOW - 2 * HOUR }, true],
    ["never synced — not stale (no age)", { last_sync_at: null }, false],
    ["no subscribers", { subscribed: 0, last_sync_at: NOW - 30 * HOUR }, false],
    ["unavailable (access revoked) — user problem", { last_outcome: "unavailable", last_sync_at: NOW - 30 * HOUR }, false],
    ["failing with errors — stale", { last_outcome: "error", last_sync_at: NOW - 30 * HOUR }, true],
  ])("%s", (_, over, stale) => {
    expect(isSyncStale(row(over), NOW)).toBe(stale);
  });

  it("thresholds", () => {
    expect(SYNC_STALE_PUSH_MS).toBeGreaterThan(24 * HOUR);
    expect(SYNC_STALE_POLL_MS).toBeGreaterThan(15 * MIN);
  });
});

describe("summarizeSync", () => {
  it("counts by mode, stale, errors, resyncs, expiring channels", () => {
    const s = summarizeSync(
      [
        row(),
        row({ has_channel: 0, channel_expires_at: null, last_sync_at: NOW - 2 * HOUR, last_outcome: "error", last_error_at: NOW - HOUR }),
        row({ last_sync_at: NOW - 30 * HOUR, last_resync_at: NOW - 30 * HOUR }),
        row({ last_sync_at: null, has_channel: 0, channel_expires_at: null, last_outcome: null }),
        row({ channel_expires_at: NOW + 3 * HOUR, last_resync_at: NOW - HOUR }),
        row({ last_outcome: "unavailable", last_error_at: NOW - 25 * HOUR, last_sync_at: NOW - 40 * HOUR }),
      ],
      NOW,
    );
    expect(s).toEqual({
      total: 6,
      push: 4,
      poll: 2,
      neverSynced: 1,
      unavailable: 1,
      failing: 1,
      stale: 2,
      oldestStaleAt: NOW - 30 * HOUR,
      oldestSyncAt: NOW - 40 * HOUR,
      errorsDay: 1,
      resyncsDay: 1,
      channelsExpiring: 1,
    });
  });

  it("empty", () => {
    expect(summarizeSync([], NOW)).toMatchObject({ total: 0, stale: 0, oldestStaleAt: null, oldestSyncAt: null });
  });
});

describe("syncLevel", () => {
  const ok = summarizeSync([row()], NOW);

  it("ok, warn, crit", () => {
    expect(syncLevel(ok, 0, 0)).toBe("ok");
    expect(syncLevel(ok, 1, 0)).toBe("warn");
    expect(syncLevel(ok, 0, 1)).toBe("warn");
    expect(syncLevel(summarizeSync([row({ last_error_at: NOW - HOUR })], NOW), 0, 0)).toBe("warn");
    expect(syncLevel(summarizeSync([row({ channel_expires_at: NOW + HOUR })], NOW), 0, 0)).toBe("warn");
    expect(syncLevel(summarizeSync([row({ last_sync_at: NOW - 27 * HOUR })], NOW), 0, 0)).toBe("crit");
  });
});

describe("feature labels (US-64)", () => {
  it("R1 features are labelled in Russian", () => {
    expect(featureLabel("forward_event")).toBe("Событие из пересланного (US-65)");
    expect(featureLabel("image_event")).toBe("Событие из фото (US-66)");
    expect(featureLabel("ics_import")).toBe("Импорт .ics (US-67)");
    for (const label of Object.values(FEATURE_LABELS)) expect(label).toMatch(/[а-яё]/i);
  });

  it("unknown feature — key as is", () => {
    expect(featureLabel("future_thing")).toBe("future_thing");
    expect(featureLabel("toString")).toBe("toString");
  });
});

describe("chatPseudonym", () => {
  it("stable, c-prefixed, distinct from user pseudonyms, no raw id", async () => {
    const key = await pseudonymKey("secret");
    const c = await chatPseudonym(key, "-1001234567890");
    expect(c).toMatch(/^c-[0-9a-f]{6}$/);
    expect(await chatPseudonym(key, "-1001234567890")).toBe(c);
    expect(c).not.toContain("1234567890");
    expect((await pseudonym(key, "-1001234567890")).slice(2)).not.toBe(c.slice(2));
  });
});
