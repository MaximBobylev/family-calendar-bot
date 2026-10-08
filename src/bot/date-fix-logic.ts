// Метрика «пользователь поправил дату сразу после карточки» (`date_fix`, tech-debt #26, ревью дат 2026-10-08 шаг 3).
// Чистая классификация без ввода-вывода: что считается правкой и какой (юнит-тесты — test/date-fix-logic.test.ts).

import type { CreateOption, DateSource, StartAgreement } from "./create-logic";

/**
 * option_llm — в карточке с вариантами выбран вариант из `start` от LLM, а не наш (наш парсер ошибся);
 * option_ours — выбран не первый из наших вариантов («в 9» → 21:00 / завтра 09:00: выбор, но и сигнал правила по умолчанию);
 * modify — в окне карточки изменено время только что созданного события («нет, в 16», «перенеси на 16»);
 * recreate — карточку отменили (или созданное отменили «Отменить») и в окне создали то же по названию на другую дату.
 */
export type DateFixKind = "option_ours" | "option_llm" | "modify" | "recreate";

/** Окно, в котором правка считается правкой этой карточки, — как окно карточки (CARD_TTL_MS, 15 мин). */
export const DATE_FIX_WINDOW_MS = 15 * 60 * 1000;

/** Что помним о последней карточке создания (dialog_state.dateFix): без текста, кроме названия для сравнения. */
export interface DateFixWatch {
  /** created — событие создано; cancelled — карточку отменили или созданное откатили. */
  stage: "created" | "cancelled";
  /** id события у провайдера (только для created). */
  eventId?: string;
  title: string;
  /** Ключ даты варианта (optionWhen). */
  when: string;
  source: DateSource;
  agreement?: StartAgreement;
  at: number;
  /** Правку этой карточки уже учли (выбран другой вариант, пересоздание) — вторую не считаем. */
  fixed?: true;
}

export type DateFixEvent =
  /** Нажата кнопка создания на карточке: номер варианта, все варианты карточки, название и дата выбранного. */
  | { k: "pick"; options: Pick<CreateOption, "fromLlm" | "series">[]; index: number; title: string; when: string }
  /** Подтверждено изменение события; timeChanged — менялось начало. */
  | { k: "modify"; eventId: string; timeChanged: boolean };

/** Расхождение парсера и LLM в date_check: обе стороны дали дату, и разную. */
export const checkDisagreed = (a: StartAgreement | undefined) => a === "differ" || a === "llm_invented";

/** Дата варианта для сравнения «другая дата»: день + время (или «весь день»). */
export function optionWhen(o: Pick<CreateOption, "startDay" | "start" | "allDay">): string {
  return `${o.startDay}:${o.allDay || !o.start ? "all" : o.start.minutes}`;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ");

/** Правка ли это и какая; undefined — нет. Одна карточка — не больше одной правки (вызывающий сбрасывает watch). */
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
