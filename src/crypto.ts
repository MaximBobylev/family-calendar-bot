// Шифрование секретов в D1 (refresh token Google): AES-GCM, ключ — секрет TOKEN_ENCRYPTION_KEY (base64, 32 байта).
// Формат: base64(iv[12] || ciphertext).

const b64 = {
  encode: (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)),
  decode: (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
};

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
  return b64.encode(crypto.getRandomValues(new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
