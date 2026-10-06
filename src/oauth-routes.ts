// HTTP-маршруты привязки Google (US-02):
//   GET  /oauth/google/start?state=…  → страница «подключаете к Telegram-аккаунту …» с кнопкой (tech-debt #1)
//   POST /oauth/google/start          → (state + CSRF из cookie) PKCE + cookie привязки → редирект на экран согласия Google
//   GET  /oauth/google/callback?code|error&state → проверка cookie привязки, обмен кода (+ code_verifier),
//                                                  сохранение, сообщение в Telegram
//
// Промежуточная страница — минимальная защита от привязки чужого Google по пересланной ссылке: открывший видит,
// к чьему Telegram подключается календарь. POST только со своей страницы: cookie SameSite=Strict + то же значение
// в форме, поэтому чужой сайт не может отправить жертву сразу на экран согласия. Полное решение — в tech-debt #1.
//
// Привязка к браузеру и PKCE (tracks/telegram-login.md, этап 1): при переходе к Google браузер получает cookie
// oauth_bind (в state — её SHA-256), callback принимается только с ней — чужой callback?code&state, подсунутый
// жертве (login CSRF, A4), не привяжет к её Telegram чужой Google. Код обменивается только с code_verifier,
// который знает лишь сервер (A5). SameSite=Lax, а не Strict: возврат с Google — межсайтовая GET-навигация.

import { rescheduleDigest } from "./jobs/digest";
import type { AppContext } from "./bot/context";
import { connectKeyboard } from "./bot/keyboards";
import { t } from "./bot/messages";
import { aadFor, decryptSecret, encryptSecret, pkceChallenge, pkceVerifier, randomToken, sha256Hex, timingSafeEqual } from "./crypto";
import { bindOAuthState, consumeOAuthState, linkedElsewhere, peekOAuthState, saveGoogleAccount, telegramChatOf, userLocale } from "./db/accounts";
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

const page = (text: string, status = 200, headers: Record<string, string> = {}) => htmlPage(`<p>${escapeHtml(text)}</p>`, status, headers);

const CSRF_COOKIE = "oauth_csrf";
const BIND_COOKIE = "oauth_bind";
const BIND_PATH = "/oauth/google";

const secureAttr = (ctx: AppContext) => (ctx.config.publicBaseUrl.startsWith("https://") ? "; Secure" : "");

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
  const secure = secureAttr(ctx);
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
    // PKCE verifier (зашифрован) и хеш cookie браузера — к state; ссылка не действует — не пускаем
    const verifier = pkceVerifier();
    const bind = randomToken(32);
    const bound = await bindOAuthState(ctx.db, state, ctx.clock.now(), {
      codeVerifierEnc: await encryptSecret(verifier, ctx.config.tokenKeys, aadFor.oauthState(state)),
      browserBinding: await sha256Hex(bind),
    });
    if (!bound) return page(t("oauthBadLinkPage", "ru"), 400);
    return new Response(null, {
      status: 303,
      headers: {
        location: consentUrl(ctx.config, state, await pkceChallenge(verifier)),
        "cache-control": "no-store",
        "set-cookie": `${BIND_COOKIE}=${bind}; Path=${BIND_PATH}; Max-Age=600; HttpOnly; SameSite=Lax${secureAttr(ctx)}`,
      },
    });
  }
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
  const state = url.searchParams.get("state") ?? "";

  if (url.pathname === "/oauth/google/callback") {
    const consumed = await consumeOAuthState(ctx.db, state, ctx.clock.now());
    if (!consumed.ok) return page(t("oauthBadLinkPage", "ru"), 400);
    const { userId, tgName } = consumed;
    const locale = await userLocale(ctx.db, userId);

    // Привязка к браузеру (A4) — до всего остального, включая отказ на экране согласия: чужой браузер не узнаёт
    // ничего и не вызывает сообщений в бот. State при этом уже погашен — сознательно: он одноразовый, а повтор
    // с подобранной cookie невозможен; законному пользователю (например, без cookie) — начать заново из бота.
    // Нет browser_binding — state не прошёл через POST /start (или выдан до миграции 0005): тоже отказ.
    const bind = cookie(request, BIND_COOKIE);
    if (!bind || !consumed.browserBinding || !consumed.codeVerifierEnc || !timingSafeEqual(await sha256Hex(bind), consumed.browserBinding)) {
      console.warn("oauth callback: browser binding mismatch", { hasCookie: !!bind, hasBinding: !!consumed.browserBinding });
      return page(t("oauthBindFailedPage", locale), 403);
    }
    // Тот же браузер: cookie больше не нужна — стираем при любом исходе
    const clearBind = { "set-cookie": `${BIND_COOKIE}=; Path=${BIND_PATH}; Max-Age=0; HttpOnly; SameSite=Lax${secureAttr(ctx)}` };
    const chatId = await telegramChatOf(ctx.db, userId);

    // Отказ на экране согласия (US-02): сообщить и предложить повторить
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    if (error || !code) {
      if (chatId) await ctx.telegram.sendMessage(chatId, t("accessDenied", locale), await connectKeyboard(ctx, userId, locale, tgName ?? undefined));
      return page(t("accessDenied", locale), 200, clearBind);
    }

    try {
      const verifier = await decryptSecret(consumed.codeVerifierEnc, ctx.config.tokenKeys, aadFor.oauthState(state));
      const tokens = await exchangeCode(ctx.config, code, verifier);
      const refreshToken = tokens.refresh_token;
      if (!refreshToken) throw new Error("no refresh_token in response");
      const calendars = await listCalendars(ctx.config.googleApiBase, tokens.access_token);
      const primary = calendars.find((c) => c.primary);
      if (!primary) throw new Error("no primary calendar");

      const linked = await saveGoogleAccount(ctx.db, {
        userId,
        email: primary.id,
        emailHash: await sha256Hex(primary.id.toLowerCase()),
        sealCredentials: (accountId) => encryptSecret(refreshToken, ctx.config.tokenKeys, aadFor.account(accountId)),
        scopes: tokens.scope,
        calendars,
        now: ctx.clock.now(),
      });
      // Заменили другой аккаунт — отозвать его токен (US-03), если он не подключён у кого-то ещё; не вышло — не страшно
      if (linked.replaced && !(await linkedElsewhere(ctx.db, linked.replaced.emailHash, userId))) {
        await revokeStoredToken(ctx.config, linked.replaced);
      }
      // Утренний дайджест — по поясу из Google (US-70)
      await rescheduleDigest(ctx.db, userId, ctx.clock.now());
      if (chatId) await ctx.telegram.sendMessage(chatId, t("connected", locale, { email: linked.email, tz: linked.timeZone }));
      return page(t("oauthDonePage", locale), 200, clearBind);
    } catch (e) {
      console.error("oauth callback failed", e);
      return page(t("oauthFailedPage", locale), 502, clearBind);
    }
  }

  return new Response("Not found", { status: 404 });
}
