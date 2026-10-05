// Вход в админку: пока HTTP Basic (ADMIN_USER / ADMIN_PASSWORD), один оператор. Дальше — Cloudflare Access + operators
// (docs/admin-console.md, «Доступ»). Изменения — только POST с проверкой Origin.

import { timingSafeEqual } from "../crypto";

/** Имя оператора (для аудита) или null, если вход не прошёл. Пустой пароль в конфиге — админка закрыта. */
export function adminOperator(request: Request, user: string, password: string): string | null {
  if (!user || !password) return null;
  const header = request.headers.get("authorization") ?? "";
  const m = /^Basic\s+(.+)$/i.exec(header);
  if (!m) return null;
  let decoded: string;
  try {
    decoded = new TextDecoder().decode(Uint8Array.from(atob(m[1]!), (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
  const sep = decoded.indexOf(":");
  if (sep < 0) return null;
  const ok = timingSafeEqual(decoded.slice(0, sep), user) && timingSafeEqual(decoded.slice(sep + 1), password);
  return ok ? user : null;
}

export const unauthorized = () =>
  new Response("Unauthorized", { status: 401, headers: { "www-authenticate": 'Basic realm="admin", charset="UTF-8"', "cache-control": "no-store" } });

/**
 * Браузер шлёт Basic-учётку и на запросы с чужих сайтов — поэтому POST принимается только со своей страницы:
 * Sec-Fetch-Site (если браузер его шлёт) — same-origin, иначе Origin (если есть) совпадает с нашим.
 * Без обоих заголовков (curl, раннер тестов) — пропускаем: это не браузер, CSRF не про них.
 */
export function sameOrigin(request: Request, url: URL): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site) return site === "same-origin" || site === "none";
  const origin = request.headers.get("origin");
  return !origin || origin === url.origin;
}
