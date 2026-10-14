import { NotFoundError, UnauthorizedError } from "../errors/app-errors.js";
import type { JwtConfig } from "../config/env.js";
import { toUserProfile, type UserRepository } from "../repositories/user.repository.js";
import type { TokenStore } from "../repositories/token-store.js";
import type { AuthLoginResponse, UserRecord } from "../models/index.js";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";

/**
 * OWASP-recommended argon2id parameters (m=19 MiB, t=2, p=1). Explicit so the
 * cost cannot drift with runtime defaults.
 */
export const hashPassword = async (plain: string): Promise<string> => {
  return await Bun.password.hash(plain, { algorithm: "argon2id" });
};

export const verifyPassword = async (plain: string, stored: string): Promise<boolean> => {
  if (!stored.startsWith("$argon2")) return false;
  try {
    return await Bun.password.verify(plain, stored, "argon2id");
  } catch {
    return false;
  }
};

let dummyHash: Promise<string> = hashPassword(`dummy-${crypto.randomUUID()}`);
const verifyAgainstDummy = async (plain: string): Promise<void> => {
  try {
    await verifyPassword(plain, await dummyHash);
  } catch {
    // The result is irrelevant: this exists only to equalise timing.
  }
};

export interface AuthenticatedPayload extends JWTPayload {
  sub: string;
  role: string;
}

export interface AuthService {
  signToken(user: UserRecord): Promise<string>;
  verifyToken(token: string): Promise<AuthenticatedPayload | null>;
  login(username: string, password: string): Promise<AuthLoginResponse>;
  refresh(token: string): Promise<AuthLoginResponse>;
  logout(token: string | null): Promise<void>;
}

export const makeAuthService = (
  users: UserRepository,
  config: JwtConfig,
  tokens: TokenStore,
): AuthService => {
  const secret = new TextEncoder().encode(config.secret);

  const tokenVersionOf = (user: UserRecord): number => user.tokenVersion ?? 0;

  const signToken = async (user: UserRecord): Promise<string> =>
    new SignJWT({
      sub: user.username,
      name: user.name,
      role: user.role,
      tv: tokenVersionOf(user),
      jti: crypto.randomUUID(),
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setIssuer(config.issuer)
      .setAudience(config.audience)
      .setExpirationTime(`${config.ttlSeconds}s`)
      .sign(secret);

  const verifyToken = async (token: string): Promise<AuthenticatedPayload | null> => {
    try {
      const { payload } = await jwtVerify(token, secret, {
        issuer: config.issuer,
        audience: config.audience,
      });
      if (typeof payload.sub !== "string") return null;
      if (typeof payload.jti === "string" && (await tokens.isRevoked(payload.jti))) {
        return null;
      }

      const user = await users.findByUsername(payload.sub);
      if (!user) return null;
      if ((payload.tv ?? 0) !== tokenVersionOf(user)) return null;

      return { ...payload, sub: user.username, role: user.role };
    } catch {
      return null;
    }
  };

  /**
   * Refresh accepts tokens that have JUST expired — that is the point of the
   * 401 → refresh → retry flow. Signature/issuer/audience stay strict; only
   * expiry is relaxed, and only for `refreshGraceSeconds`. Two bounds stop a
   * leaked token from sliding forever: the absolute session age measured from
   * `iat`, and one-time-use rotation of the presented `jti`.
   */
  const verifyForRefresh = async (token: string): Promise<JWTPayload | null> => {
    try {
      const { payload } = await jwtVerify(token, secret, {
        issuer: config.issuer,
        audience: config.audience,
        clockTolerance: config.refreshGraceSeconds,
      });
      if (typeof payload.exp !== "number" || typeof payload.iat !== "number") return null;

      const now = Math.floor(Date.now() / 1000);
      if (payload.exp + config.refreshGraceSeconds < now) return null;
      if (now - payload.iat > config.absoluteSessionSeconds) return null;

      if (typeof payload.sub === "string") {
        const user = await users.findByUsername(payload.sub);
        if (!user) return null;
        if (typeof payload.tv === "number" && payload.tv !== tokenVersionOf(user)) return null;
      }

      return payload;
    } catch {
      return null;
    }
  };

  const respondWith = async (user: UserRecord): Promise<AuthLoginResponse> => ({
    token: await signToken(user),
    user: toUserProfile(user),
  });

  return {
    signToken,
    verifyToken,

    login: async (username, password) => {
      const user = await users.findByUsername(username);
      if (!user) {
        await verifyAgainstDummy(password);
        throw new UnauthorizedError("Invalid credentials");
      }
      if (!(await verifyPassword(password, user.password))) {
        throw new UnauthorizedError("Invalid credentials");
      }
      return respondWith(user);
    },

    refresh: async (token) => {
      const payload = await verifyForRefresh(token);
      if (!payload || typeof payload.sub !== "string") {
        throw new UnauthorizedError("Invalid or expired token");
      }
      if (typeof payload.jti === "string") {
        await tokens.revoke(payload.jti, payload.exp ?? 0);
      }
      const user = await users.findByUsername(payload.sub);
      if (!user) throw new NotFoundError("User not found");
      return respondWith(user);
    },

    logout: async (token) => {
      if (!token) return;
      try {
        const { payload } = await jwtVerify(token, secret, {
          issuer: config.issuer,
          audience: config.audience,
          clockTolerance: config.refreshGraceSeconds,
        });
        if (typeof payload.jti === "string") {
          await tokens.revoke(payload.jti, payload.exp ?? 0);
        }
      } catch {
        // An unverifiable token has no meaningful `jti` to revoke.
      }
    },
  };
};

export const bearerToken = (request: Request): string | null => {
  const header = request.headers.get("authorization");
  if (!header || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token === "" ? null : token;
};
