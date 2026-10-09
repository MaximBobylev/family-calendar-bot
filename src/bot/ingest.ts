// Событие из чужого контента (эпик 7b, R1): пересланное (US-65), фото/скриншот (US-66), файл .ics (US-67).
// Чужое никогда не исполняется как команда — только карточка «Создать событие?» / «Добавить в календарь?».
// Даты — нашим парсером по тексту (ADR-0005); LLM / vision — только название и место. Журнал (US-13) — без
// чужого текста: только извлечённые поля. Чистая логика — ingest-logic.ts, src/ics/*.

import type { CalendarProvider } from "../calendar/model";
import { formatMoment, parseLocal, utcToLocal } from "../dates/calendar";
import { looksAllDay } from "../dates/extract";
import { calendarNamesOf } from "../db/accounts";
import { AWAIT_TTL_MS, attachMessage, createPendingAction, mergeDialogState, type PendingAction } from "../db/conversations";
import { recordFeature } from "../db/features";
import { DEFAULT_DURATION_MIN } from "../db/settings";
import { recordUsage } from "../db/usage";
import type { User } from "../db/users";
import { icsToItem, type IcsItem } from "../ics/convert";
import { parseIcs } from "../ics/parse";
import { llmCostMicroUsd } from "../limits";
import { log } from "../log";
import { type CreateEventIntent, parseIntentChain } from "../nlu/intents";
import type { TgMessage } from "../telegram/types";
import { understandImageChain } from "../vision/understand";
import type { AppContext } from "./context";
import { startCreate } from "./create-event";
import { type CreateDraft, llmDateCheck, resolveCalendar } from "./create-logic";
import { cancelCards } from "./dialog";
import { escapeHtml, whenOf } from "./format";
import { type ForwardOrigin, forwardOrigin } from "./forwarded";
import { withinLimit } from "./input/limit";
import { foreignDateSpans, guessPlace, heuristicTitle, sourceDescription } from "./ingest-logic";
import { callbackData } from "./keyboards";
import { t } from "./messages";
import { attachUndoMessage, recordUndo } from "./undo";
import { withCalendar } from "./with-calendar";

export const ICS_CARD = "ics";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_ICS_BYTES = 256 * 1024;
/** Событий из одного .ics за раз `[решение 2026-10-06]`: больше — вежливый отказ. */
export const MAX_ICS_EVENTS = 10;
/** Пересланное старше этого — «завтра» считаем от сегодня, а не от даты сообщения (US-65 AC, допущение 7 дней). */
const MAX_FORWARD_AGE_MS = 7 * 86_400_000;

// --- Общее: черновик из чужого текста → карточка создания -------------------------

interface ForeignSource {
  /** Текст, где ищем дату, место, название (подпись пользователя — первой). */
  text: string;
  /** Первая строка описания: «Из пересланного сообщения от Маши». */
  sourceLine: string;
  /** Что цитировать в описании (по умолчанию — text). */
  quote?: string;
  /** Название и место от модели (vision); нет — спросим LLM по тексту (useLlm) или возьмём эвристику. */
  intent?: CreateEventIntent;
  useLlm: boolean;
  /** От какого момента считать относительные даты (дата исходного сообщения). */
  refNow?: number;
}

