// Собирается один раз на запрос или пачку из очереди.

import type { Clock } from "../clock";
import type { Config } from "../config";
import type { UpdateProgress } from "../inbox";
import { TelegramApi } from "../telegram/api";

export interface AppContext {
  config: Config;
  clock: Clock;
  db: D1Database;
  telegram: TelegramApi;
  // Только при обработке апдейта из inbox: что сделано прошлыми попытками (tech-debt #5)
  progress?: UpdateProgress;
  // Участник без Google или групповой чат дома: чтение и запись через аккаунт владельца, только общие календари дома
  calendarScope?: CalendarScope;
}

export interface CalendarScope {
  householdId: string;
  householdName: string;
  ownerUserId: string;
  calendarIds: string[];
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
