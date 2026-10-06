import { describe, expect, it } from "vitest";
import {
  assignOverride,
  familyTitle,
  findMentioned,
  isMyTasksQuestion,
  matchNamed,
  parseAssignPhrase,
  planAssignmentJobs,
  responsibleClause,
  sameName,
  taskTitle,
} from "../src/bot/assign/logic";

const members = [
  { userId: "u1", names: ["Иван", "муж", "папа"] },
  { userId: "u2", names: ["Аня", "жена", "мама"] },
  { userId: "u3", names: ["Дима"] },
];
const kids = [
  { id: "k1", name: "Маша", names: ["Маша", "Машенька"] },
  { id: "k2", name: "Ваня", names: ["Ваня"] },
];

describe("sameName: падежи имён и других имён", () => {
  it("совпадает в косвенных падежах", () => {
    for (const [w, n] of [
      ["мужу", "муж"],
      ["Диме", "Дима"],
      ["папе", "папа"],
      ["Ане", "Аня"],
      ["Машу", "Маша"],
      ["Вани", "Ваня"],
      ["маме", "мама"],
      ["Ваню", "Ваня"],
    ])
      expect([w, n, sameName(w!, n!)]).toEqual([w, n, true]);
  });
  it("разные имена не путает", () => {
    for (const [w, n] of [
      ["Валя", "Ваня"],
      ["маша", "мама"],
      ["Паша", "папа"],
      ["мне", "муж"],
      ["Дима", "Дина"],
    ])
      expect([w, n, sameName(w!, n!)]).toEqual([w, n, false]);
  });
  it("участник по другому имени", () => {
    expect(matchNamed("мужу", members).map((m) => m.userId)).toEqual(["u1"]);
    expect(matchNamed("Ане", members).map((m) => m.userId)).toEqual(["u2"]);
    expect(matchNamed("маме", members).map((m) => m.userId)).toEqual(["u2"]);
    expect(matchNamed("Пете", members)).toEqual([]);
  });
  it("ребёнок в тексте поручения", () => {
    expect(findMentioned("забрать Машу из школы", kids)?.id).toBe("k1");
    expect(findMentioned("отвезти Ваню на плавание", kids)?.id).toBe("k2");
    expect(findMentioned("купить торт", kids)).toBeUndefined();
  });
});

describe("parseAssignPhrase", () => {
  it("кому и что", () => {
    expect(parseAssignPhrase("Напомни мужу забрать Машу из школы в 17")).toEqual({ assignee: "мужу", rest: "забрать Машу из школы в 17" });
    expect(parseAssignPhrase("Пусть Аня завтра купит торт")).toEqual({ assignee: "Аня", rest: "завтра купит торт" });
    expect(parseAssignPhrase("Попроси Диму, чтобы забрал посылку")).toEqual({ assignee: "Диму", rest: "забрал посылку" });
    expect(parseAssignPhrase("Remind John to buy milk")).toEqual({ assignee: "John", rest: "buy milk" });
  });
  it("кто-то должен", () => {
    expect(parseAssignPhrase("Кто-то должен отвезти Ваню на плавание в субботу")).toEqual({ someone: true, rest: "отвезти Ваню на плавание в субботу" });
    expect(parseAssignPhrase("кто-нибудь может купить хлеб?")).toEqual({ someone: true, rest: "купить хлеб?" });
    expect(parseAssignPhrase("Someone has to walk the dog")).toEqual({ someone: true, rest: "walk the dog" });
  });
  it("себе и обычные команды — не поручение", () => {
    expect(parseAssignPhrase("Напомни мне завтра позвонить маме")).toBeNull();
    expect(parseAssignPhrase("Завтра в 15 стоматолог")).toBeNull();
    expect(parseAssignPhrase("Перенеси встречу на пятницу")).toBeNull();
    expect(parseAssignPhrase("Напомни на почту за день до созвона с Машей")).toBeNull();
    expect(parseAssignPhrase("Напомни за 15 минут до стендапа")).toBeNull();
  });
});

describe("assignOverride", () => {
  it("сильные слова важнее интента LLM", () => {
    expect(assignOverride("Пусть Аня завтра отменит бронь", { name: "delete_event" })).toEqual({ name: "assign_task", assignee: "Аня" });
    expect(assignOverride("Кто-то должен отвезти Ваню", { name: "create_event", start: "" })).toEqual({ name: "assign_task", someone: true });
    expect(assignOverride("Завтра в 15 стоматолог", { name: "create_event", start: "Завтра в 15" })).toBeNull();
  });
  it("мои дела", () => {
    expect(isMyTasksQuestion("мои дела")).toBe(true);
    expect(isMyTasksQuestion("Что на мне завтра?")).toBe(true);
    expect(isMyTasksQuestion("какие у меня поручения")).toBe(true);
    expect(isMyTasksQuestion("что у меня завтра")).toBe(false);
    expect(assignOverride("что на мне завтра", { name: "list_events", range: "завтра" })).toEqual({ name: "list_assignments" });
  });
  it("что я поручил (ревью R1 #10)", () => {
    expect(assignOverride("Что я поручил?", { name: "unsupported" })).toEqual({ name: "list_assignments", byMe: true });
    expect(assignOverride("мои поручения", { name: "unsupported" })).toEqual({ name: "list_assignments", byMe: true });
    expect(assignOverride("кому что я поручила", { name: "unsupported" })).toEqual({ name: "list_assignments", byMe: true });
  });
  it("LLM сказала assign_task, но это напоминание себе или у события — защита по тексту важнее (QA-13)", () => {
    expect(assignOverride("Напомни мне завтра купить хлеб", { name: "assign_task", assignee: "мне", when: "завтра", task: "купить хлеб" })).toEqual({
      name: "create_event",
      start: "завтра",
      title: "купить хлеб",
    });
    expect(assignOverride("Напомни за день до плавания", { name: "assign_task", assignee: "за день" })).toEqual({ name: "modify_event" });
    expect(assignOverride("Напомни мужу купить хлеб", { name: "assign_task", assignee: "мужу", task: "купить хлеб" })).toEqual({
      name: "assign_task",
      assignee: "мужу",
      task: "купить хлеб",
    });
  });
});

