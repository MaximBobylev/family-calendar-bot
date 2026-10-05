import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, pkceChallenge, pkceVerifier, randomToken, sha256Hex, timingSafeEqual } from "../src/crypto";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

describe("crypto", () => {
  it("round-trips a secret and uses a fresh IV each time", async () => {
    const a = await encryptSecret("rt-ivan@gmail.com", KEY);
    const b = await encryptSecret("rt-ivan@gmail.com", KEY);
    expect(a).not.toBe(b);
    expect(a).not.toContain("ivan");
    expect(await decryptSecret(a, KEY)).toBe("rt-ivan@gmail.com");
  });

  it("fails to decrypt with another key", async () => {
    const sealed = await encryptSecret("secret", KEY);
    const other = btoa(String.fromCharCode(...new Uint8Array(32).fill(8)));
    await expect(decryptSecret(sealed, other)).rejects.toThrow();
  });

  it("rejects keys of wrong length", async () => {
    await expect(encryptSecret("x", btoa("short"))).rejects.toThrow(/32 bytes/);
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
