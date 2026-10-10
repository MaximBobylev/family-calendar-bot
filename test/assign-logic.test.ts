import { describe, expect, it } from "vitest";
import {
  assignOverride,
  familyTitle,
  findMentioned,
  householdResponsible,
  isMyTasksQuestion,
  matchNamed,
  parseAssignPhrase,
  pickAssignee,
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
    expect(parseAssignPhrase("кто-нибудь может купить хлеб?")).toEqual({ someone: true, rest: "купить хлеб" });
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
  it("поручение без исполнителя и без «кто …?» — дело себе (регрессия c18)", () => {
    expect(
      assignOverride("Забрать детей из садика сегодня в шесть вечера", {
        name: "assign_task",
        when: "сегодня в шесть вечера",
        task: "Забрать детей из садика",
      }),
    ).toEqual({ name: "create_event", start: "сегодня в шесть вечера", title: "Забрать детей из садика" });
    // Вопрос к семье — «кто-то должен», решает LLM
    expect(assignOverride("Кто отвезёт Ваню на плавание в субботу?", { name: "assign_task", someone: true, task: "отвезти Ваню на плавание" })).toEqual({
      name: "assign_task",
      someone: true,
      task: "отвезти Ваню на плавание",
    });
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
    expect(responsibleClause("Стоматолог Вани в четверг в 16, отводит папа")).toEqual({ who: "папа", clause: ", отводит папа", strong: true });
    expect(responsibleClause("Плавание Маши в субботу в 10 — забирает Дима")).toEqual({ who: "Дима", clause: "— забирает Дима", strong: true });
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

const home = [
  { name: "Иван", names: ["Иван"] },
  { name: "Дима", names: ["Дима", "муж", "папа"] },
  { name: "Аня", names: ["Аня", "мама", "жена"] },
];
const children = [
  { id: "k1", name: "Маша", names: ["Маша"] },
  { id: "k2", name: "Ваня", names: ["Ваня"] },
  { id: "k3", name: "Соня", names: ["Соня"] },
];
const who = (w: string) => matchNamed(w, home).map((m) => m.name);

describe("#1 себе — событие, а не поручение (класс C)", () => {
  it("исполнитель «я / мне / me» от LLM", () => {
    expect(
      assignOverride("Напомни мне завтра в 10 позвонить в школу", { name: "assign_task", assignee: "я", when: "завтра в 10", task: "позвонить в школу" }),
    ).toEqual({ name: "create_event", start: "завтра в 10", title: "позвонить в школу" });
    expect(assignOverride("Remind me to call grandma on Sunday at 12", { name: "assign_task", assignee: "me", task: "call grandma" })).toEqual({
      name: "create_event",
      start: "",
      title: "call grandma",
    });
  });
  it("«напомни мне …» без исполнителя (иначе ушло бы всем как «кто-то должен») и при «не понимаю»", () => {
    expect(assignOverride("Напомни мне в пятницу оплатить интернет", { name: "assign_task", someone: true, task: "оплатить интернет" })).toEqual({
      name: "create_event",
      start: "",
      title: "оплатить интернет",
    });
    expect(assignOverride("Напомни мне в пятницу оплатить интернет", { name: "unsupported" })).toEqual({
      name: "create_event",
      start: "",
      title: "в пятницу оплатить интернет",
    });
    expect(assignOverride("Remind me to call grandma on Sunday at 12", { name: "unsupported" })).toEqual({
      name: "create_event",
      start: "",
      title: "call grandma on Sunday at 12",
    });
  });
  it("«Напомни купить молоко» — без адресата тоже себе (оригинальный набор, n05)", () => {
    expect(parseAssignPhrase("Напомни купить молоко")).toBeNull();
    expect(assignOverride("Напомни купить молоко", { name: "assign_task", someone: true, task: "купить молоко" })).toEqual({
      name: "create_event",
      start: "",
      title: "купить молоко",
    });
    expect(assignOverride("Напомни Мите купить молоко", { name: "unsupported" })).toEqual({ name: "assign_task", assignee: "Мите" });
  });
  it("не трогаем: вопрос, напоминание у события, поиск от LLM, поручение другому", () => {
    expect(assignOverride("Напомни мне, когда у меня стоматолог", { name: "unsupported" })).toBeNull();
    expect(assignOverride("Напомни мне за 2 часа до самолёта", { name: "assign_task", assignee: "мне" })).toEqual({ name: "modify_event" });
    expect(assignOverride("Напомни мне, что у меня завтра", { name: "list_events", range: "завтра" })).toBeNull();
    expect(assignOverride("Напомни мужу купить хлеб", { name: "unsupported" })).toEqual({ name: "assign_task", assignee: "мужу" });
    expect(assignOverride("Напоминание: мне нужно к врачу", { name: "unsupported" })).toBeNull();
  });
});

describe("#2 ответственный — одно событие с ответственным (класс A)", () => {
  it("assign_task от LLM → create_event, название из текста", () => {
    expect(
      assignOverride("Футбол у Вани по вторникам и четвергам в 18, возит папа", {
        name: "assign_task",
        assignee: "папа",
        when: "по вторникам и четвергам в 18",
      }),
    ).toEqual({
      name: "create_event",
      start: "по вторникам и четвергам в 18",
      title: "Футбол у Вани по вторникам и четвергам в 18",
    });
    expect(assignOverride("Ответственный Дима: техосмотр в субботу в 10", { name: "assign_task", assignee: "Дима", task: "техосмотр" })).toEqual({
      name: "create_event",
      start: "",
      title: "техосмотр в субботу в 10",
    });
    expect(assignOverride("Поставь Маше английский в пятницу в 17, отвезёт Аня", { name: "assign_task", assignee: "Аня" })).toEqual({
      name: "create_event",
      start: "",
      title: "Маше английский в пятницу в 17",
    });
  });
  it("create + assign от LLM → только create", () => {
    const create = { name: "create_event" as const, start: "в четверг в 16", title: "Стоматолог Вани" };
    expect(
      assignOverride("Стоматолог Вани в четверг в 16, отводит папа", { name: "multiple", parts: [create, { name: "assign_task", assignee: "папа" }] }),
    ).toEqual(create);
    // Другие команды вместе с ответственным — это и правда несколько команд
    expect(assignOverride("Удали танцы, отводит папа", { name: "multiple", parts: [{ name: "delete_event" }, create] })).toBeNull();
  });
  it("не трогаем: «пусть / попроси X …», «Папа отведёт Ваню …» (кто — до глагола), создание от LLM", () => {
    expect(assignOverride("Пусть папа отведёт Ваню к врачу, отводит папа", { name: "assign_task", assignee: "папа" })).toMatchObject({ name: "assign_task" });
    expect(assignOverride("Папа отведёт Ваню к врачу в пятницу в 10", { name: "assign_task", assignee: "папа" })).toMatchObject({ name: "assign_task" });
    expect(assignOverride("Стоматолог Вани в четверг в 16, отводит папа", { name: "create_event", start: "в четверг в 16" })).toBeNull();
  });
});

describe("#3 латиница и исполнитель от LLM (класс B)", () => {
  it("латиница ~ кириллица", () => {
    expect(who("Dima")).toEqual(["Дима"]);
    expect(who("Anya")).toEqual(["Аня"]);
    expect(findMentioned("Dentist for Vanya on Thursday", children)?.name).toBe("Ваня");
    expect(findMentioned("pick up Sonya at 6pm", children)?.name).toBe("Соня");
    expect(findMentioned("When is Sonya's dance class", children)?.name).toBe("Соня");
    expect(findMentioned("pick up Masha from school", children)?.name).toBe("Маша");
    expect(who("Petya")).toEqual([]);
    expect(findMentioned("buy milk and bread", children)).toBeUndefined();
  });
  it("имя из текста не нашлось, а от LLM нашлось — берём LLM", () => {
    expect(pickAssignee({ assignee: "Анютку", rest: "" }, "Аня", home)).toBe("Аня");
    expect(pickAssignee({ assignee: "Диме", rest: "" }, "Аня", home)).toBe("Диме");
    expect(pickAssignee({ assignee: "Пете", rest: "" }, "Петя", home)).toBe("Пете");
    expect(pickAssignee(null, "мужу", home)).toBe("мужу");
  });
  it("английские фразы поручений", () => {
    expect(parseAssignPhrase("Have Dima walk the dog tonight at 9")).toEqual({ assignee: "Dima", rest: "walk the dog tonight at 9" });
    expect(parseAssignPhrase("Remind my husband to pay the internet bill on Friday")).toEqual({ assignee: "husband", rest: "pay the internet bill on Friday" });
    expect(parseAssignPhrase("Can someone pick up Sonya at 6pm tomorrow?")).toEqual({ someone: true, rest: "pick up Sonya at 6pm tomorrow" });
    expect(parseAssignPhrase("Someone's birthday tomorrow")).toBeNull();
    expect(parseAssignPhrase("Have a nice day")).toBeNull();
    expect(parseAssignPhrase("Have fun tonight")).toBeNull();
  });
});

describe("#4 уменьшительные имена (класс B)", () => {
  it("совпадают", () => {
    for (const [w, n] of [
      ["Аньку", "Аня"],
      ["Анечка", "Аня"],
      ["Димке", "Дима"],
      ["Машка", "Маша"],
      ["Машеньку", "Маша"],
      ["Ванька", "Ваня"],
      ["Сонечке", "Соня"],
      ["дочку", "дочь"],
    ])
      expect([w, n, sameName(w!, n!)]).toEqual([w, n, true]);
  });
  it("не путает", () => {
    for (const [w, n] of [
      ["Машка", "мама"],
      ["Ванька", "Валя"],
      ["Нику", "Нина"],
      ["Ника", "Ни"],
      ["Анька", "Анна"],
    ])
      expect([w, n, sameName(w!, n!)]).toEqual([w, n, false]);
  });
});

describe("#5 напоминание у события важнее поручения (класс D)", () => {
  it("исполнителя в тексте нет — изменение события", () => {
    expect(assignOverride("Напомни за полчаса до танцев Сони", { name: "assign_task", assignee: "Соня" })).toEqual({ name: "modify_event" });
    expect(assignOverride("Напоминай про танцы Сони за час", { name: "assign_task", assignee: "Соня", when: "за час" })).toEqual({ name: "modify_event" });
  });
  it("исполнитель в тексте — поручение (если он есть в доме)", () => {
    expect(assignOverride("Напомни мужу за час до врача взять полис", { name: "assign_task", assignee: "мужу" })).toMatchObject({ name: "assign_task" });
    expect(assignOverride("Напомни мужу за час до врача взять полис", { name: "unsupported" })).toEqual({ name: "assign_task", assignee: "мужу" });
    expect(assignOverride("напомни за 10 минут до созвона с петей", { name: "unsupported" })).toBeNull();
  });
});

describe("#6 название поручения (класс G)", () => {
  it("куски дат по одному и без «напомнить»", () => {
    expect(taskTitle("в субботу отвезёт Соню на танцы к 11", ["в субботу к 11", "в субботу", "к 11"])).toBe("Отвезёт Соню на танцы");
    expect(taskTitle("завтра забрать машу из садика в шесть вечера", ["завтра в шесть вечера", "завтра", "в шесть вечера"])).toBe("Забрать машу из садика");
    expect(taskTitle("напомнить про родительское собрание", [])).toBe("Про родительское собрание");
    expect(taskTitle("посидеть с детьми?", [])).toBe("Посидеть с детьми");
  });
});

describe("#7 «мои дела» другими словами (класс E)", () => {
  it.each([
    "Что я должен сделать в субботу?",
    "Что поручено мне на эту неделю?",
    "Что мне поручено?",
    "Покажи мои задачи",
    "What do I have to do tomorrow?",
    "my todos",
  ])("%s", (t) => expect(isMyTasksQuestion(t)).toBe(true));
  it.each(["Что я должен взять на дачу?", "Что у меня в субботу?", "Что поручить Диме?"])("не «мои дела»: %s", (t) => expect(isMyTasksQuestion(t)).toBe(false));
});

describe("#8 ответственный: глаголы и формы (класс H)", () => {
  it("находит", () => {
    expect(responsibleClause("Футбол у Вани по вторникам в 18, возит папа")).toMatchObject({ who: "папа", strong: true });
    expect(responsibleClause("Родительское собрание у Маши в четверг в 19, идёт Аня")).toEqual({ who: "Аня", clause: ", идёт Аня", strong: true });
    expect(responsibleClause("Ответственный Дима: техосмотр в субботу в 10")).toEqual({ who: "Дима", clause: "Ответственный Дима:", strong: true });
    expect(responsibleClause("Dentist for Vanya on Thursday at 4pm, dad takes him")).toEqual({ who: "dad", clause: ", dad takes him", strong: true });
    expect(responsibleClause("Бассейн в субботу водит мама")).toMatchObject({ who: "мама", strong: true });
  });
  it("не находит / не strong", () => {
    expect(responsibleClause("Завтра идёт дождь, возьми зонт")).toBeNull();
    expect(responsibleClause("Аня идёт к врачу в пятницу")).toBeNull();
    expect(responsibleClause("Папа отведёт Ваню к врачу в пятницу в 10")).toMatchObject({ strong: false });
  });
});

describe("#9 английское родство (класс B)", () => {
  it("husband / wife / dad / mom ~ муж / жена / папа / мама", () => {
    expect(who("husband")).toEqual(["Дима"]);
    expect(who("dad")).toEqual(["Дима"]);
    expect(who("wife")).toEqual(["Аня"]);
    expect(who("mom")).toEqual(["Аня"]);
    expect(who("brother")).toEqual([]);
  });
});

describe("#10 «кто сможет …» — кто-то должен (класс F)", () => {
  it("находит", () => {
    expect(parseAssignPhrase("Кто сможет в пятницу посидеть с детьми вечером?")).toEqual({ someone: true, rest: "в пятницу посидеть с детьми вечером" });
    expect(parseAssignPhrase("Кто из нас может забрать посылку")).toEqual({ someone: true, rest: "забрать посылку" });
  });
  it("и другие формы: «напомни, пожалуйста, Диме», «Дима пусть», «пусть кто-нибудь»", () => {
    expect(parseAssignPhrase("Напомни, пожалуйста, Диме забрать костюм")).toEqual({ assignee: "Диме", rest: "забрать костюм" });
    expect(parseAssignPhrase("Дима пусть заберёт машину из сервиса")).toEqual({ assignee: "Дима", rest: "заберёт машину из сервиса" });
    expect(parseAssignPhrase("Пусть кто-нибудь купит подарок Соне")).toEqual({ someone: true, rest: "купит подарок Соне" });
    expect(parseAssignPhrase("Пусть будет так")).toBeNull();
  });
  it("не вопрос «кто ответственный»", () => {
    expect(parseAssignPhrase("Кто отвезёт Машу к стоматологу?")).toBeNull();
    expect(parseAssignPhrase("Кто это?")).toBeNull();
  });
});

describe("ответственный по составу дома (QA R1 NLU, rf07)", () => {
  it("после глагола ребёнок — ответственный до глагола, ребёнок остаётся", () => {
    expect(householdResponsible("Папа отведёт Ваню к врачу в пятницу в 10", home, children)).toEqual({ who: "Папа", found: [home[1]], remove: [] });
    expect(householdResponsible("Стоматолог Вани в четверг в 16, отводит папа", home, children)).toEqual({
      who: "папа",
      found: [home[1]],
      remove: [", отводит папа"],
    });
    expect(householdResponsible("Стоматолог в четверг, отводит Петя", home, children)).toEqual({ who: "Петя", found: [], remove: [", отводит Петя"] });
    // До глагола не участник — ответственного нет, ребёнок не теряется
    expect(householdResponsible("Завтра отведём Ваню, ведёт Ваню бабушка", home, children)).toBeNull();
    expect(householdResponsible("Стоматолог в четверг", home, children)).toBeNull();
  });
});
