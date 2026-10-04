// Всё, что нужно обработчикам: конфиг, часы, БД, Telegram. Собирается один раз на запрос / пачку.

import type { Clock } from "../clock";
import type { Config } from "../config";
import { TelegramApi } from "../telegram/api";

export interface AppContext {
  config: Config;
  clock: Clock;
  db: D1Database;
  telegram: TelegramApi;
}

export function createContext(env: Env, config: Config, clock: Clock): AppContext {
  return {
    config,
    clock,
    db: env.DB,
    telegram: new TelegramApi(config.telegramApiBase, config.telegramBotToken),
  };
}
