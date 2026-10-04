// Учёт использования + журнал распознанного (US-13, ADR-0004): одна запись на вызов STT/LLM.

export interface UsageRecord {
  userId: string;
  kind: "stt" | "llm";
  provider: string;
  model: string;
  tokensIn?: number;
  tokensOut?: number;
  audioMs?: number;
  text?: string;
  result?: unknown;
  outcome: "ok" | "error";
  now: number;
}

export async function recordUsage(db: D1Database, r: UsageRecord): Promise<void> {
  await db
    .prepare(
      `INSERT INTO usage_events (id, user_id, created_at, kind, provider, model, audio_ms, tokens_in, tokens_out, text, result_json, outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(), r.userId, r.now, r.kind, r.provider, r.model,
      r.audioMs ?? null, r.tokensIn ?? null, r.tokensOut ?? null, r.text ?? null,
      r.result === undefined ? null : JSON.stringify(r.result), r.outcome,
    )
    .run();
}
