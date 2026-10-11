// В callback_data — только id карточки и выбор: данные карточки живут в D1. Telegram ограничивает поле 64 байтами.

export const callbackData = (actionId: string, choice: string) => `pa:${actionId}:${choice}`;

export function parseCallbackData(data: string | undefined): { actionId: string; choice: string } | null {
  const m = /^pa:([0-9a-f]+):(\w+)$/.exec(data ?? "");
  return m ? { actionId: m[1]!, choice: m[2]! } : null;
}
