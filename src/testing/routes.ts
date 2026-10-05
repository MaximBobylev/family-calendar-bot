// Тестовые эндпоинты (ADR-0006). Доступны только при TEST_MODE=true — в проде маршрутов нет.
//   POST /__test/clock  {"now": "2026-10-07T07:00:00Z"} — установить «сейчас»
//   POST /__test/tick   — выполнить планировщик до текущего «сейчас»
//   POST /__test/drain  — синхронно обработать все апдейты из inbox
//   POST /__test/reset  — очистить состояние

import type { AppContext } from "../bot/context";
import { setTestClock } from "../clock";
import { pendingUpdateIds } from "../inbox";
import { processInboxUpdate } from "../process";
import { cleanup, tick } from "../scheduler";

const TABLES = [
  "test_state", "feature_usage", "usage_events", "entitlements", "scheduled_jobs", "inbox", "pending_actions",
  "dialog_state", "conversations", "assignments", "event_meta", "dependents", "household_members", "households",
  "oauth_states", "calendar_aliases", "calendars", "provider_accounts", "channel_identities", "users",
];

export async function handleTestRoute(ctx: AppContext, request: Request, path: string): Promise<Response> {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  switch (path) {
    case "/__test/clock": {
      const body = (await request.json()) as { now: string };
      const ms = Date.parse(body.now);
      if (Number.isNaN(ms)) return Response.json({ error: "bad now" }, { status: 400 });
      await setTestClock(ctx.db, ms);
      return Response.json({ ok: true, now: new Date(ms).toISOString() });
    }
    case "/__test/tick":
      return Response.json({ ok: true, jobs: await tick(ctx.db, ctx.clock.now()) });
    case "/__test/cleanup":
      await cleanup(ctx.db, ctx.clock.now());
      return Response.json({ ok: true });
    case "/__test/drain": {
      const ids = await pendingUpdateIds(ctx.db);
      for (const id of ids) await processInboxUpdate(ctx, id);
      return Response.json({ ok: true, processed: ids.length });
    }
    case "/__test/reset":
      await ctx.db.batch(TABLES.map((tbl) => ctx.db.prepare(`DELETE FROM ${tbl}`)));
      return Response.json({ ok: true });
    default:
      return new Response("Not found", { status: 404 });
  }
}
