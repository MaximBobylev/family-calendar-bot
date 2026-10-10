// Метрика date_fix (tech-debt #26): поправил ли пользователь дату сразу после карточки. Без ввода-вывода.

import type { CreateOption, DateSource, StartAgreement } from "./create-logic";

// option_llm — выбран вариант от LLM, а не наш (наш парсер ошибся);
// option_ours — выбран не первый из наших вариантов («в 9» → 21:00 / завтра 09:00: выбор, но и сигнал правила по умолчанию);
// modify — в окне изменено время только что созданного события («нет, в 16»);
// recreate — карточку или созданное отменили и в окне создали то же по названию на другую дату.
export type DateFixKind = "option_ours" | "option_llm" | "modify" | "recreate";

// Как время жизни карточки (CARD_TTL_MS)
export const DATE_FIX_WINDOW_MS = 15 * 60 * 1000;

// Без текста пользователя, кроме названия для сравнения
export interface DateFixWatch {
  stage: "created" | "cancelled";
  eventId?: string;
  title: string;
  when: string;
  source: DateSource;
  agreement?: StartAgreement;
  at: number;
  // Правку этой карточки уже учли — вторую не считаем
  fixed?: true;
}

export type DateFixEvent =
  | { k: "pick"; options: Pick<CreateOption, "fromLlm" | "series">[]; index: number; title: string; when: string }
  | { k: "modify"; eventId: string; timeChanged: boolean };

export const checkDisagreed = (a: StartAgreement | undefined) => a === "differ" || a === "llm_invented";

export function optionWhen(o: Pick<CreateOption, "startDay" | "start" | "allDay">): string {
  return `${o.startDay}:${o.allDay || !o.start ? "all" : o.start.minutes}`;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ");

// Одна карточка — не больше одной правки: вызывающий сбрасывает watch
export function classifyDateFix(w: DateFixWatch | undefined, e: DateFixEvent, now: number): DateFixKind | undefined {
  if (e.k === "pick") {
    // Варианты серии на 29–31 число — выбор правила, а не даты
    const dated = e.options.length > 1 && !e.options[0]?.series;
    if (dated && e.index > 0) return e.options[e.index]?.fromLlm ? "option_llm" : "option_ours";
    const fresh = w?.stage === "cancelled" && now - w.at <= DATE_FIX_WINDOW_MS;
    if (fresh && norm(w.title) === norm(e.title) && w.when !== e.when) return "recreate";
    return undefined;
  }
  const fresh = w?.stage === "created" && now - w.at <= DATE_FIX_WINDOW_MS;
  return fresh && !w.fixed && e.timeChanged && w.eventId === e.eventId ? "modify" : undefined;
}
