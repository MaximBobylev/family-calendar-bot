// stop() обязателен (в finally): иначе Worker держит интервал.

// Telegram гасит индикатор через ~5 с
export const TYPING_REFRESH_MS = 4000;

export function keepTyping(send: () => Promise<unknown>, intervalMs = TYPING_REFRESH_MS): () => void {
  const ping = () => {
    send().catch(() => undefined);
  };
  ping();
  const timer = setInterval(ping, intervalMs);
  return () => clearInterval(timer);
}
