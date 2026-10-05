// Обработка апдейта из inbox — общая для consumer'а очереди и /__test/drain.

import { handleUpdate } from "./bot/handle-update";
import type { AppContext } from "./bot/context";
import { claimUpdate, completeUpdate } from "./inbox";

export async function processInboxUpdate(ctx: AppContext, updateId: number): Promise<"processed" | "done" | "busy"> {
  const claim = await claimUpdate(ctx.db, updateId, ctx.clock.now());
  if (claim.status !== "claimed") return claim.status;
  try {
    await handleUpdate(ctx, claim.update);
    await completeUpdate(ctx.db, updateId, ctx.clock.now());
    return "processed";
  } catch (e) {
    await completeUpdate(ctx.db, updateId, ctx.clock.now(), String(e).slice(0, 500));
    throw e;
  }
}
