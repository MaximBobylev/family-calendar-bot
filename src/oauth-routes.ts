// HTTP-маршруты привязки Google (US-02):
//   GET  /oauth/google/start?state=…  → страница «подключаете к Telegram-аккаунту …» с кнопкой (tech-debt #1)
//   POST /oauth/google/start          → (state + CSRF из cookie) редирект на экран согласия Google
//   GET  /oauth/google/callback?code|error&state → обмен кода, сохранение, сообщение в Telegram
//
// Промежуточная страница — минимальная защита от привязки чужого Google по пересланной ссылке: открывший видит,
// к чьему Telegram подключается календарь. POST только со своей страницы: cookie SameSite=Strict + то же значение
// в форме, поэтому чужой сайт не может отправить жертву сразу на экран согласия. Полное решение — в tech-debt #1.

import { rescheduleDigest } from "./jobs/digest";
import type { AppContext } from "./bot/context";
import { connectKeyboard } from "./bot/keyboards";
import { t } from "./bot/messages";
import { encryptSecret, randomToken, sha256Hex } from "./crypto";
import { consumeOAuthState, linkedElsewhere, peekOAuthState, saveGoogleAccount, telegramChatOf, userLocale } from "./db/accounts";
import { listCalendars } from "./google/calendar-api";
import { consentUrl, exchangeCode, revokeStoredToken } from "./google/oauth";
import { SECURITY_HEADERS } from "./pages";

const escapeHtml = (s: string) => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);

function htmlPage(bodyHtml: string, status = 200, headers: Record<string, string> = {}): Response {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Calendar Assist Bot</title></head><body style="font:18px system-ui;margin:3em auto;max-width:28em;padding:0 1em">
${bodyHtml}</body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS, ...headers } });
}

const page = (text: string, status = 200) => htmlPage(`<p>${escapeHtml(text)}</p>`, status);

const CSRF_COOKIE = "oauth_csrf";

function cookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

/** Страница перед экраном согласия: к чьему Telegram подключается календарь (tech-debt #1). */
async function startPage(ctx: AppContext, state: string): Promise<Response> {
  const link = await peekOAuthState(ctx.db, state, ctx.clock.now());
  if (!link) return page(t("oauthBadLinkPage", "ru"), 400);
  const l = link.locale;
  const csrf = randomToken();
  // Тексты страницы — наши, без спецсимволов HTML; экранируем только имя
  const who = link.tgName ? t("oauthConfirmPage", l, { name: `<b>${escapeHtml(link.tgName)}</b>` }) : t("oauthConfirmNoName", l);
  const secure = ctx.config.publicBaseUrl.startsWith("https://") ? "; Secure" : "";
  return htmlPage(
    `<p>${who}</p>
<p>${escapeHtml(t("oauthConfirmWarning", l))}</p>
<form method="post" action="/oauth/google/start">
<input type="hidden" name="state" value="${escapeHtml(state)}"><input type="hidden" name="csrf" value="${csrf}">
<button type="submit" style="font:inherit;padding:.6em 1.4em">${escapeHtml(t("oauthConfirmButton", l))}</button>
</form>`,
    200,
    { "set-cookie": `${CSRF_COOKIE}=${csrf}; Path=/oauth/google/start; Max-Age=600; HttpOnly; SameSite=Strict${secure}` },
  );
}

export async function handleOAuthRoute(ctx: AppContext, request: Request, url: URL): Promise<Response> {
  if (url.pathname === "/oauth/google/start" && request.method === "GET") return startPage(ctx, url.searchParams.get("state") ?? "");
  if (url.pathname === "/oauth/google/start" && request.method === "POST") {
    const form = await request.formData().catch(() => null);
    const state = String(form?.get("state") ?? "");
    const csrf = String(form?.get("csrf") ?? "");
    // Форма не с нашей страницы (нет cookie или не совпала) — не пускаем
    if (!csrf || cookie(request, CSRF_COOKIE) !== csrf) return page(t("oauthBadLinkPage", "ru"), 403);
    if (!(await peekOAuthState(ctx.db, state, ctx.clock.now()))) return page(t("oauthBadLinkPage", "ru"), 400);
    return Response.redirect(consentUrl(ctx.config, state), 303);
  }
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
  const state = url.searchParams.get("state") ?? "";

  if (url.pathname === "/oauth/google/callback") {
    const consumed = await consumeOAuthState(ctx.db, state, ctx.clock.now());
    if (!consumed.ok) return page(t("oauthBadLinkPage", "ru"), 400);
    const { userId, tgName } = consumed;
    const locale = await userLocale(ctx.db, userId);
    const chatId = await telegramChatOf(ctx.db, userId);

    // Отказ на экране согласия (US-02): сообщить и предложить повторить
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    if (error || !code) {
      if (chatId) await ctx.telegram.sendMessage(chatId, t("accessDenied", locale), await connectKeyboard(ctx, userId, locale, tgName ?? undefined));
      return page(t("accessDenied", locale));
    }

    try {
      const tokens = await exchangeCode(ctx.config, code);
      if (!tokens.refresh_token) throw new Error("no refresh_token in response");
      const calendars = await listCalendars(ctx.config.googleApiBase, tokens.access_token);
      const primary = calendars.find((c) => c.primary);
      if (!primary) throw new Error("no primary calendar");

      const linked = await saveGoogleAccount(ctx.db, {
        userId,
        email: primary.id,
        emailHash: await sha256Hex(primary.id.toLowerCase()),
        credentialsEnc: await encryptSecret(tokens.refresh_token, ctx.config.tokenEncryptionKey),
        scopes: tokens.scope,
        calendars,
        now: ctx.clock.now(),
      });
      // Заменили другой аккаунт — отозвать его токен (US-03), если он не подключён у кого-то ещё; не вышло — не страшно
      if (linked.replaced && !(await linkedElsewhere(ctx.db, linked.replaced.emailHash, userId))) {
        await revokeStoredToken(ctx.config, linked.replaced.credentialsEnc);
      }
      // Утренний дайджест — по поясу из Google (US-70)
      await rescheduleDigest(ctx.db, userId, ctx.clock.now());
      if (chatId) await ctx.telegram.sendMessage(chatId, t("connected", locale, { email: linked.email, tz: linked.timeZone }));
      return page(t("oauthDonePage", locale));
    } catch (e) {
      console.error("oauth callback failed", e);
      return page(t("oauthFailedPage", locale), 502);
    }
  }

  return new Response("Not found", { status: 404 });
}
