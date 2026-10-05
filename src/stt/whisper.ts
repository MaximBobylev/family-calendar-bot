// Распознавание речи: Whisper на Workers AI через REST `/ai/run/<model>` (OpenAI-совместимого
// `/audio/transcriptions` у Workers AI нет — проверено 2026-10-04). В тестах адрес указывает на фейк.
//
// Замер (2026-10-04): OGG/Opus из Telegram принимается как есть; vad_filter убирает «Thank you.» на тишине;
// жёсткий language ломает английские голосовые; initial_prompt на качество названий не влияет.

import { fetchWithTimeout, TIMEOUTS } from "../net/fetch";

export interface SttConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface Transcript {
  text: string;
  language?: string;
  durationSec?: number;
}

export async function transcribe(cfg: SttConfig, audio: ArrayBuffer): Promise<Transcript> {
  const bytes = new Uint8Array(audio);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const res = await fetchWithTimeout(
    `${cfg.baseUrl}/run/${cfg.model}`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ audio: btoa(binary), vad_filter: true }),
    },
    TIMEOUTS.stt,
  );
  if (!res.ok) throw new Error(`stt ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { result?: { text?: string; transcription_info?: { language?: string; duration?: number } } };
  const info = json.result?.transcription_info;
  return {
    text: (json.result?.text ?? "").trim(),
    ...(info?.language ? { language: info.language } : {}),
    ...(info?.duration !== undefined ? { durationSec: info.duration } : {}),
  };
}

/** Типичные «галлюцинации» Whisper на тишине и шуме — считаем, что ничего не сказано (US-10). */
const HALLUCINATIONS = [
  /^продолжение следует/i,
  /субтитр/i,
  /^спасибо за (просмотр|внимание)/i,
  /^подписывайтесь/i,
  /^thank you( for watching)?\.?$/i,
  /^thanks for watching/i,
  /^you\.?$/i,
  /^\.+$/,
];

export function isEmptySpeech(text: string): boolean {
  const t = text.trim();
  return t.length === 0 || HALLUCINATIONS.some((p) => p.test(t));
}
