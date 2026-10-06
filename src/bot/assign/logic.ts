// Чистая логика поручений и «для кого / ответственный» (US-91, US-92): разбор фраз «напомни мужу …», «пусть Аня …»,
// «кто-то должен …», «мои дела», «…, отводит папа»; имена участников и детей с падежами («Диме», «Машу», «Ане»);
// расписание напоминаний и эскалации. Без D1 и сети — юнит-тесты в test/assign-logic.test.ts.

import { sameWord } from "../../calendar/match";
import type { CalendarEvent } from "../../calendar/model";
import { type Day, localToUtc, utcToLocal } from "../../dates/calendar";
import { removeFragments } from "../../dates/extract";
import { isDetailChange } from "../../nlu/detail-hints";
import type { Intent } from "../../nlu/intents";

// --- Имена с падежами ----------------------------------------------------------------

const norm = (s: string) => s.toLowerCase().replaceAll("ё", "е").trim();
/** Падежные окончания имён: «Ане» ~ «Аня», «Оле» ~ «Оля», «мужу» ~ «муж». */
const ENDING = /(ой|ей|ою|ею|ом|ем|ам|ям|а|я|е|и|у|ю|ы|о|ь)$/;
/** Уменьшительные суффиксы после снятия окончания: «Аньк(у)» → «ан», «Анечк(а)» → «ан», «Димк(е)» → «дим» (QA R1 NLU, B). */
const DIMINUTIVE = /(?:еньк|оньк|ечк|очк|ушк|юшк|к)$/;

