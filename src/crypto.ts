// Шифрование секретов в D1 (refresh token Google): AES-GCM, ключ — секрет TOKEN_ENCRYPTION_KEY (base64, 32 байта).
// Формат: base64(iv[12] || ciphertext).

const b64 = {
  encode: (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)),
  decode: (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
};
const base64Url = (bytes: Uint8Array) => b64.encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function importKey(keyB64: string): Promise<CryptoKey> {
  const raw = b64.decode(keyB64);
  if (raw.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes (base64)");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(plain: string, keyB64: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await importKey(keyB64), new TextEncoder().encode(plain)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64.encode(out);
}

export async function decryptSecret(sealed: string, keyB64: string): Promise<string> {
  const bytes = b64.decode(sealed);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, await importKey(keyB64), bytes.slice(12));
  return new TextDecoder().decode(plain);
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Случайная строка для state и прочих одноразовых токенов (URL-safe). */
export function randomToken(bytes = 24): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Сравнение секретов за постоянное время (длина не утекает через ранний выход). */
export function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** PKCE code_verifier (RFC 7636 §4.1): 32 случайных байта → 43 символа [A-Za-z0-9-_]. */
export function pkceVerifier(): string {
  return randomToken(32);
}

/** PKCE code_challenge, метод S256: BASE64URL(SHA256(ascii(verifier))). */
export async function pkceChallenge(verifier: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}
