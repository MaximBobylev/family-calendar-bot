import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, randomToken, sha256Hex } from "../src/crypto";

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
});