/** Латиница → кириллица для имён: «Dima» → «дима», «Anya» → «аня», «Sonya's» → «соня» (QA R1 NLU, B). */
const TRANSLIT: [RegExp, string][] = [
  [/'s$/, ""],
  [/shch/g, "щ"],
  [/sch/g, "щ"],
  [/zh/g, "ж"],
  [/kh/g, "х"],
  [/ch/g, "ч"],
  [/sh/g, "ш"],
  [/ts/g, "ц"],
  [/ya/g, "я"],
  [/yo/g, "е"],
  [/yu/g, "ю"],
  [/ye/g, "е"],
  [/(?<=[aeiou])y/g, "й"],
];
const LETTERS: Record<string, string> = {
  a: "а",
  b: "б",
  c: "к",
  d: "д",
  e: "е",
  f: "ф",
  g: "г",
  h: "х",
  i: "и",
  j: "дж",
  k: "к",
  l: "л",
  m: "м",
  n: "н",
  o: "о",
  p: "п",
  q: "к",
  r: "р",
  s: "с",
  t: "т",
  u: "у",
  v: "в",
  w: "в",
  x: "кс",
  y: "ы",
  z: "з",
};
function translit(word: string): string {
  if (!/^[a-z']+$/.test(word)) return word;
  let s = word;
  for (const [re, to] of TRANSLIT) s = s.replace(re, to);
  return s.replace(/[a-z]/g, (c) => LETTERS[c] ?? c);
}

/** Английские слова родства → русские другие имена участника: «husband» ~ «муж» (QA R1 NLU, B; fix 9). */
const KIN_EN: Record<string, string> = {
  husband: "муж",
  wife: "жена",
  dad: "папа",
  daddy: "папа",
  father: "папа",
  mom: "мама",
  mum: "мама",
  mommy: "мама",
  mother: "мама",
  grandma: "бабушка",
  granny: "бабушка",
  grandpa: "дедушка",
  son: "сын",
  daughter: "дочь",
};
/** Слово в сравнимом виде: регистр, «ё», английское родство, латиница. */
const canon = (s: string) => {
  const n = norm(s);
  return KIN_EN[n] ?? translit(n);
};

/**
 * Одно имя в разных падежах: «Диме» ~ «Дима», «мужу» ~ «муж», «Ане» ~ «Аня»; «Ваня» ≠ «Валя».
 * Уменьшительные — только у слова из фразы: «Аньку» ~ «Аня», «Машка» ~ «Маша», но «Машка» ≠ «мама».
 */
export function sameName(word: string, name: string): boolean {
  const a = canon(word);
  const b = canon(name);
  if (!a || !b) return false;
  if (a === b) return true;
  if (!b.includes(" ") && a.length >= 3 && b.length >= 3 && sameWord(a, b)) return true;
  const sa = a.replace(ENDING, "");
  const sb = b.replace(ENDING, "");
  if (sa.length >= 2 && sa === sb) return true;
  // «Аньк» → «ань» → «ан»; слово длиннее основы имени — иначе «Ника» (основа «ник») стала бы «ни»
  if (sa.length < 4 || !DIMINUTIVE.test(sa)) return false;
  const dim = sa.replace(DIMINUTIVE, "").replace(/ь$/, "");
  return dim.length >= 2 && dim === sb;
}

export interface Named {
  /** Имя и другие имена («Дима», «муж», «папа»). */
  names: string[];
}

/** Кого из списка называет слово: ровно один — он; несколько — неоднозначно; никого — пусто. */
export function matchNamed<T extends Named>(word: string, list: T[]): T[] {
  return list.filter((x) => x.names.some((n) => sameName(word, n)));
}

const words = (text: string) => text.split(/[^\p{L}\p{N}-]+/u).filter(Boolean);

/** Первый упомянутый в тексте из списка (ребёнок «Машу» в «забрать Машу из школы»). */
export function findMentioned<T extends Named>(text: string, list: T[]): T | undefined {
  for (const w of words(text)) {
    const found = matchNamed(w, list);
    if (found.length === 1) return found[0];
  }
  return undefined;
}

/** Семейные роли — другие имена участника («муж», «мама»): «мужу» → «муж» (ревью R1, блокер 3). */
const ROLE_WORDS = ["муж", "жена", "папа", "мама", "бабушка", "дедушка", "сын", "дочь", "дочка", "брат", "сестра", "husband", "wife", "dad", "mom"];

/** Слово из фразы — семейная роль? Тогда её начальная форма: «мужу» → «муж», «маме» → «мама». */
export function roleAlias(word: string): string | undefined {
  return ROLE_WORDS.find((r) => sameName(word, r));
}

// --- Фразы поручений -------------------------------------------------------------------

export type AssignPhrase = { assignee: string; rest: string } | { someone: true; rest: string };

/**
 * Не исполнитель: себе — это напоминание (US-71); предлоги и время — «напомни за день до созвона» (US-42).
 */
const NOT_ASSIGNEE =
  /^(я|мне|меня|себе|нам|нас|i|me|myself|us|на|за|в|во|о|об|обо|про|до|через|с|со|к|ко|по|от|после|перед|каждый|каждую|каждое|каждые|завтра|сегодня|послезавтра|утром|вечером|днём|днем|ночью|пожалуйста|ещё|еще|что|чтобы|когда|будет|будут|это|он|она|они|все|всё|about|at|in|on|before|after|tomorrow|today|every|a|an|the|it|you|we|they|fun|some|any|no)$/i;
const INFINITIVE = /\p{L}{2,}(?:ть|ти|чь|ться)$/iu;
/** Исполнитель от LLM — «я», «мне», «me»: напоминание себе, не поручение (QA R1 NLU, C). */
const SELF_WORD = /^(я|мне|меня|себе|i|me|myself)$/i;
const ASK_VERB = "(?:напомни|попроси|поручи|скажи|передай)(?:те)?";
const RU_ASK = new RegExp(`^(?:пожалуйста,?\\s+)?${ASK_VERB},?\\s+(?:пожалуйста,?\\s+)?(\\p{L}+)[,:]?\\s+(.+)$`, "iu");
// «Пусть Аня …» и «Дима пусть …»
const RU_LET = /^(?:пусть\s+(\p{L}+)|(\p{L}+),?\s+пусть)[,:]?\s+(.+)$/iu;
// «Кто сможет посидеть с детьми?» — тоже «кто-то должен» (QA R1 NLU, F); «Кто отвезёт …?» — решает LLM
const RU_SOMEONE =
  /^(?:(?:кто-?\s?(?:то|нибудь)|кому-?\s?(?:то|нибудь))(?:\s+из\s+нас)?\s+(?:должен|должна|должны|нужно|надо|может|сможет|пусть)|кто\s+(?:из\s+нас\s+)?(?:сможет|может|готов|готова)|пусть\s+кто-?\s?(?:то|нибудь)(?:\s+из\s+нас)?)\s+(.+)$/iu;
// «Remind my husband to …», «Have Dima walk the dog» (QA R1 NLU, B)
const EN_ASK = /^(?:please\s+)?(?:(?:remind|ask|tell)\s+(?:my\s+)?(\p{L}+)\s+to|have\s+(?:my\s+)?(\p{L}+))\s+(.+)$/iu;
const EN_SOMEONE = /^(?:(?:can|could)\s+some(?:one|body)|some(?:one|body)\s+(?:has\s+to|must|should|needs\s+to|needs|to))\s+(.+)$/iu;
/** «…, чтобы забрал Машу» → «забрал Машу». */
const LEAD = /^(?:[,:]\s*)?(?:чтобы|чтоб|что|to)\s+/iu;

/** «Напомни мужу забрать Машу в 17», «Пусть Аня завтра купит торт», «Кто-то должен отвезти Ваню …». */
export function parseAssignPhrase(text: string): AssignPhrase | null {
  const s = text.trim().replace(/[.!?]+$/, "");
  const someone = RU_SOMEONE.exec(s) ?? EN_SOMEONE.exec(s);
  if (someone) return { someone: true, rest: someone[1]!.replace(LEAD, "").trim() };
  const ask = RU_ASK.exec(s);
  const let_ = ask ? null : RU_LET.exec(s);
  const en = ask || let_ ? null : EN_ASK.exec(s);
  const who = ask?.[1] ?? let_?.[1] ?? let_?.[2] ?? en?.[1] ?? en?.[2];
  const rest = ask?.[2] ?? let_?.[3] ?? en?.[3];
  // «Напомни купить молоко»: после глагола — дело (инфинитив), а не кому
  if (!who || !rest || NOT_ASSIGNEE.test(who) || INFINITIVE.test(who)) return null;
  return { assignee: who, rest: rest.replace(LEAD, "").trim() };
}

/**
 * Кому поручить: имя из текста, но если оно не нашлось среди участников, а исполнитель от LLM нашёлся — его
 * («Tell Anya …» → LLM «Аня»; QA R1 NLU, B). Нет ни того ни другого — как сказано в тексте (спросим «кому?»).
 */
export function pickAssignee<T extends Named>(phrase: AssignPhrase | null, llmAssignee: string | undefined, members: T[]): string | undefined {
  const fromText = phrase && "assignee" in phrase ? phrase.assignee : undefined;
  if (!fromText) return llmAssignee;
  if (llmAssignee && matchNamed(fromText, members).length === 0 && matchNamed(llmAssignee, members).length === 1) return llmAssignee;
  return fromText;
}

/** «Мои дела», «что на мне завтра», «какие у меня поручения», «что я должен сделать» (US-91: список дел участника). */
const MY_TASKS = new RegExp(
  [
    "^(?:а\\s+)?(?:покажи\\s+)?(?:мои|какие\\s+у\\s+меня|что\\s+у\\s+меня\\s+по)\\s+(?:дела|поручени\\p{L}*|задачи)",
    "^(?:а\\s+)?что\\s+(?:на\\s+мне|мне\\s+(?:нужно|надо)\\s+сделать|мне\\s+поручил\\p{L}*|мне\\s+поручено|поручено\\s+мне|я\\s+(?:должен|должна|должны)\\s+сделать)",
    "^(?:show\\s+)?my\\s+(?:tasks|chores|to-?dos?)",
    "^what(?:'s|\\s+is)\\s+on\\s+me",
    "^what\\s+(?:do\\s+i\\s+(?:have|need)\\s+to\\s+do|should\\s+i\\s+do|am\\s+i\\s+supposed\\s+to\\s+do)",
  ].join("|"),
  "iu",
);

export const isMyTasksQuestion = (text: string) => MY_TASKS.test(text.trim());

/** «Что я поручил», «мои поручения», «кому что я поручила» (ревью R1 #10): поручения автора. */
const ASSIGNED_BY_ME =
  /^(?:а\s+)?(?:покажи\s+)?(?:мои\s+поручени\p{L}*|(?:что|кому\s+что|какие\s+дела)\s+я\s+поручил\p{L}*|поручено\s+мной|что\s+я\s+(?:попросил\p{L}*|раздал\p{L}*))|^(?:what\s+(?:did\s+)?i\s+assigned?|my\s+assignments|assigned\s+by\s+me)/iu;

export const isAssignedByMeQuestion = (text: string) => ASSIGNED_BY_ME.test(text.trim());

/** «Напомни мне …», «напомни себе …» — напоминание себе, не поручение (QA-13). \b не годится для кириллицы. */
// «Напомни купить молоко» — без адресата, сразу дело (инфинитив): тоже себе
const SELF_REMIND =
  /^(?:пожалуйста,?\s+)?(?:напомни|напомните)(?:те)?,?\s+(?:(?:мне|себе|нам)(?!\p{L})|(?=\p{L}+(?:ть|ти|чь|ться)(?!\p{L})))|^(?:please\s+)?remind\s+(?:me|myself|us)(?!\p{L})/iu;
/** «Напомни мне, когда у меня стоматолог» — вопрос, а не напоминание. */
const SELF_REMIND_QUESTION = /^,?\s*(?:когда|что|где|во\s+сколько|сколько|when|what|where)(?!\p{L})/iu;
/** Команда создания в начале — не часть названия: «Поставь Маше английский …» → «Маше английский». */
const CREATE_VERB = /^(?:эээ\s+)?(?:поставь|запиши|добавь|создай|запланируй|внеси|schedule|add|create|book|put)(?:те)?(?!\p{L})\s*(?:мне\s+|пожалуйста\s+)*/iu;

/** Напоминание себе → событие: название — что сделать (от LLM или из текста), даты вычистит роутер. */
function selfReminder(text: string, intent: Intent): Intent {
  const llm = intent.name === "assign_task" ? intent : undefined;
  const title =
    llm?.task ??
    text
      .trim()
      .replace(SELF_REMIND, "")
      .trim()
      .replace(LEAD, "")
      .replace(/[.!]+$/, "")
      .trim();
  return { name: "create_event", start: llm?.when ?? "", ...(title ? { title } : {}) };
}

/**
 * Поручения — по сильным словам в тексте, до поправок effectiveIntent: «Пусть Аня завтра отменит бронь» — поручение, а не
 * удаление события. LLM может назвать поручение и сама (assign_task) — тогда её интент, кроме случаев ниже (QA R1 NLU):
 * напоминание себе — событие; «…, отводит папа» — создание с ответственным; напоминание у события — изменение.
 */
export function assignOverride(text: string, intent: Intent): Intent | null {
  if (isAssignedByMeQuestion(text)) return { name: "list_assignments", byMe: true };
  if (isMyTasksQuestion(text)) return { name: "list_assignments" };
  const s = text.trim();
  const phrase = parseAssignPhrase(text);
  const detail = isDetailChange(text);
  const llmAssign = intent.name === "assign_task" ? intent : undefined;

  // 1. Себе (QA-13, класс C): «напомни мне …» или исполнитель «я / мне / me» — событие-напоминание, не поручение всем.
  // «Напомни мне за час до …» — напоминание у события (US-42). Ответ LLM «найти» / «показать» не трогаем.
  const self = SELF_REMIND.exec(s);
  const selfByLlm = !!llmAssign?.assignee && SELF_WORD.test(llmAssign.assignee.trim());
  if ((self && !SELF_REMIND_QUESTION.test(s.slice(self[0].length)) && (llmAssign || intent.name === "unsupported")) || selfByLlm)
    return detail ? { name: "modify_event" } : selfReminder(text, intent);

  // 2. Ответственный (US-92, класс A): «Стоматолог Вани в четверг в 16, отводит папа» — одно событие с ответственным,
  // а не поручение и не две команды. «Попроси / пусть X …» — поручение, его не трогаем.
  const resp = responsibleClause(text);
  if (resp?.strong && !phrase && (llmAssign || intent.name === "multiple" || intent.name === "unsupported")) {
    const parts = intent.name === "multiple" ? (intent.parts ?? []) : [];
    if (parts.some((p) => p.name !== "create_event" && p.name !== "assign_task")) return null;
    const created = parts.find((p) => p.name === "create_event");
    if (created) return created;
    const title = s.replace(resp.clause, " ").replace(CREATE_VERB, "").replace(/\s+/g, " ").trim();
    return { name: "create_event", start: llmAssign?.when ?? "", ...(title ? { title } : {}) };
  }

  if (llmAssign) {
    // 3. Исполнитель «за день», «в 17» — не участник: напоминание у события или себе
    if (llmAssign.assignee && NOT_ASSIGNEE.test(llmAssign.assignee.trim().split(/\s+/)[0] ?? ""))
      return detail ? { name: "modify_event" } : selfReminder(text, intent);
    // 4. Напоминание у события («напомни за полчаса до танцев Сони», класс D): исполнителя в тексте нет — изменение
    if (detail && !phrase) return { name: "modify_event" };
    return intent;
  }
  // «Напомни мужу за час до врача взять полис» — поручение, если «муж» есть в доме (проверит assignmentApplies);
  // «напомни за день до созвона» (US-42) — напоминание у события
  if (detail && !(phrase && "assignee" in phrase)) return null;
  if (!phrase || intent.name === "multiple") return null;
  return "someone" in phrase ? { name: "assign_task", someone: true } : { name: "assign_task", assignee: phrase.assignee };
}

/** «Напомнить про собрание» → «про собрание»: глагол просьбы — не часть дела (класс G). */
const TASK_LEAD = /^(?:напомнить|напомни|remind\s+(?:him|her|them)\s+to)\s+/iu;

/** Название поручения: «завтра купит торт» → «Купит торт»; куски дат вырезаются по одному; пустое — null. */
export function taskTitle(raw: string, remove: (string | undefined)[]): string | null {
  const s = removeFragments(raw, remove)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[,.:;\-—]+|[,.:;\-—?]+$/g, "")
    .trim()
    .replace(TASK_LEAD, "")
    .slice(0, 120);
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : null;
}

// --- «Для кого» и «ответственный» у события (US-92) -----------------------------------------

const L = "\\p{L}";
/** «…, отводит папа», «— забирает Дима», «Ответственный Дима: …». */
const RESPONSIBLE = new RegExp(
  `(?:^|[\\s,;]+)(?:—\\s*|-\\s*)?(?:отвод(?:ит)?|отвед[её]т|отвоз(?:ит)?|отвез[её]т|вед[её]т|вез[её]т|возит|водит|забира(?:ет)?|забер[её]т|` +
    `ответственн(?:ый|ая|ое)?:?|responsible:?)\\s+(${L}+):?(?=$|[\\s,.;!])`,
  "iu",
);
/** Слабые глаголы («идёт», «едет») — только отдельным куском в конце: «…, идёт Аня». Не «завтра идёт дождь». */
const RESPONSIBLE_TAIL = new RegExp(`\\s*[,;—-]\\s*(?:ид[её]т|пойд[её]т|сходит|едет|поедет)\\s+(${L}+)\\s*[.!]?$`, "iu");
/** «…, dad takes him»: исполнитель до глагола (класс H). */
const RESPONSIBLE_EN = new RegExp(
  `\\s*[,;—-]?\\s*(?:(?:my|the)\\s+)?(${L}+)\\s+(?:takes|drives|picks\\s+up|brings|will\\s+take)\\s+(?:him|her|them)(?!${L})(?:\\s+there)?\\s*[.!]?`,
  "iu",
);

/**
 * «…, отводит папа» → кто («папа») и сам кусок — убрать из названия и дат. strong — кусок отделён запятой или тире,
 * стоит в конце или это «Ответственный X:»: тогда фраза — событие с ответственным, даже если LLM сказала «поручение».
 * «Папа отведёт Ваню к врачу» — не strong (кто — до глагола).
 */
export function responsibleClause(text: string): { who: string; clause: string; strong: boolean } | null {
  const en = RESPONSIBLE_EN.exec(text);
  if (en) return { who: en[1]!, clause: en[0]!.trim(), strong: true };
  const m = RESPONSIBLE.exec(text) ?? RESPONSIBLE_TAIL.exec(text);
  if (!m) return null;
  const clause = m[0]!.trim();
  const atEnd = text.slice(m.index + m[0]!.length).replace(/[\s.!]+/g, "") === "";
  const strong = /^[,;—-]/.test(clause) || atEnd || /^(?:ответственн|responsible)/iu.test(clause);
  return { who: m[1]!, clause, strong };
}

/**
 * Ответственный с учётом состава дома. После глагола ребёнок («Папа отведёт Ваню к врачу») — значит, ответственный —
 * слово до глагола, а ребёнок остаётся в названии и «для кого» (QA R1 NLU, rf07). remove — что вырезать из названия и дат.
 */
export function householdResponsible<M extends Named>(text: string, members: M[], dependents: Named[]): { who: string; found: M[]; remove: string[] } | null {
  const c = responsibleClause(text);
  if (!c) return null;
  if (matchNamed(c.who, dependents).length === 0) return { who: c.who, found: matchNamed(c.who, members), remove: [c.clause] };
  const before = /(\p{L}+)[\s,]*$/u.exec(text.slice(0, Math.max(0, text.indexOf(c.clause))))?.[1];
  const found = before ? matchNamed(before, members) : [];
  return before && found.length ? { who: before, found, remove: [] } : null;
}

/** Семейные поля нового события — в черновике и карточке создания (US-92). */
export interface EventFamily {
  responsibleUserId?: string;
  responsibleName?: string;
  forDependentId?: string;
  forName?: string;
  /** Назвали ответственного, но в доме такого нет — предупредить в карточке. */
  unknownWho?: string;
}

/** Подпись события в списке: название с ребёнком в скобках и «— отводит Дима». */
export type FamilyLabel = (e: CalendarEvent) => { title: string; note?: string } | undefined;

const TRAILING_PREP = /\s+(?:у|для|с|со|к|of|for)$/i;

/**
 * Название в списках (US-92): ребёнок — в скобках, без повтора в названии. «Стоматолог Вани» → «Стоматолог (Ваня)».
 * В самом календаре название не меняем — его видят и без бота.
 */
export function familyTitle(title: string, dependent: Named & { name: string }): string {
  const kept = title.split(/\s+/).filter((w) => !dependent.names.some((n) => sameName(w.replace(/[^\p{L}-]/gu, ""), n)));
  const rest = kept.join(" ").replace(TRAILING_PREP, "").trim();
  return rest && kept.length < title.split(/\s+/).length ? `${rest} (${dependent.name})` : `${title} (${dependent.name})`;
}

// --- Расписание напоминаний (US-91) ------------------------------------------------------------

export type AssignJobWhat = "day" | "ask" | "hour" | "morning" | "escalate" | "expire";

const HOUR = 60 * 60 * 1000;
/** Поручение на день без времени: напомнить в 9:00, эскалация в 12:00 ([решение 2026-10-06]). */
const DAY_ONLY_REMIND_MIN = 9 * 60;
const DAY_ONLY_ESCALATE_MIN = 12 * 60;
/** Эскалация автору, если исполнитель не ответил за 2 часа до срока (US-91, допущение). */
export const ESCALATE_BEFORE_MS = 2 * HOUR;
/** Мягкое «Ответьте, пожалуйста: возьмёте?» исполнителю — за 3 часа до срока, если ответа ещё нет (ревью R1 #6). */
export const ASK_BEFORE_MS = 3 * HOUR;
/** Эскалация — не раньше чем через 30 минут после первого напоминания исполнителю (ревью R1 #6). */
export const ESCALATE_AFTER_REMINDER_MS = 30 * 60 * 1000;

const REMINDERS: AssignJobWhat[] = ["day", "ask", "hour", "morning"];

/**
 * Когда напоминать (US-91, [решение 2026-10-06, изменено по ревью R1]):
 * - срок со временем: за 1 день (если срок — завтра и позже), «ответьте, пожалуйста» за 3 часа (только если ещё не ответили)
 *   и за 1 час; без времени — в 9:00 дня срока;
 * - эскалация автору — за 2 часа до срока (без времени — в 12:00), но не раньше первого напоминания исполнителю + 30 минут:
 *   эскалация = max(срок − 2 ч, первое напоминание + 30 мин); не успевает до срока или напоминаний впереди нет — без эскалации.
 *   «Кто-то должен» (named = false) — напоминать некому, эскалация в свой срок;
 * - истекает в конце дня срока (не раньше чем через 2 часа после срока). Только моменты в будущем.
 */
export function planAssignmentJobs(a: {
  dueAt: number;
  hasTime: boolean;
  now: number;
  tz: string;
  named?: boolean;
}): { what: AssignJobWhat; fireAt: number }[] {
  const named = a.named ?? true;
  const dueDay: Day = utcToLocal(a.dueAt, a.tz).day;
  const today = utcToLocal(a.now, a.tz).day;
  const at = (day: Day, minutes: number) => localToUtc({ day, minutes }, a.tz);
  const plan: { what: AssignJobWhat; fireAt: number }[] = [];
  let escalate: number;
  let deadline: number;
  if (a.hasTime) {
    if (dueDay >= today + 1) plan.push({ what: "day", fireAt: a.dueAt - 24 * HOUR });
    if (named) plan.push({ what: "ask", fireAt: a.dueAt - ASK_BEFORE_MS });
    plan.push({ what: "hour", fireAt: a.dueAt - HOUR });
    plan.push({ what: "expire", fireAt: Math.max(at(dueDay + 1, 0), a.dueAt + 2 * HOUR) });
    escalate = a.dueAt - ESCALATE_BEFORE_MS;
    deadline = a.dueAt;
  } else {
    plan.push({ what: "morning", fireAt: at(dueDay, DAY_ONLY_REMIND_MIN) });
    plan.push({ what: "expire", fireAt: at(dueDay + 1, 0) });
    escalate = at(dueDay, DAY_ONLY_ESCALATE_MIN);
    deadline = at(dueDay + 1, 0);
  }
  const future = plan.filter((p) => p.fireAt > a.now);
  if (named) {
    const first = future.filter((p) => REMINDERS.includes(p.what)).sort((x, y) => x.fireAt - y.fireAt)[0];
    if (first) {
      const fireAt = Math.max(escalate, first.fireAt + ESCALATE_AFTER_REMINDER_MS);
      if (fireAt < deadline) future.push({ what: "escalate", fireAt });
    }
  } else if (escalate > a.now) future.push({ what: "escalate", fireAt: escalate });
  return future.sort((x, y) => x.fireAt - y.fireAt);
}