async function proposeFromForeign(ctx: AppContext, user: User, chatId: number, conversationId: string, src: ForeignSource): Promise<void> {
  let intent = src.intent;
  if (!intent && src.useLlm) {
    const res = await titleFromLlm(ctx, user, chatId, src.text);
    if (res === null) return; // лимит исчерпан — уже ответили
    intent = res;
  }
  const tz = user.home_tz;
  const localNow = formatMoment(utcToLocal(src.refNow ?? ctx.clock.now(), tz));
  const dates = foreignDateSpans(src.text, localNow, tz);
  const location = intent?.location ?? guessPlace(src.text);
  const title = intent?.title ?? heuristicTitle(dates.sentence, dates.fragments, location);
  // Шаг 5 ревью дат: дата — из структуры модели (она видит весь текст и отличает дату события от прочих), наш парсер
  // проверяет; расходятся — оба кнопками. Пересланное — модель первой; фото — наш разбор дословного текста первым:
  // мультимодальная модель «исправляет» время (синтетика голоса 2026-10-05). Нет структуры — как раньше, `start`
  const llm = intent ? { start: intent.start, ...(intent.when ? { when: intent.when } : {}) } : {};
  const check = llmDateCheck(src.text, dates.point, llm, parseLocal(localNow), tz, src.useLlm);
  const source = src.useLlm ? "forward" : "image";
  log("date_check", { source, llm: check.llm, agreement: check.agreement });
  const start = check.pick;
  const draft: CreateDraft = {
    ...start,
    ...(dates.duration ? { durationText: dates.duration } : {}),
    ...(title ? { title } : {}),
    ...(location ? { location } : {}),
    ...(intent?.allDay || looksAllDay(title ?? "") ? { allDay: true } : {}),
    description: sourceDescription(src.sourceLine, src.quote ?? src.text, (url) => t("ingestLink", user.locale, { url })),
    dateCheck: { source, agreement: check.agreement, llm: check.llm },
  };
  if (!start.startText && !start.altWhen) {
    // Даты нет — спросить «Когда?»; ответ дополнит этот же черновик (dialog.ts, US-12)
    await mergeDialogState(
      ctx.db,
      conversationId,
      user.id,
      { awaiting: { kind: "create_time", draft, expiresAt: ctx.clock.now() + AWAIT_TTL_MS } },
      ctx.clock.now(),
    );
    await ctx.telegram.sendMessage(chatId, t("ingestAskWhen", user.locale, { title: title ?? t("defaultTitle", user.locale) }));
    return;
  }
  await withCalendar(ctx, user, chatId, (provider) =>
    startCreate(ctx, provider, { user, chatId, conversationId, draft, ...(src.refNow ? { refNow: src.refNow } : {}) }),
  );
}

/**
 * Название и место по чужому тексту от LLM (как для команд — тот же промпт и tools). undefined — LLM не помогла
 * (не create_event, сбой): берём эвристику. null — лимит исчерпан, пользователю ответили.
 */
async function titleFromLlm(ctx: AppContext, user: User, chatId: number, text: string): Promise<CreateEventIntent | undefined | null> {
  if (!(await withinLimit(ctx, user, "llm", chatId))) return null;
  const now = ctx.clock.now();
  try {
    const res = await parseIntentChain(ctx.config.llm, text.slice(0, 500), { calendars: await calendarNamesOf(ctx.db, user.id) });
    const { parsed, via } = res;
    const costs = {
      ...ctx.config.costs,
      ...(via.inPerM !== undefined ? { llmInPerM: via.inPerM } : {}),
      ...(via.outPerM !== undefined ? { llmOutPerM: via.outPerM } : {}),
    };
    const intent = parsed.intent.name === "create_event" ? parsed.intent : undefined;
    // Журнал — без чужого текста: только что извлекли (US-65)
    await recordUsage(ctx.db, {
      userId: user.id,
      kind: "llm",
      provider: via.name ?? via.baseUrl,
      model: via.model,
      tokensIn: parsed.tokensIn,
      tokensOut: parsed.tokensOut,
      costMicroUsd: llmCostMicroUsd(costs, parsed.tokensIn, parsed.tokensOut),
      result: {
        source: "forward",
        intent: parsed.intent.name,
        ...(intent?.title ? { title: intent.title } : {}),
        ...(intent?.start ? { start: intent.start } : {}),
      },
      outcome: "ok",
      now,
    });
    return intent;
  } catch (e) {
    console.error("forward llm failed", e instanceof Error ? e.message : e);
    await recordUsage(ctx.db, {
      userId: user.id,
      kind: "llm",
      provider: "chain",
      model: "none",
      result: { source: "forward", error: true },
      outcome: "error",
      now,
    });
    return undefined;
  }
}

// --- US-65: пересланное ---------------------------------------------------------

