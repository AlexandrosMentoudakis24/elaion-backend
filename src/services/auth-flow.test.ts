import { describe, expect, test } from "bun:test";
import { makeAuthService, type AuthService } from "./auth.service.js";
import { makeInMemoryTokenStore } from "../repositories/token-store.js";
import type { UserRepository } from "../repositories/user.repository.js";
import type { UserRecord } from "../models/index.js";
import { UnauthorizedError, NotFoundError } from "../errors/app-errors.js";
import { hashPassword } from "./auth.service.js";

const admin: UserRecord = {
  id: 1,
  username: "admin",
  password: await hashPassword("olive123"),
  name: "Alexandros Mentoudakis",
  role: "Owner",
};

const stubUsers = (records: UserRecord[]): UserRepository =>
  ({
    findByUsername: async (username: string) =>
      records.find((record) => record.username === username) ?? null,
  }) as unknown as UserRepository;

const service: AuthService = makeAuthService(stubUsers([admin]), {
  secret: "test-secret-value-that-is-long-enough",
  ttlSeconds: 3600,
  absoluteSessionSeconds: 60 * 60 * 24 * 30,
  refreshGraceSeconds: 300,
  issuer: "elaion-api",
  audience: "elaion-mobile",
}, makeInMemoryTokenStore());

describe("login", () => {
  test("returns a token and a password-free profile", async () => {
    const result = await service.login("admin", "olive123");

    expect(typeof result.token).toBe("string");
    expect(result.user).toEqual({
      username: "admin",
      name: "Alexandros Mentoudakis",
      role: "Owner",
    });
    expect("password" in result.user).toBe(false);
  });

  test("rejects a wrong password", async () => {
    await expect(service.login("admin", "wrong")).rejects.toBeInstanceOf(UnauthorizedError);
  });

  test("rejects an unknown user with the same error", async () => {
    await expect(service.login("ghost", "olive123")).rejects.toBeInstanceOf(UnauthorizedError);
  });
});

describe("verifyToken", () => {
  test("resolves the subject from a freshly issued token", async () => {
    const { token } = await service.login("admin", "olive123");
    const payload = await service.verifyToken(token);

    expect(payload?.sub).toBe("admin");
    expect(payload?.role).toBe("Owner");
  });

  test("returns null for garbage and tampered tokens", async () => {
    expect(await service.verifyToken("not-a-jwt")).toBeNull();

    const { token } = await service.login("admin", "olive123");
    expect(await service.verifyToken(`${token}x`)).toBeNull();
  });

  test("rejects a token signed with a different secret", async () => {
    const other = makeAuthService(stubUsers([admin]), {
      secret: "a-completely-different-secret-value-that-is-long",
      ttlSeconds: 3600,
      absoluteSessionSeconds: 60 * 60 * 24 * 30,
      refreshGraceSeconds: 300,
      issuer: "elaion-api",
      audience: "elaion-mobile",
    }, makeInMemoryTokenStore());

    const { token } = await service.login("admin", "olive123");
    expect(await other.verifyToken(token)).toBeNull();
  });
});

describe("refresh", () => {
  test("issues a new session for a valid token", async () => {
    const { token } = await service.login("admin", "olive123");
    const refreshed = await service.refresh(token);

    expect(refreshed.user.username).toBe("admin");
    expect(await service.verifyToken(refreshed.token)).not.toBeNull();
  });

  test("rejects an invalid token", async () => {
    await expect(service.refresh("garbage")).rejects.toBeInstanceOf(UnauthorizedError);
  });

  test("fails when the user no longer exists", async () => {
    const orphaned = makeAuthService(stubUsers([]), {
      secret: "test-secret-value-that-is-long-enough",
      ttlSeconds: 3600,
      absoluteSessionSeconds: 60 * 60 * 24 * 30,
      refreshGraceSeconds: 300,
      issuer: "elaion-api",
      audience: "elaion-mobile",
    }, makeInMemoryTokenStore());

    const { token } = await service.login("admin", "olive123");
    await expect(orphaned.refresh(token)).rejects.toBeInstanceOf(NotFoundError);
  });
});