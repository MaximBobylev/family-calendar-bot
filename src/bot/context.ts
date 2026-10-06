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
}

export function createContext(env: Env, config: Config, clock: Clock): AppContext {
  return {
    config,
    clock,
    db: env.DB,
    telegram: new TelegramApi(config.telegramApiBase, config.telegramBotToken),
  };
}