describe("название поручения", () => {
  it("без дат и с заглавной", () => {
    expect(taskTitle("забрать Машу из школы в 17", ["в 17"])).toBe("Забрать Машу из школы");
    expect(taskTitle("завтра купит торт", ["завтра"])).toBe("Купит торт");
    expect(taskTitle("в 17", ["в 17"])).toBeNull();
  });
});

describe("ответственный и для кого (US-92)", () => {
  it("кусок «отводит папа»", () => {
    expect(responsibleClause("Стоматолог Вани в четверг в 16, отводит папа")).toEqual({ who: "папа", clause: ", отводит папа" });
    expect(responsibleClause("Плавание Маши в субботу в 10 — забирает Дима")).toEqual({ who: "Дима", clause: "— забирает Дима" });
    expect(responsibleClause("Стоматолог в четверг в 16")).toBeNull();
  });
  it("ребёнок в скобках, без повтора в названии", () => {
    expect(familyTitle("Стоматолог Вани", kids[1]!)).toBe("Стоматолог (Ваня)");
    expect(familyTitle("Плавание Маши", kids[0]!)).toBe("Плавание (Маша)");
    expect(familyTitle("ДР у Маши", kids[0]!)).toBe("ДР (Маша)");
    expect(familyTitle("Стоматолог", kids[1]!)).toBe("Стоматолог (Ваня)");
    expect(familyTitle("Маша", kids[0]!)).toBe("Маша (Маша)");
  });
});

describe("planAssignmentJobs", () => {
  const tz = "Europe/Moscow";
  const at = (iso: string) => Date.parse(iso);
  const plan = (due: string, now: string, hasTime = true, named = true) =>
    planAssignmentJobs({ dueAt: at(due), hasTime, now: at(now), tz, named }).map((p) => [p.what, new Date(p.fireAt).toISOString()]);

  it("сегодня: «ответьте» за 3 ч, эскалация за 2 ч — после напоминания, за 1 ч, истекает в конце дня (ревью R1 #6)", () => {
    expect(plan("2026-10-07T14:00:00Z", "2026-10-07T07:00:00Z")).toEqual([
      ["ask", "2026-10-07T11:00:00.000Z"],
      ["escalate", "2026-10-07T12:00:00.000Z"],
      ["hour", "2026-10-07T13:00:00.000Z"],
      ["expire", "2026-10-07T21:00:00.000Z"],
    ]);
  });
  it("завтра и позже: ещё и за день", () => {
    expect(plan("2026-10-10T07:00:00Z", "2026-10-07T07:00:00Z").map((p) => p[0])).toEqual(["day", "ask", "escalate", "hour", "expire"]);
  });
  it("эскалация не раньше первого напоминания + 30 мин: за 2,5 ч — напоминание за час, эскалация за 30 мин", () => {
    expect(plan("2026-10-07T14:00:00Z", "2026-10-07T11:30:00Z")).toEqual([
      ["hour", "2026-10-07T13:00:00.000Z"],
      ["escalate", "2026-10-07T13:30:00.000Z"],
      ["expire", "2026-10-07T21:00:00.000Z"],
    ]);
  });
  it("в прошлом не планируем: за полчаса — без напоминаний и эскалации", () => {
    expect(plan("2026-10-07T14:00:00Z", "2026-10-07T13:30:00Z").map((p) => p[0])).toEqual(["expire"]);
  });
  it("«кто-то должен»: напоминать некому, эскалация в свой срок", () => {
    expect(plan("2026-10-07T14:00:00Z", "2026-10-07T07:00:00Z", true, false).map((p) => p[0])).toEqual(["escalate", "hour", "expire"]);
  });
  it("без времени: утром в 9:00, эскалация в 12:00, истекает в полночь", () => {
    expect(plan("2026-10-07T21:00:00Z", "2026-10-07T07:00:00Z", false)).toEqual([
      ["morning", "2026-10-08T06:00:00.000Z"],
      ["escalate", "2026-10-08T09:00:00.000Z"],
      ["expire", "2026-10-08T21:00:00.000Z"],
    ]);
  });
  it("без времени, утро уже прошло: без эскалации (не раньше напоминания)", () => {
    expect(plan("2026-10-06T21:00:00Z", "2026-10-07T07:00:00Z", false).map((p) => p[0])).toEqual(["expire"]);
  });
  it("поздно вечером: истекает не раньше чем через 2 ч после срока", () => {
    expect(plan("2026-10-07T20:30:00Z", "2026-10-07T07:00:00Z").at(-1)).toEqual(["expire", "2026-10-07T22:30:00.000Z"]);
  });
});
