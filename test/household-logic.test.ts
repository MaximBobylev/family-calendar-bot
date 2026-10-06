import { describe, expect, it } from "vitest";
import {
  cleanHouseholdName,
  defaultHouseholdCalendars,
  inviteLink,
  isAddressedToBot,
  parseHomeStart,
  parseHouseholdCommand,
  parseNameAndAliases,
  stripBotMention,
} from "../src/bot/household/logic";

const BOT = "cab_test_bot";

describe("parseHouseholdCommand", () => {
  it("создание дома фразой и командой", () => {
    expect(parseHouseholdCommand('Создай дом "Бобылевы"')).toEqual({ kind: "create", name: "Бобылевы" });
    expect(parseHouseholdCommand("создать дом «Бобылевы»")).toEqual({ kind: "create", name: "Бобылевы" });
    expect(parseHouseholdCommand("/home create  Дом у реки ")).toEqual({ kind: "create", name: "Дом у реки" });
    expect(parseHouseholdCommand("/home create")).toEqual({ kind: "help" });
  });

  it("меню, выход, привязка группы", () => {
    expect(parseHouseholdCommand("/home")).toEqual({ kind: "menu" });
    expect(parseHouseholdCommand("/home@cab_test_bot")).toEqual({ kind: "menu" });
    expect(parseHouseholdCommand("/leave")).toEqual({ kind: "leave" });
    expect(parseHouseholdCommand("/home link")).toEqual({ kind: "link" });
    expect(parseHouseholdCommand("/home unlink")).toEqual({ kind: "unlink" });
    expect(parseHouseholdCommand("/home что-то")).toEqual({ kind: "help" });
  });

  it("имя, дети, приглашение с именем", () => {
    expect(parseHouseholdCommand("/home name Дима, муж, папа")).toEqual({ kind: "name", name: "Дима", aliases: ["муж", "папа"] });
    expect(parseHouseholdCommand("/home kid Маша, Машенька")).toEqual({ kind: "kid", name: "Маша", aliases: ["Машенька"] });
    expect(parseHouseholdCommand("/home kid")).toEqual({ kind: "help" });
    expect(parseHouseholdCommand("/home invite")).toEqual({ kind: "invite" });
    expect(parseHouseholdCommand("/home invite Бабушка, баба Валя")).toEqual({ kind: "invite", preset: { name: "Бабушка", aliases: ["баба Валя"] } });
  });

  it("обычные фразы — не команды дома", () => {
    expect(parseHouseholdCommand("Что у нас завтра?")).toBeNull();
    expect(parseHouseholdCommand("Создай встречу завтра")).toBeNull();
    expect(parseHouseholdCommand("/homework")).toBeNull();
  });
});

describe("parseNameAndAliases", () => {
  it("убирает пустые и повторы без учёта регистра", () => {
    expect(parseNameAndAliases(" Аня ,, жена; мама, ЖЕНА ")).toEqual({ name: "Аня", aliases: ["жена", "мама"] });
    expect(parseNameAndAliases(" , ")).toBeNull();
  });
});

describe("cleanHouseholdName", () => {
  it("снимает кавычки", () => {
    expect(cleanHouseholdName("«Бобылевы»")).toBe("Бобылевы");
    expect(cleanHouseholdName('  "  "  ')).toBeNull();
  });
});

describe("приглашение", () => {
  it("код из /start home_<code>", () => {
    expect(parseHomeStart("/start home_AbC-12_xyz")).toBe("AbC-12_xyz");
    expect(parseHomeStart("/start")).toBeNull();
    expect(parseHomeStart("/start home_")).toBeNull();
    expect(parseHomeStart("/start home_a b")).toBeNull();
  });
  it("ссылка; без имени бота — команда", () => {
    expect(inviteLink(BOT, "abc123")).toBe("https://t.me/cab_test_bot?start=home_abc123");
    expect(inviteLink("", "abc123")).toBe("/start home_abc123");
  });
});

describe("defaultHouseholdCalendars", () => {
  it("только «семейные» с правом записи; основной (личный) календарь владельца — нет (ревью R1)", () => {
    const cal = (id: string, title: string, writable = true, isDefault = false, aliases: string[] = []) => ({ id, title, writable, isDefault, aliases });
    expect(
      defaultHouseholdCalendars([
        cal("me", "Иван", true, true),
        cal("fam", "Семья"),
        cal("hol", "Праздники", false),
        cal("work", "Работа"),
        cal("x", "Family Budget"),
        cal("y", "Kids", true, false, ["общий"]),
        cal("ro", "Семейный (чтение)", false),
      ]),
    ).toEqual(["fam", "x", "y"]);
  });
  it("основной календарь с семейным названием тоже не отмечаем — нет семейных — пусто", () => {
    const cal = (id: string, title: string, isDefault = false) => ({ id, title, writable: true, isDefault, aliases: [] });
    expect(defaultHouseholdCalendars([cal("me", "Семья Ивана", true), cal("w", "Работа")])).toEqual([]);
  });
});

describe("обращение к боту в группе", () => {
  const msg = (text: string, replyToBot?: string) => ({
    text,
    ...(replyToBot !== undefined ? { reply_to_message: { message_id: 1, from: { id: 1, is_bot: true, first_name: "B", username: replyToBot } } } : {}),
  });
  it("команды, упоминания и ответы боту", () => {
    expect(isAddressedToBot(msg("/home link"), BOT)).toBe(true);
    expect(isAddressedToBot(msg("/home@Cab_Test_Bot link"), BOT)).toBe(true);
    expect(isAddressedToBot(msg("/home@other_bot link"), BOT)).toBe(false);
    expect(isAddressedToBot(msg("@cab_test_bot что у нас завтра?"), BOT)).toBe(true);
    expect(isAddressedToBot(msg("что у нас, @cab_test_bot?"), BOT)).toBe(true);
    expect(isAddressedToBot(msg("что у нас завтра?"), BOT)).toBe(false);
    expect(isAddressedToBot(msg("пиши на mail@cab_test_bot.ru"), BOT)).toBe(false);
    expect(isAddressedToBot(msg("@cab_test_bot_fan привет"), BOT)).toBe(false);
    expect(isAddressedToBot(msg("а в субботу?", BOT), BOT)).toBe(true);
    expect(isAddressedToBot(msg("а в субботу?", "other_bot"), BOT)).toBe(false);
  });
  it("обращение убирается из текста команды", () => {
    expect(stripBotMention("@cab_test_bot, что у нас в выходные?", BOT)).toBe("что у нас в выходные?");
    expect(stripBotMention("что у нас в выходные @cab_test_bot?", BOT)).toBe("что у нас в выходные?");
    expect(stripBotMention("/home@cab_test_bot link", BOT)).toBe("/home link");
    expect(stripBotMention("  что у нас  ", "")).toBe("что у нас");
  });
});
