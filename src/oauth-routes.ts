// HTTP-маршруты привязки Google (US-02):
//   GET /oauth/google/start?state=…     → редирект на экран согласия Google
//   GET /oauth/google/callback?code|error&state → обмен кода, сохранение, сообщение в Telegram

import { rescheduleDigest } from "./jobs/digest";
import type { AppContext } from "./bot/context";
import { connectKeyboard } from "./bot/keyboards";
import { t } from "./bot/messages";
import { encryptSecret, sha256Hex } from "./crypto";
import { consumeOAuthState, saveGoogleAccount, telegramChatOf, userLocale } from "./db/accounts";
import { listCalendars } from "./google/calendar-api";
import { consentUrl, exchangeCode } from "./google/oauth";
import { SECURITY_HEADERS } from "./pages";

function page(text: string, status = 200): Response {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Calendar Assist Bot</title></head><body style="font:18px system-ui;margin:3em auto;max-width:28em;padding:0 1em">
<p>${text.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!)}</p></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS } });
}

export async function handleOAuthRoute(ctx: AppContext, request: Request, url: URL): Promise<Response> {
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
  const state = url.searchParams.get("state") ?? "";

  if (url.pathname === "/oauth/google/start") {
    const row = await ctx.db
      .prepare("SELECT 1 FROM oauth_states WHERE state = ? AND used_at IS NULL AND expires_at > ?")
      .bind(state, ctx.clock.now())
      .first();
    if (!row) return page(t("oauthBadLinkPage", "ru"), 400);
    return Response.redirect(consentUrl(ctx.config, state), 302);
  }

  if (url.pathname === "/oauth/google/callback") {
    const consumed = await consumeOAuthState(ctx.db, state, ctx.clock.now());
    if (!consumed.ok) return page(t("oauthBadLinkPage", "ru"), 400);
    const { userId } = consumed;
    const locale = await userLocale(ctx.db, userId);
    const chatId = await telegramChatOf(ctx.db, userId);

    // Отказ на экране согласия (US-02): сообщить и предложить повторить
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    if (error || !code) {
      if (chatId) await ctx.telegram.sendMessage(chatId, t("accessDenied", locale), await connectKeyboard(ctx, userId, locale));
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