/** «Создать событие из этого» на карточке пересланного. */
export async function eventFromForwarded(
  ctx: AppContext,
  user: User,
  chatId: number,
  conversationId: string,
  p: ForwardOrigin & { text: string },
): Promise<void> {
  const dateMs = p.date ? p.date * 1000 : undefined;
  // «Завтра» в пересланном — от даты исходного сообщения; скрыта или старше недели — от сегодня
  const refNow = dateMs && dateMs <= ctx.clock.now() && ctx.clock.now() - dateMs <= MAX_FORWARD_AGE_MS ? dateMs : undefined;
  await proposeFromForeign(ctx, user, chatId, conversationId, {
    text: p.text,
    sourceLine: p.from ? t("ingestFromForwardBy", user.locale, { name: p.from }) : t("ingestFromForward", user.locale),
    useLlm: true,
    ...(refNow ? { refNow } : {}),
  });
  await recordFeature(ctx.db, user.id, "forward_event", ctx.clock.now());
}

// --- Вложения: фото (US-66) и .ics (US-67) ---------------------------------------

const isIcs = (d: NonNullable<TgMessage["document"]>) => /\.ics$/i.test(d.file_name ?? "") || /^text\/calendar/i.test(d.mime_type ?? "");

type ImagePick = { fileId: string; mime: string } | { error: "imageTooBig" | "imageWrongFormat" } | undefined;

