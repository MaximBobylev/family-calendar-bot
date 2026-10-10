import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, keyRing, type KeyRing, pkceChallenge, pkceVerifier, randomToken, sha256Hex, timingSafeEqual } from "../src/crypto";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const OTHER = btoa(String.fromCharCode(...new Uint8Array(32).fill(8)));
const RING: KeyRing = [KEY];
const AAD = "account:a1";

// Формат до v1 (без префикса и AAD): такие записи ещё лежат в проде и должны расшифровываться.
async function legacySeal(plain: string, keyB64: string): Promise<string> {
  const raw = Uint8Array.from(atob(keyB64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain)));
  return btoa(String.fromCharCode(...iv, ...ct));
}

describe("crypto", () => {
  it("round-trips a secret in v1 format and uses a fresh IV each time", async () => {
    const a = await encryptSecret("rt-ivan@gmail.com", RING, AAD);
    const b = await encryptSecret("rt-ivan@gmail.com", RING, AAD);
    expect(a).toMatch(/^v1:/);
    expect(a).not.toBe(b);
    expect(a).not.toContain("ivan");
    expect(await decryptSecret(a, RING, AAD)).toBe("rt-ivan@gmail.com");
  });

  it("binds v1 ciphertext to its record (AAD)", async () => {
    const sealed = await encryptSecret("secret", RING, "account:a1");
    await expect(decryptSecret(sealed, RING, "account:a2")).rejects.toThrow();
  });

  it("decrypts legacy ciphertext (no prefix, no AAD) whatever the AAD", async () => {
    const legacy = await legacySeal("rt-legacy", KEY);
    expect(await decryptSecret(legacy, RING, AAD)).toBe("rt-legacy");
    expect(await decryptSecret(legacy, [OTHER, KEY], "")).toBe("rt-legacy");
  });

  it("rotation: the current key encrypts, old keys still decrypt", async () => {
    const before = await encryptSecret("secret", [KEY], AAD);
    const legacy = await legacySeal("old", KEY);
    const rotated: KeyRing = [OTHER, KEY];
    expect(await decryptSecret(before, rotated, AAD)).toBe("secret");
    expect(await decryptSecret(legacy, rotated, AAD)).toBe("old");
    const after = await encryptSecret("secret", rotated, AAD);
    await expect(decryptSecret(after, [KEY], AAD)).rejects.toThrow();
    expect(await decryptSecret(after, [OTHER], AAD)).toBe("secret");
  });

  it("fails to decrypt with another key", async () => {
    const sealed = await encryptSecret("secret", RING, AAD);
    await expect(decryptSecret(sealed, [OTHER], AAD)).rejects.toThrow();
  });

  it("rejects keys of wrong length", async () => {
    await expect(encryptSecret("x", [btoa("short")], AAD)).rejects.toThrow(/32 bytes/);
  });

  it("builds the key ring from secrets", () => {
    expect(keyRing(KEY, undefined)).toEqual([KEY]);
    expect(keyRing(KEY, "")).toEqual([KEY]);
    expect(keyRing(OTHER, ` ${KEY} , ,${OTHER}`)).toEqual([OTHER, KEY]);
  });

  it("hashes and generates url-safe tokens", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it("computes the PKCE S256 challenge (RFC 7636, Appendix B)", async () => {
    expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("generates PKCE verifiers of allowed length and charset", () => {
    const v = pkceVerifier();
    expect(v).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
    expect(pkceVerifier()).not.toBe(v);
  });

  it("compares secrets", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
  });
});
