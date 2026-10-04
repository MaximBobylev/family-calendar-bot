// Обработка апдейта из inbox — общая для consumer'а очереди и /__test/drain.

import { handleUpdate } from "./bot/handle-update";
import type { AppContext } from "./bot/context";
import { claimUpdate, completeUpdate } from "./inbox";

export async function processInboxUpdate(ctx: AppContext, updateId: number): Promise<void> {
  const update = await claimUpdate(ctx.db, updateId);
  if (!update) return; // уже обработан
  try {
    await handleUpdate(ctx, update);
    await completeUpdate(ctx.db, updateId, ctx.clock.now());
  } catch (e) {
    await completeUpdate(ctx.db, updateId, ctx.clock.now(), String(e));
    throw e;
  }
}
