// Переслушивание голосового мультимодальной моделью (multimodal-voice, вариант D): повтор фразы, «не так»
// или «не понимаю» от текстового пути. Повторное скачивание по file_id, журнал (US-13), затем routeIntent.

import { calendarNamesOf } from "../db/accounts";
import { mergeDialogState } from "../db/conversations";
import { recordFeature } from "../db/features";
import { recordUsage } from "../db/usage";
import type { User } from "../db/users";
import { llmCostMicroUsd } from "../limits";
import { understandVoiceChain } from "../voice/understand";
import type { AppContext } from "./context";
import { escapeHtml } from "./format";
import { withinLimit } from "./input/limit";
import { t } from "./messages";
import { routeIntent } from "./route-intent";

/**
 * Переслушать голосовое мультимодальной моделью (multimodal-voice, вариант D): то же сообщение по file_id —
 * Telegram отдаёт файл повторно, хранить аудио не нужно. false — эскалация не настроена (идём обычным путём).
 * Одно голосовое переслушиваем не больше одного раза.
 */
export async function escalateVoice(
  ctx: AppContext,
  user: User,
  chatId: number,
  conversationId: string,
  voice: { fileId: string; durationSec: number; transcript: string; at: number; reheard?: boolean },
): Promise<boolean> {
  if (ctx.config.voice.length === 0) return false;
  if (voice.reheard) {
    await ctx.telegram.sendMessage(chatId, t("reheardAlready", user.locale));
    return true;
  }
  if (!(await withinLimit(ctx, user, "llm", chatId))) return true;
  await mergeDialogState(ctx.db, conversationId, user.id, { lastVoice: { ...voice, reheard: true } }, ctx.clock.now());

  let audio: ArrayBuffer;
  try {
    audio = await ctx.telegram.downloadFile(voice.fileId);
  } catch (e) {
    console.error("voice re-download failed", e);
    await ctx.telegram.sendMessage(chatId, t("reheardFailed", user.locale));
    return true;
  }
  const audioMs = voice.durationSec * 1000;
  let res: Awaited<ReturnType<typeof understandVoiceChain>>;
  try {
    res = await understandVoiceChain(ctx.config.voice, audio, await calendarNamesOf(ctx.db, user.id));
  } catch (e) {
    console.error("voice understanding failed", e);
    await recordUsage(ctx.db, {
      userId: user.id,
      kind: "llm",
      provider: "voice-chain",
      model: ctx.config.voice[0]?.model ?? "none",
      audioMs,
      text: voice.transcript,
      result: { reheard: true, error: String(e).slice(0, 500) },
      outcome: "error",
      now: ctx.clock.now(),
    });
    await ctx.telegram.sendMessage(chatId, t("reheardFailed", user.locale));
    return true;
  }
  const { result, via } = res;
  await recordUsage(ctx.db, {
    userId: user.id,
    kind: "llm",
    provider: via.name ?? via.baseUrl,
    model: via.model,
    audioMs,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    costMicroUsd: llmCostMicroUsd({ ...ctx.config.costs, llmInPerM: via.inPerM ?? 0, llmOutPerM: via.outPerM ?? 0 }, result.tokensIn, result.tokensOut),
    text: result.noSpeech ? voice.transcript : result.transcript,
    // Что слышал Whisper и что услышала модель — расхождения видны в журнале (/admin)
    result: result.noSpeech
      ? { reheard: true, noSpeech: true, whisper: voice.transcript }
      : { ...result.intent, reheard: true, whisper: voice.transcript, ...(res.failed.length ? { fallbackFrom: res.failed } : {}) },
    outcome: "ok",
    now: ctx.clock.now(),
  });
  if (result.noSpeech) {
    await ctx.telegram.sendMessage(chatId, t("notHeard", user.locale));
    return true;
  }
  await ctx.telegram.sendMessage(chatId, t("reheard", user.locale, { text: escapeHtml(result.transcript) }), undefined, { html: true });
  await recordFeature(ctx.db, user.id, "voice_rehear", ctx.clock.now());
  await mergeDialogState(ctx.db, conversationId, user.id, { lastVoice: { ...voice, transcript: result.transcript, reheard: true } }, ctx.clock.now());
  await routeIntent(ctx, user, chatId, conversationId, result.transcript, result.intent);
  return true;
}
