// Детерминированный парсер дат (ADR-0005 п.8). Вход — сырой фрагмент, вырезанный LLM.

import { parseLocal } from "./calendar";
import { parseDuration, parseShift } from "./duration";
import { parsePointOrRange } from "./point";
import { parseRecurrence } from "./recurrence";
import { tokenize } from "./tokenize";
import type { DateParser } from "./types";

export const parseDateFragment: DateParser = ({ text, kind, now, tz }) => {
  const tokens = tokenize(text);
  if (tokens.length === 0) return { error: "empty" };
  const nowMoment = parseLocal(now);
  switch (kind) {
    case "shift": return parseShift(tokens);
    case "duration": return parseDuration(tokens);
    case "recurrence": return parseRecurrence(tokens, nowMoment.day);
    case "point":
    case "range": return parsePointOrRange(tokens, kind, nowMoment, tz);
  }
};

export type * from "./types";
