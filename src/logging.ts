export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SENSITIVE_KEYS = new Set([
  "password",
  "newpassword",
  "oldpassword",
  "token",
  "refreshToken",
  "authorization",
  "secret",
  "jwt",
  "apikey",
  "cookie",
]);

const MAX_STRING_LENGTH = 512;
const MAX_DEPTH = 6;

const redact = (value: unknown, depth = 0): unknown => {
  if (typeof value === "string") {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}…[${value.length} chars]`
      : value;
  }
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return "[array]";
    return value.slice(0, 20).map((entry) => redact(entry, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    if (depth >= MAX_DEPTH) return "[object]";
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? "[redacted]" : redact(entry, depth + 1);
    }
    return result;
  }
  return value;
};

const configuredLevel: LogLevel = (() => {
  const raw = Bun.env.LOG_LEVEL?.toLowerCase();
  return raw === "debug" || raw === "info" || raw === "warn" || raw === "error" ? raw : "info";
})();

const write = (level: LogLevel, message: string, fields: Record<string, unknown>): void => {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[configuredLevel]) return;

  const line = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...(redact(fields) as Record<string, unknown>),
  };

  const serialized = JSON.stringify(line);
  if (level === "error" || level === "warn") console.error(serialized);
  else console.log(serialized);
};

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export const createLogger = (fields: Record<string, unknown> = {}): Logger => ({
  debug: (message, extra = {}) => write("debug", message, { ...fields, ...extra }),
  info: (message, extra = {}) => write("info", message, { ...fields, ...extra }),
  warn: (message, extra = {}) => write("warn", message, { ...fields, ...extra }),
  error: (message, extra = {}) => write("error", message, { ...fields, ...extra }),
  child: (extra) => createLogger({ ...fields, ...extra }),
});

export const logger: Logger = createLogger({ service: "elaion-api" });