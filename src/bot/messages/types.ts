// Части словаря — файлы рядом, сборка — bot/messages.ts.

export type Locale = "ru" | "en";

export type Messages = Record<string, Record<Locale, string>>;
