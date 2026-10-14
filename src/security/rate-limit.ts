import { TooManyRequestsError, ValidationError } from "../errors/app-errors.js";
import type { RateLimitConfig } from "../config/env.js";

interface KeyState {
  attempts: number[];
  failures: number[];
  lockedUntil: number;
}

export interface LoginThrottle {
  /** Throws 429 when the key is locked or over the attempt budget. */
  beforeAttempt(ip: string, username: string): void;
  recordFailure(ip: string, username: string): void;
  reset(ip: string, username: string): void;
}

const prune = (hits: number[], since: number): number[] =>
  hits.filter((at) => at > since);

/**
 * In-memory sliding-window throttle for a single instance. Keys on both the
 * client IP and the target username so neither a botnet nor a single account
 * can brute-force credentials without limit.
 */
export const makeLoginThrottle = (config: RateLimitConfig): LoginThrottle => {
  const states = new Map<string, KeyState>();
  const nowSeconds = (): number => Math.floor(Date.now() / 1000);

  const state = (key: string): KeyState => {
    let entry = states.get(key);
    if (entry === undefined) {
      entry = { attempts: [], failures: [], lockedUntil: 0 };
      states.set(key, entry);
    }
    return entry;
  };

  const check = (key: string, now: number): void => {
    const entry = state(key);

    if (entry.lockedUntil > now) {
      throw new TooManyRequestsError(
        "Too many attempts, try again later",
        entry.lockedUntil - now,
      );
    }

    entry.attempts = prune(entry.attempts, now - config.loginAttemptWindowSeconds);
    if (entry.attempts.length >= config.loginAttemptLimit) {
      const retryAfter = entry.attempts[0]! + config.loginAttemptWindowSeconds - now;
      throw new TooManyRequestsError(
        "Too many attempts, try again later",
        Math.max(retryAfter, 1),
      );
    }
  };

  const fail = (key: string, now: number): void => {
    const entry = state(key);
    entry.failures = prune(entry.failures, now - config.loginFailureWindowSeconds);
    entry.failures.push(now);
    if (entry.failures.length >= config.loginFailureLimit) {
      entry.lockedUntil = now + config.loginLockSeconds;
    }
  };

  const succeed = (key: string): void => {
    const entry = state(key);
    entry.failures = [];
    entry.lockedUntil = 0;
  };

  const keysFor = (ip: string, username: string): [string, string] => [
    `ip:${ip}`,
    `user:${username.toLowerCase()}`,
  ];

  return {
    beforeAttempt: (ip, username) => {
      if (typeof username !== "string" || username.trim() === "") {
        throw new ValidationError('Field "username" is required');
      }
      const now = nowSeconds();
      for (const key of keysFor(ip, username)) check(key, now);
      for (const key of keysFor(ip, username)) state(key).attempts.push(now);
    },
    recordFailure: (ip, username) => {
      const now = nowSeconds();
      for (const key of keysFor(ip, username)) fail(key, now);
    },
    reset: (ip, username) => {
      for (const key of keysFor(ip, username)) succeed(key);
    },
  };
};
