// Чистая логика поручений и «для кого / ответственный» (US-91, US-92): разбор фраз «напомни мужу …», «пусть Аня …»,
// «кто-то должен …», «мои дела», «…, отводит папа»; имена участников и детей с падежами («Диме», «Машу», «Ане»);
// расписание напоминаний и эскалации. Без D1 и сети — юнит-тесты в test/assign-logic.test.ts.

import { sameWord } from "../../calendar/match";
import type { CalendarEvent } from "../../calendar/model";
import { type Day, localToUtc, utcToLocal } from "../../dates/calendar";
import { isDetailChange } from "../../nlu/detail-hints";
import type { Intent } from "../../nlu/intents";

// --- Имена с падежами ----------------------------------------------------------------

const norm = (s: string) => s.toLowerCase().replaceAll("ё", "е").trim();
/** Падежные окончания имён: «Ане» ~ «Аня», «Оле» ~ «Оля», «мужу» ~ «муж». */
const ENDING = /(ой|ей|ою|ею|ом|ем|ам|ям|а|я|е|и|у|ю|ы|о|ь)$/;

/** Одно имя в разных падежах: «Диме» ~ «Дима», «мужу» ~ «муж», «Ане» ~ «Аня»; «Ваня» ≠ «Валя». */
export function sameName(word: string, name: string): boolean {
  const a = norm(word);
  const b = norm(name);
  if (!a || !b) return false;
  if (a === b) return true;
  if (!b.includes(" ") && a.length >= 3 && b.length >= 3 && sameWord(a, b)) return true;
  const sa = a.replace(ENDING, "");
  const sb = b.replace(ENDING, "");
  return sa.length >= 2 && sa === sb;
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

// --- Фразы поручений -------------------------------------------------------------------

export type AssignPhrase = { assignee: string; rest: string } | { someone: true; rest: string };

/**
 * Не исполнитель: себе — это напоминание (US-71); предлоги и время — «напомни за день до созвона» (US-42).
 */
const NOT_ASSIGNEE =
  /^(мне|меня|себе|нам|нас|me|myself|us|на|за|в|во|о|об|обо|про|до|через|с|со|к|ко|по|от|после|перед|каждый|каждую|каждое|каждые|завтра|сегодня|послезавтра|утром|вечером|днём|днем|ночью|пожалуйста|ещё|еще|что|чтобы|когда|будет|будут|это|он|она|они|все|всё|about|at|in|on|before|after|tomorrow|today|every)$/i;
const ASK_VERB = "(?:напомни|попроси|поручи|скажи|передай)(?:те)?";
const RU_ASK = new RegExp(`^(?:пожалуйста,?\\s+)?${ASK_VERB},?\\s+(\\p{L}+)[,:]?\\s+(.+)$`, "iu");
const RU_LET = /^пусть\s+(\p{L}+)[,:]?\s+(.+)$/iu;
const RU_SOMEONE = /^(?:кто-?\s?(?:то|нибудь)|кому-?\s?(?:то|нибудь))(?:\s+из\s+нас)?\s+(?:должен|должна|должны|нужно|надо|может|сможет|пусть)\s+(.+)$/iu;
const EN_ASK = /^(?:please\s+)?(?:remind|ask|tell)\s+(\p{L}+)\s+to\s+(.+)$/iu;
const EN_SOMEONE = /^some(?:one|body)\s+(?:has\s+to|must|should|needs\s+to|needs|to)\s+(.+)$/iu;
/** «…, чтобы забрал Машу» → «забрал Машу». */
const LEAD = /^(?:[,:]\s*)?(?:чтобы|чтоб|что|to)\s+/iu;

/** «Напомни мужу забрать Машу в 17», «Пусть Аня завтра купит торт», «Кто-то должен отвезти Ваню …». */
export function parseAssignPhrase(text: string): AssignPhrase | null {
  const s = text.trim().replace(/[.!]+$/, "");
  const someone = RU_SOMEONE.exec(s) ?? EN_SOMEONE.exec(s);
  if (someone) return { someone: true, rest: someone[1]!.replace(LEAD, "").trim() };
  const named = RU_ASK.exec(s) ?? RU_LET.exec(s) ?? EN_ASK.exec(s);
  if (!named || NOT_ASSIGNEE.test(named[1]!)) return null;
  return { assignee: named[1]!, rest: named[2]!.replace(LEAD, "").trim() };
}

/** «Мои дела», «что на мне завтра», «какие у меня поручения» (US-91: список дел участника). */
const MY_TASKS =
  /^(?:а\s+)?(?:покажи\s+)?(?:мои|какие\s+у\s+меня|что\s+у\s+меня\s+по)\s+(?:дела|поручени\p{L}*|задачи)|^(?:а\s+)?что\s+(?:на\s+мне|мне\s+(?:нужно|надо)\s+сделать|мне\s+поручили)|^(?:show\s+)?my\s+(?:tasks|chores)|^what(?:'s|\s+is)\s+on\s+me/iu;

export const isMyTasksQuestion = (text: string) => MY_TASKS.test(text.trim());

/**
 * Поручения — по сильным словам в тексте, до поправок effectiveIntent: «Пусть Аня завтра отменит бронь» — поручение, а не
 * удаление события. LLM может назвать поручение и сама (assign_task) — тогда её интент.
 */
export function assignOverride(text: string, intent: Intent): Intent | null {
  if (isMyTasksQuestion(text)) return { name: "list_assignments" };
  if (intent.name === "assign_task") return intent;
  // Напоминание у события («напомни за день до созвона», US-42) — не поручение
  if (isDetailChange(text)) return null;
  const phrase = parseAssignPhrase(text);
  if (!phrase || intent.name === "multiple") return null;
  return "someone" in phrase ? { name: "assign_task", someone: true } : { name: "assign_task", assignee: phrase.assignee };
}

/** Название поручения: «завтра купит торт» → «Купит торт»; пустое — null. */
export function taskTitle(raw: string, remove: string[]): string | null {
  let s = raw;
  for (const f of remove) if (f) s = s.replace(new RegExp(f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), " ");
  s = s
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[,.:;\-—]+|[,.:;\-—]+$/g, "")
    .trim()
    .slice(0, 120);
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : null;
}

// --- «Для кого» и «ответственный» у события (US-92) -----------------------------------------

const RESPONSIBLE = new RegExp(
  "(?:^|[\\s,;]+)(?:—\\s*|-\\s*)?(?:отвод(?:ит)?|отвед[её]т|отвоз(?:ит)?|отвез[её]т|вед[её]т|вез[её]т|забира(?:ет)?|забер[её]т|" +
    "ответственн(?:ый|ая|ое)?:?|responsible:?|takes)\\s+(\\p{L}+)(?=$|[\\s,.;!])",
  "iu",
);

/** «…, отводит папа» → кто («папа») и сам кусок — убрать из названия и дат. */
export function responsibleClause(text: string): { who: string; clause: string } | null {
  const m = RESPONSIBLE.exec(text);
  return m ? { who: m[1]!, clause: m[0]!.trim() } : null;
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

export type AssignJobWhat = "day" | "hour" | "morning" | "escalate" | "expire";

const HOUR = 60 * 60 * 1000;
/** Поручение на день без времени: напомнить в 9:00, эскалация в 12:00 ([решение 2026-10-06]). */
const DAY_ONLY_REMIND_MIN = 9 * 60;
const DAY_ONLY_ESCALATE_MIN = 12 * 60;
/** Эскалация автору, если исполнитель не ответил за 2 часа до срока (US-91, допущение). */
export const ESCALATE_BEFORE_MS = 2 * HOUR;

/**
 * Когда напоминать: за 1 день (если срок — завтра и позже) и за 1 час; эскалация — за 2 часа, если не ответили; истекает —
 * в конце дня срока (не раньше чем через 2 часа после срока). Только моменты в будущем.
 */
export function planAssignmentJobs(a: { dueAt: number; hasTime: boolean; now: number; tz: string }): { what: AssignJobWhat; fireAt: number }[] {
  const dueDay: Day = utcToLocal(a.dueAt, a.tz).day;
  const today = utcToLocal(a.now, a.tz).day;
  const at = (day: Day, minutes: number) => localToUtc({ day, minutes }, a.tz);
  const plan: { what: AssignJobWhat; fireAt: number }[] = [];
  if (a.hasTime) {
    if (dueDay >= today + 1) plan.push({ what: "day", fireAt: a.dueAt - 24 * HOUR });
    plan.push({ what: "escalate", fireAt: a.dueAt - ESCALATE_BEFORE_MS });
    plan.push({ what: "hour", fireAt: a.dueAt - HOUR });
    plan.push({ what: "expire", fireAt: Math.max(at(dueDay + 1, 0), a.dueAt + 2 * HOUR) });
  } else {
    plan.push({ what: "morning", fireAt: at(dueDay, DAY_ONLY_REMIND_MIN) });
    plan.push({ what: "escalate", fireAt: at(dueDay, DAY_ONLY_ESCALATE_MIN) });
    plan.push({ what: "expire", fireAt: at(dueDay + 1, 0) });
  }
  return plan.filter((p) => p.fireAt > a.now).sort((x, y) => x.fireAt - y.fireAt);
}
