// Часы внедряются (ADR-0006): никаких прямых Date.now() в логике.
// В TEST_MODE «сейчас» задаётся тестом через POST /__test/clock и хранится в D1.

export interface Clock {
  /** мс UTC */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

const CLOCK_KEY = "clock_ms";

export async function resolveClock(db: D1Database, testMode: boolean): Promise<Clock> {
  if (!testMode) return systemClock;
  const row = await db.prepare("SELECT value FROM test_state WHERE key = ?").bind(CLOCK_KEY).first<{ value: string }>();
  if (!row) return systemClock;
  const fixed = Number(row.value);
  return { now: () => fixed };
}

export async function setTestClock(db: D1Database, ms: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO test_state (key, value)
       VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    )
    .bind(CLOCK_KEY, String(ms))
    .run();
}
