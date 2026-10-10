// AES-GCM для секретов в D1; AAD — контекст записи (aadFor), чтобы шифротекст нельзя было подставить в чужую строку БД.
// Ротация (tech-debt #8): шифрует только TOKEN_ENCRYPTION_KEY, расшифровка пробует и TOKEN_ENCRYPTION_KEYS_OLD.

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

const V1 = "v1:";

export type KeyRing = readonly [current: string, ...old: string[]];

export async function encryptSecret(plain: string, keys: KeyRing, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const params = { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) };
  const ct = new Uint8Array(await crypto.subtle.encrypt(params, await importKey(keys[0]), new TextEncoder().encode(plain)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return V1 + b64.encode(out);
}

/** Без префикса v1 — legacy-записи без AAD: только расшифровка, перешифруются при переподключении. */
export async function decryptSecret(sealed: string, keys: KeyRing, aad: string): Promise<string> {
  const v1 = sealed.startsWith(V1);
  const bytes = b64.decode(v1 ? sealed.slice(V1.length) : sealed);
  const params = { name: "AES-GCM", iv: bytes.slice(0, 12), ...(v1 ? { additionalData: new TextEncoder().encode(aad) } : {}) };
  for (const key of keys) {
    try {
      return new TextDecoder().decode(await crypto.subtle.decrypt(params, await importKey(key), bytes.slice(12)));
    } catch {
      // Не этот ключ — следующий (ротация)
    }
  }
  throw new Error("secret cannot be decrypted with any configured key");
}

export function keyRing(current: string, old: string | undefined): KeyRing {
  const rest = (old ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k && k !== current);
  return [current, ...rest];
}

export const aadFor = {
  account: (accountId: string) => `account:${accountId}`,
  access: (accountId: string) => `access:${accountId}`,
  oauthState: (state: string) => `oauth_state:${state}`,
};

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomToken(bytes = 24): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** RFC 7636 §4.1 требует 43–128 символов: 32 байта дают ровно 43. */
export function pkceVerifier(): string {
  return randomToken(32);
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}
