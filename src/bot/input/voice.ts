// Голосовое → текст (US-10): проверка длины и размера, лимит STT, скачивание, цепочка STT, журнал (US-13),
// поправки известных ошибок Whisper и ответ «Услышал: …». Повтор апдейта после сбоя (tech-debt #5) берёт текст из inbox:
// STT не вызывается снова, «🎙 …» не отправляется дважды.

import { recordFeature } from "../../db/features";
import { recordUsage } from "../../db/usage";
import { markHeardSent, saveTranscript } from "../../inbox";
import type { User } from "../../db/users";
import { sttCostMicroUsd } from "../../limits";
import { fixTranscript, isEmptySpeech, SttChainError, transcribeChain, type Transcript } from "../../stt/whisper";
import type { TgMessage } from "../../telegram/types";
import type { AppContext } from "../context";
import { rememberRateHeaders } from "../../ops/quotas";
import { escapeHtml } from "../format";
import { t } from "../messages";
import { withinLimit } from "./limit";

const MAX_VOICE_SEC = 60;
/** duration указывает отправитель; размер ограничиваем отдельно (≈1 мин Opus — ~200 КБ). */
const MAX_VOICE_BYTES = 2 * 1024 * 1024;

/** Голосовое → текст (US-10). null — уже ответили пользователю (слишком длинное, не расслышал, ошибка). */
export async function recognizeVoice(ctx: AppContext, user: User, message: TgMessage): Promise<string | null> {
  const chatId = message.chat.id;
  const voice = (message.voice ?? message.audio)!;
  // Повтор после сбоя: распознано прошлой попыткой — без лимита, скачивания и STT (tech-debt #5)
  const done = ctx.progress?.transcript;
  if (done) {
    if (!ctx.progress?.heardSent) await sendHeard(ctx, user, chatId, done);
    return done;
  }
  // Длинное — отказ без скачивания и без затрат на STT
  if (voice.duration > MAX_VOICE_SEC || (voice.file_size ?? 0) > MAX_VOICE_BYTES) {
    await ctx.telegram.sendMessage(chatId, t("voiceTooLong", user.locale));
    return null;
  }
  if (!(await withinLimit(ctx, user, "stt", chatId))) return null;
  let audio: ArrayBuffer;
  try {
    audio = await ctx.telegram.downloadFile(voice.file_id);
  } catch (e) {
    console.error("voice download failed", e);
    await ctx.telegram.sendMessage(chatId, t("voiceDownloadFailed", user.locale));
    return null;
  }
  const audioMs = voice.duration * 1000;
  let transcript: Transcript;
  try {
    const res = await transcribeChain(ctx.config.stt, audio);
    transcript = res.transcript;
    if (transcript.rateHeaders) await rememberRateHeaders(ctx, [{ provider: res.via.name ?? res.via.baseUrl, headers: transcript.rateHeaders, status: 200 }]);
    const costs = res.via.perMin !== undefined ? { ...ctx.config.costs, sttPerMin: res.via.perMin } : ctx.config.costs;
    await recordUsage(ctx.db, {
      userId: user.id,
      kind: "stt",
      provider: res.via.name ?? res.via.baseUrl,
      model: res.via.model,
      audioMs,
      costMicroUsd: sttCostMicroUsd(costs, audioMs),
      text: transcript.text,
      result: { language: transcript.language, ...(res.failed.length ? { fallbackFrom: res.failed } : {}) },
      outcome: "ok",
      now: ctx.clock.now(),
    });
  } catch (e) {
    console.error("stt failed", e);
    const first = ctx.config.stt[0];
    await recordUsage(ctx.db, {
      userId: user.id,
      kind: "stt",
      // Как у LLM (nlu-step.ts): упала вся цепочка — «chain» и список причин; иначе — сбой вне цепочки (D1 и т.п.)
      provider: e instanceof SttChainError ? "chain" : (first?.name ?? first?.baseUrl ?? "none"),
      model: first?.model ?? "none",
      audioMs,
      result: e instanceof SttChainError ? { failed: e.failed } : String(e),
      outcome: "error",
      now: ctx.clock.now(),
    });
    await ctx.telegram.sendMessage(chatId, t("sttUnavailable", user.locale));
    return null;
  }
  if (isEmptySpeech(transcript.text)) {
    await ctx.telegram.sendMessage(chatId, t("notHeard", user.locale));
    return null;
  }
  // Известные ошибки Whisper («от Мини» → «отмени»); показываем уже исправленное — то, что бот понял
  const heard = fixTranscript(transcript.text);
  if (ctx.progress) await saveTranscript(ctx.db, ctx.progress.updateId, heard);
  await sendHeard(ctx, user, chatId, heard);
  return heard;
}

/** Показываем, что услышали, — до долгой обработки (US-10); отметка в inbox — чтобы повтор не прислал второй раз. */
async function sendHeard(ctx: AppContext, user: User, chatId: number, heard: string): Promise<void> {
  await ctx.telegram.sendMessage(chatId, t("heard", user.locale, { text: escapeHtml(heard) }), undefined, { html: true });
  if (ctx.progress) await markHeardSent(ctx.db, ctx.progress.updateId);
  await recordFeature(ctx.db, user.id, "voice", ctx.clock.now());
}
