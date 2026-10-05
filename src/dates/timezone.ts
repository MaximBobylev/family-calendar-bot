// Часовой пояс из ввода пользователя (/settings → «Другой…», US-07): IANA, UTC±N или город из списка.

export const TZ_PRESETS: { ru: string; en: string; tz: string }[] = [
  { ru: "Москва", en: "Moscow", tz: "Europe/Moscow" },
  { ru: "Калининград", en: "Kaliningrad", tz: "Europe/Kaliningrad" },
  { ru: "Екатеринбург", en: "Yekaterinburg", tz: "Asia/Yekaterinburg" },
  { ru: "Новосибирск", en: "Novosibirsk", tz: "Asia/Novosibirsk" },
  { ru: "Тбилиси", en: "Tbilisi", tz: "Asia/Tbilisi" },
  { ru: "Ереван", en: "Yerevan", tz: "Asia/Yerevan" },
  { ru: "Белград", en: "Belgrade", tz: "Europe/Belgrade" },
  { ru: "Лиссабон", en: "Lisbon", tz: "Europe/Lisbon" },
  { ru: "Лондон", en: "London", tz: "Europe/London" },
  { ru: "Сан-Паулу", en: "São Paulo", tz: "America/Sao_Paulo" },
];

/** «Europe/Berlin», «UTC+4», «GMT-3», «Тбилиси» → IANA-пояс или undefined. */
export function parseTimeZone(input: string): string | undefined {
  const s = input.trim();
  const preset = TZ_PRESETS.find((p) => [p.ru, p.en].some((n) => n.toLowerCase() === s.toLowerCase()));
  if (preset) return preset.tz;
  const offset = /^(?:utc|gmt|мск)?\s*([+-])\s*(\d{1,2})$/i.exec(s);
  if (offset) {
    const h = Number(offset[2]);
    if (h > 14) return undefined;
    if (h === 0) return "UTC";
    // В Etc/GMT знак обратный: UTC+4 = Etc/GMT-4
    return `Etc/GMT${offset[1] === "+" ? "-" : "+"}${h}`;
  }
  if (/^(utc|gmt)$/i.test(s)) return "UTC";
  if (!/^[A-Za-z_]+(\/[A-Za-z_+-]+){1,2}$/.test(s)) return undefined;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: s }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