function pickImage(m: TgMessage): ImagePick {
  if (m.photo?.length) {
    // Самый крупный размер, который пролезает в лимит (Telegram сжимает фото в JPEG)
    const fit = [...m.photo].reverse().find((p) => (p.file_size ?? 0) <= MAX_IMAGE_BYTES);
    return fit ? { fileId: fit.file_id, mime: "image/jpeg" } : { error: "imageTooBig" };
  }
  const d = m.document;
  if (!d || !/^image\//i.test(d.mime_type ?? "")) return undefined;
  if (!IMAGE_TYPES.has(d.mime_type!.toLowerCase())) return { error: "imageWrongFormat" };
  if ((d.file_size ?? 0) > MAX_IMAGE_BYTES) return { error: "imageTooBig" };
  return { fileId: d.file_id, mime: d.mime_type!.toLowerCase() };
}

/** Фото, картинка-файл или .ics. false — это не вложение, которое мы умеем (дальше — «пока не умею»). */
export async function handleAttachment(ctx: AppContext, user: User, message: TgMessage, conversationId: string): Promise<boolean> {
  // Только личные чаты `[решение 2026-10-06]`: в группе картинки и файлы — не команды боту
  if (message.chat.type !== "private") return false;
  const chatId = message.chat.id;
  if (message.document && isIcs(message.document)) {
    await cancelCards(ctx, user, conversationId);
    await importIcs(ctx, user, chatId, conversationId, message.document);
    return true;
  }
  const image = pickImage(message);
  if (!image) return false;
  await cancelCards(ctx, user, conversationId);
  if ("error" in image) {
    await ctx.telegram.sendMessage(chatId, t(image.error, user.locale));
    return true;
  }
  await eventFromImage(ctx, user, chatId, conversationId, image, message);
  return true;
}

async function eventFromImage(
  ctx: AppContext,
  user: User,
  chatId: number,
  conversationId: string,
  image: { fileId: string; mime: string },
  message: TgMessage,
): Promise<void> {
  if (ctx.config.vision.length === 0) {
    await ctx.telegram.sendMessage(chatId, t("imageUnavailable", user.locale));
    return;
  }
  if (!(await withinLimit(ctx, user, "llm", chatId))) return;
  const now = ctx.clock.now();
  const caption = message.caption?.trim() || undefined;
  let res: Awaited<ReturnType<typeof understandImageChain>>;
  try {
    // Картинка не хранится: скачали, отдали модели, забыли (US-66)
    const bytes = await ctx.telegram.downloadFile(image.fileId);
    res = await understandImageChain(ctx.config.vision, bytes, image.mime, caption);
  } catch (e) {
    console.error("image understanding failed", e instanceof Error ? e.message : e);
    await recordUsage(ctx.db, {
      userId: user.id,
      kind: "llm",
      provider: "vision-chain",
      model: ctx.config.vision[0]?.model ?? "none",
      result: { source: "image", error: String(e).slice(0, 300) },
      outcome: "error",
      now,
    });
    await ctx.telegram.sendMessage(chatId, t("imageFailed", user.locale));
    return;
  }
  const { result, via } = res;
  const intent = result.noEvent ? undefined : result.intent;
  await recordUsage(ctx.db, {
    userId: user.id,
    kind: "llm",
    provider: via.name ?? via.baseUrl,
    model: via.model,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    costMicroUsd: llmCostMicroUsd({ ...ctx.config.costs, llmInPerM: via.inPerM ?? 0, llmOutPerM: via.outPerM ?? 0 }, result.tokensIn, result.tokensOut),
    // Видимый текст картинки в журнал не пишем — только извлечённые поля (US-65, US-66)
    result: { source: "image", noEvent: result.noEvent, ...(intent ? { title: intent.title, start: intent.start, location: intent.location } : {}) },
    outcome: "ok",
    now,
  });
  if (result.noEvent || !result.text) {
    await ctx.telegram.sendMessage(chatId, t("imageNoEvent", user.locale));
    return;
  }
  const origin = message.forward_origin ? forwardOrigin(message.forward_origin) : undefined;
  await proposeFromForeign(ctx, user, chatId, conversationId, {
    // Подпись — слова пользователя: её даты важнее (US-66)
    text: caption ? `${caption}\n${result.text}` : result.text,
    quote: result.text,
    sourceLine: origin?.from ? t("ingestFromForwardBy", user.locale, { name: origin.from }) : t("ingestFromImage", user.locale),
    ...(intent ? { intent } : {}),
    useLlm: false,
  });
  await recordFeature(ctx.db, user.id, "image_event", ctx.clock.now());
}

// --- US-67: .ics ------------------------------------------------------------------

export interface IcsCardPayload {
  chatId: number;
  calendarId: string;
  items: IcsItem[];
}

async function importIcs(ctx: AppContext, user: User, chatId: number, conversationId: string, doc: NonNullable<TgMessage["document"]>): Promise<void> {
  const l = user.locale;
  if ((doc.file_size ?? 0) > MAX_ICS_BYTES) {
    await ctx.telegram.sendMessage(chatId, t("icsTooBig", l));
    return;
  }
  let raw: ArrayBuffer;
  try {
    raw = await ctx.telegram.downloadFile(doc.file_id);
  } catch (e) {
    console.error("ics download failed", e instanceof Error ? e.message : e);
    await ctx.telegram.sendMessage(chatId, t("icsDownloadFailed", l));
    return;
  }
  if (raw.byteLength > MAX_ICS_BYTES) {
    await ctx.telegram.sendMessage(chatId, t("icsTooBig", l));
    return;
  }
  const parsed = parseIcs(new TextDecoder().decode(raw));
  if ("error" in parsed) {
    await ctx.telegram.sendMessage(chatId, t(parsed.error === "not_calendar" ? "icsMalformed" : "icsNoEvents", l));
    return;
  }
  if (parsed.events.length > MAX_ICS_EVENTS) {
    await ctx.telegram.sendMessage(chatId, t("icsTooMany", l, { n: String(parsed.events.length), max: String(MAX_ICS_EVENTS) }));
    return;
  }
  await withCalendar(ctx, user, chatId, async (provider) => {
    const calendars = await provider.calendars();
    const cal = resolveCalendar(calendars, undefined);
    if ("error" in cal) {
      await ctx.telegram.sendMessage(chatId, t("noWritableCalendar", l));
      return;
    }
    const items = parsed.events.map((e) => icsToItem(e, user.home_tz, user.settings.durationMin ?? DEFAULT_DURATION_MIN));
    const unknownTz = parsed.events.find((e) => e.unknownTz)?.unknownTz;
    const id = await createPendingAction(ctx.db, {
      conversationId,
      userId: user.id,
      kind: ICS_CARD,
      payload: { chatId, calendarId: cal.id, items } satisfies IcsCardPayload,
      now: ctx.clock.now(),
    });
    const today = utcToLocal(ctx.clock.now(), user.home_tz).day;
    const many = items.length > 1;
    const showCalendar = calendars.filter((c) => c.writable).length > 1;
    const text = [
      many ? t("icsConfirmMany", l, { n: String(items.length) }) : t("icsConfirmOne", l),
      ...(showCalendar ? [`🗓 ${escapeHtml(cal.title)}`] : []),
      "",
      items.map((it) => icsItemBody(it, today, l)).join("\n\n"),
      ...(unknownTz ? ["", t("icsUnknownTz", l, { tz: escapeHtml(unknownTz) })] : []),
    ].join("\n");
    const sent = await ctx.telegram.sendMessage(
      chatId,
      text,
      {
        inline_keyboard: [
          [
            { text: many ? t("icsAddAllButton", l, { n: String(items.length) }) : t("icsAddButton", l), callback_data: callbackData(id, "a") },
            { text: t("cancelButton", l), callback_data: callbackData(id, "x") },
          ],
        ],
      },
      { html: true },
    );
    await attachMessage(ctx.db, id, sent.message_id);
  });
}

function icsItemBody(it: IcsItem, today: number, locale: string): string {
  const lines = [`<b>${escapeHtml(it.title ?? t("defaultTitle", locale))}</b>`, `🕒 ${whenOf(it, today, locale)}`];
  if (it.rrule) lines.push(t("icsRepeats", locale));
  if (it.location) lines.push(`📍 ${escapeHtml(it.location)}`);
  return lines.join("\n");
}

/** Напоминания по умолчанию из настроек (US-04) — как у обычного создания. */
function remindersFor(user: User, allDay: boolean): { reminders?: number[] } {
  const r = allDay ? (user.settings.allDayReminders ?? []) : user.settings.reminders;
  return r ? { reminders: r } : {};
}

/** «Добавить» на карточке .ics: создать все события по очереди (идемпотентно — повтор после сбоя не дублирует). */
export async function confirmIcs(
  ctx: AppContext,
  provider: CalendarProvider,
  user: User,
  action: PendingAction<IcsCardPayload>,
  choice: string,
): Promise<boolean> {
  const { chatId, calendarId, items } = action.payload;
  const l = user.locale;
  if (choice !== "a") {
    if (action.messageId) await ctx.telegram.editMessageText(chatId, action.messageId, t("cancelled", l));
    return false;
  }
  const today = utcToLocal(ctx.clock.now(), user.home_tz).day;
  const created = [];
  for (const [i, it] of items.entries()) {
    created.push(
      await provider.createEvent({
        idempotencyKey: `${action.id}${i}`,
        calendarId,
        title: it.title ?? t("defaultTitle", l),
        tz: it.tz,
        allDay: it.allDay,
        startDay: it.startDay,
        endDay: it.endDay,
        ...(it.start ? { start: it.start } : {}),
        ...(it.end ? { end: it.end } : {}),
        ...(it.location ? { location: it.location } : {}),
        ...(it.description ? { description: it.description } : {}),
        ...(it.rrule ? { recurrence: [it.rrule] } : {}),
        ...remindersFor(user, it.allDay),
      }),
    );
  }
  const body = items.map((it) => icsItemBody(it, today, l)).join("\n\n");
  if (items.length === 1 && created[0]) {
    // Одно событие — как обычное создание: ссылка и «Отменить» (US-61)
    const undo = await recordUndo(ctx, {
      conversationId: action.conversationId,
      user,
      chatId,
      record: { kind: "create", ref: created[0].ref, ...(created[0].etag ? { etag: created[0].etag } : {}) },
      summary: body,
    });
    const row = [...(created[0].link ? [{ text: t("openInCalendar", l), url: created[0].link }] : []), undo.button];
    if (action.messageId) {
      await ctx.telegram.editMessageText(chatId, action.messageId, `${t("icsAdded", l)}\n\n${body}`, { inline_keyboard: [row] }, { html: true });
      await attachUndoMessage(ctx.db, undo.undoId, Number(action.messageId));
    }
    await mergeDialogState(ctx.db, action.conversationId, user.id, { lastEvent: { ref: created[0].ref, at: ctx.clock.now() } }, ctx.clock.now());
  } else if (action.messageId) {
    await ctx.telegram.editMessageText(chatId, action.messageId, `${t("icsAddedMany", l, { n: String(items.length) })}\n\n${body}`, undefined, {
      html: true,
    });
  }
  await recordFeature(ctx.db, user.id, ["create", "ics_import"], ctx.clock.now());
  return true;
}
