import { describe, expect, test } from "bun:test";
import { hashPassword, verifyPassword } from "./auth.service.js";

describe("password hashing", () => {
  test("hashes with a salted argon2id digest", async () => {
    const first = await hashPassword("olive123");
    const second = await hashPassword("olive123");
    expect(first.startsWith("$argon2id$")).toBe(true);
    expect(first).not.toBe(second);
  });

  test("verifies the correct password", async () => {
    const hash = await hashPassword("olive123");
    expect(await verifyPassword("olive123", hash)).toBe(true);
  });

  test("rejects an incorrect password", async () => {
    const hash = await hashPassword("olive123");
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });

  test("falls back to plain comparison for legacy plaintext rows", async () => {
    expect(await verifyPassword("olive123", "olive123")).toBe(false);
  });

  test("does not throw on a malformed digest", async () => {
    expect(await verifyPassword("olive123", "$argon2id$broken$payload")).toBe(false);
  });
});