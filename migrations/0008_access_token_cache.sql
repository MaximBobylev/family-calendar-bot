-- tech-debt #13: кеш access token Google на аккаунт провайдера — без refresh на каждое действие.
--   access_token_enc  — access token, AES-GCM формата v1 (src/crypto.ts), AAD «access:<id аккаунта>»;
--   access_expires_at — когда Google перестанет его принимать (мс UTC); берём из кеша до ~5 мин до срока.
-- Живёт вместе с аккаунтом: удаляется с ним (/disconnect, замена аккаунта), при переподключении того же
-- аккаунта сбрасывается; просроченный не нужен никому и перезаписывается следующим обновлением.
ALTER TABLE provider_accounts ADD COLUMN access_token_enc TEXT;
ALTER TABLE provider_accounts ADD COLUMN access_expires_at INTEGER;
