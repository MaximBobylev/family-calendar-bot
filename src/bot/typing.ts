// «печатает…» до ответа (US-10): Telegram гасит индикатор через ~5 с — повторяем каждые ~4 с.
// Таймер живёт только пока обрабатывается команда: stop() обязателен (в finally), иначе Worker держит интервал.

/** Чуть меньше 5 с, через которые Telegram гасит индикатор. */
export const TYPING_REFRESH_MS = 4000;

/** Отправить «печатает…» сейчас и повторять до вызова stop(). Ошибки отправки не важны — глотаем. */
export function keepTyping(send: () => Promise<unknown>, intervalMs = TYPING_REFRESH_MS): () => void {
  const ping = () => {
    send().catch(() => undefined);
  };
  ping();
  const timer = setInterval(ping, intervalMs);
  return () => clearInterval(timer);
}
