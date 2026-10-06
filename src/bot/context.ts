// Всё, что нужно обработчикам: конфиг, часы, БД, Telegram. Собирается один раз на запрос / пачку.

import type { Clock } from "../clock";
import type { Config } from "../config";
import type { UpdateProgress } from "../inbox";
import { TelegramApi } from "../telegram/api";

export interface AppContext {
  config: Config;
  clock: Clock;
  db: D1Database;
  telegram: TelegramApi;
  /** Только при обработке апдейта из inbox: что сделано прошлыми попытками (tech-debt #5). */
  progress?: UpdateProgress;
  /**
   * Календари дома вместо своих (US-90, US-94): участник без Google или групповой чат дома — чтение и запись идут
   * через аккаунт владельца, только по общим календарям дома. Нет — свои календари пользователя.
   */
  calendarScope?: CalendarScope;
}

export interface CalendarScope {
  householdId: string;
  householdName: string;
  ownerUserId: string;
  calendarIds: string[];
  /** Основной общий календарь дома — туда записываются события по умолчанию (ревью R1, блокер 2). */
  defaultCalendarId?: string;
}

export function createContext(env: Env, config: Config, clock: Clock): AppContext {
  return {
    config,
    clock,
    db: env.DB,
    telegram: new TelegramApi(config.telegramApiBase, config.telegramBotToken),
  };
}
