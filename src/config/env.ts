export interface JwtConfig {
  secret: string;
  ttlSeconds: number;
  absoluteSessionSeconds: number;
  refreshGraceSeconds: number;
  issuer: string;
  audience: string;
}

export interface LimitsConfig {
  maxRequestBodyBytes: number;
}

export interface RateLimitConfig {
  loginFailureLimit: number;
  loginFailureWindowSeconds: number;
  loginLockSeconds: number;
  loginAttemptLimit: number;
  loginAttemptWindowSeconds: number;
}

export const envInt = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

const int = envInt;

const MIN_SECRET_LENGTH = 32;

const PLACEHOLDER_SECRETS = new Set([
  "change_me_to_a_long_random_secret",
  "changeme",
  "secret",
  "test-secret",
  "jwt-secret",
  "supersecret",
  "please-change-me",
]);

export const isProduction = (): boolean => Bun.env.NODE_ENV === "production";

export const loadConfig = () => {
  const secret = Bun.env.JWT_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `JWT_SECRET is required and must be at least ${MIN_SECRET_LENGTH} characters ` +
      `(generate one with: openssl rand -hex 64)`,
    );
  }
  if (isProduction() && PLACEHOLDER_SECRETS.has(secret.toLowerCase())) {
    throw new Error("JWT_SECRET is a known sample value and cannot be used in production");
  }

  const corsOrigin = Bun.env.CORS_ORIGIN ?? "*";
  if (isProduction() && corsOrigin === "*") {
    throw new Error(
      "CORS_ORIGIN must be an explicit origin allowlist in production (comma-separated origins)",
    );
  }

  const ttlSeconds = int(Bun.env.JWT_TTL_SECONDS, 60 * 60 * 24 * 7);

  return {
    port: int(Bun.env.PORT, 8080),
    mongoUri: Bun.env.MONGODB_URI ?? "mongodb://localhost:27017",
    mongoDbName: Bun.env.MONGODB_DB_NAME ?? "elaion",
    jwt: {
      secret,
      ttlSeconds,
      absoluteSessionSeconds: int(
        Bun.env.JWT_ABSOLUTE_TTL_SECONDS,
        60 * 60 * 24 * 30,
      ),
      refreshGraceSeconds: int(Bun.env.JWT_REFRESH_GRACE_SECONDS, 300),
      issuer: Bun.env.JWT_ISSUER ?? "elaion-api",
      audience: Bun.env.JWT_AUDIENCE ?? "elaion-mobile",
    } satisfies JwtConfig,
    limits: {
      maxRequestBodyBytes: int(Bun.env.MAX_REQUEST_BODY_BYTES, 64 * 1024),
    } satisfies LimitsConfig,
    rateLimit: {
      loginFailureLimit: int(Bun.env.LOGIN_FAILURE_LIMIT, 10),
      loginFailureWindowSeconds: int(Bun.env.LOGIN_FAILURE_WINDOW_SECONDS, 900),
      loginLockSeconds: int(Bun.env.LOGIN_LOCK_SECONDS, 900),
      loginAttemptLimit: int(Bun.env.LOGIN_ATTEMPT_LIMIT, 60),
      loginAttemptWindowSeconds: int(Bun.env.LOGIN_ATTEMPT_WINDOW_SECONDS, 60),
    } satisfies RateLimitConfig,
    corsOrigin,
    logLevel: Bun.env.LOG_LEVEL ?? "info",
  };
};

export type AppConfig = ReturnType<typeof loadConfig>;
