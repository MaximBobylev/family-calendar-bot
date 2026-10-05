-- PKCE и привязка к браузеру (tracks/telegram-login.md, этап 1; угрозы A4/A5).
-- Заполняются при переходе со страницы подключения на экран согласия (POST /oauth/google/start):
--   code_verifier_enc — PKCE code_verifier, AES-GCM (тот же ключ, что у refresh token);
--   browser_binding   — SHA-256 (hex) cookie oauth_bind браузера, начавшего вход.
-- Живут вместе с state (ретеншн oauth_states — сутки после истечения, scheduler.ts:cleanup).
ALTER TABLE oauth_states ADD COLUMN code_verifier_enc TEXT;
ALTER TABLE oauth_states ADD COLUMN browser_binding TEXT;
