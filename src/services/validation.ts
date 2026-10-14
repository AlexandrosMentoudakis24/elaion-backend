import { ValidationError } from "../errors/app-errors.js";
import { envInt } from "../config/env.js";

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const MAX_STRING_LENGTH = envInt(Bun.env.MAX_STRING_LENGTH, 8_192);
export const MAX_ARRAY_LENGTH = envInt(Bun.env.MAX_ARRAY_LENGTH, 500);

const isRealDate = (value: string): boolean => {
  if (!ISO_DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
};

interface Bounds {
  min?: number;
  max?: number;
}

const checkBounds = (field: string, value: number, bounds?: Bounds): number => {
  if (bounds?.min !== undefined && value < bounds.min) {
    throw new ValidationError(`Field "${field}" must be >= ${bounds.min}`);
  }
  if (bounds?.max !== undefined && value > bounds.max) {
    throw new ValidationError(`Field "${field}" must be <= ${bounds.max}`);
  }
  return value;
};

export class Body {
  private readonly data: Record<string, unknown>;

  constructor(data: unknown) {
    if (!isPlainObject(data)) {
      throw new ValidationError("Request body must be a JSON object");
    }
    this.data = data;
  }

  private present(field: string): unknown {
    const value = this.data[field];
    if (value === undefined || value === null) {
      throw new ValidationError(`Field "${field}" is required`);
    }
    return value;
  }

  string(field: string): string {
    const value = this.present(field);
    if (typeof value !== "string" || value.trim() === "") {
      throw new ValidationError(`Field "${field}" must be a non-empty string`);
    }
    if (value.length > MAX_STRING_LENGTH) {
      throw new ValidationError(
        `Field "${field}" must be at most ${MAX_STRING_LENGTH} characters`,
      );
    }
    return value;
  }

  optionalString(field: string): string | undefined {
    const value = this.data[field];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") {
      throw new ValidationError(`Field "${field}" must be a string`);
    }
    if (value.length > MAX_STRING_LENGTH) {
      throw new ValidationError(
        `Field "${field}" must be at most ${MAX_STRING_LENGTH} characters`,
      );
    }
    return value;
  }

  nullableString(field: string): string | null {
    const value = this.data[field];
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") {
      throw new ValidationError(`Field "${field}" must be a string or null`);
    }
    if (value.length > MAX_STRING_LENGTH) {
      throw new ValidationError(
        `Field "${field}" must be at most ${MAX_STRING_LENGTH} characters`,
      );
    }
    return value;
  }

  number(field: string, bounds?: Bounds): number {
    const value = this.present(field);
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new ValidationError(`Field "${field}" must be a number`);
    }
    return checkBounds(field, value, bounds);
  }

  integer(field: string, bounds?: Bounds): number {
    const value = this.number(field, bounds);
    if (!Number.isInteger(value)) {
      throw new ValidationError(`Field "${field}" must be an integer`);
    }
    return value;
  }

  optionalNumber(field: string, bounds?: Bounds): number | undefined {
    const value = this.data[field];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new ValidationError(`Field "${field}" must be a number`);
    }
    return checkBounds(field, value, bounds);
  }

  /**
   * Unknown values are rejected rather than silently coerced to a fallback:
   * a typo like `"lecricity"` must not be persisted as a different category.
   * Absent values keep the contract default, and documented aliases
   * (`inProgress`, `clay_loam`, …) are still accepted.
   */
  enum<T extends string>(field: string, allowed: readonly T[], fallback: T): T {
    const value = this.optionalString(field);
    if (value === undefined) return fallback;
    const exact = allowed.find((candidate) => candidate === value);
    if (exact) return exact;
    const normalised = value.toLowerCase().replace(/[\s_-]/g, "");
    const loose = allowed.find(
      (candidate) => candidate.toLowerCase().replace(/[\s_-]/g, "") === normalised,
    );
    if (loose) return loose;
    throw new ValidationError(
      `Field "${field}" must be one of: ${allowed.join(", ")}`,
    );
  }

  date(field: string): string {
    const value = this.string(field);
    if (!isRealDate(value)) {
      throw new ValidationError(`Field "${field}" must be a valid date (YYYY-MM-DD)`);
    }
    return value;
  }

  optionalDate(field: string): string | null {
    const value = this.data[field];
    if (value === undefined || value === null) return null;
    if (typeof value !== "string" || !isRealDate(value)) {
      throw new ValidationError(`Field "${field}" must be a valid date (YYYY-MM-DD)`);
    }
    return value;
  }

  workerPays(field: string): { employeeId: number; pay: number }[] {
    const value = this.data[field];
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
      throw new ValidationError(`Field "${field}" must be an array`);
    }
    if (value.length > MAX_ARRAY_LENGTH) {
      throw new ValidationError(
        `Field "${field}" must contain at most ${MAX_ARRAY_LENGTH} entries`,
      );
    }

    return value.map((entry, index) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new ValidationError(`Field "${field}[${index}]" must be an object`);
      }
      const item = entry as Record<string, unknown>;
      const employeeId = item.employeeId;
      const pay = item.pay;

      if (typeof employeeId !== "number" || !Number.isInteger(employeeId) || employeeId < 1) {
        throw new ValidationError(
          `Field "${field}[${index}].employeeId" must be a positive integer`,
        );
      }
      if (typeof pay !== "number" || !Number.isFinite(pay)) {
        throw new ValidationError(`Field "${field}[${index}].pay" must be a number`);
      }
      return { employeeId, pay: checkBounds(`${field}[${index}].pay`, pay, { min: 0, max: 1_000_000 }) };
    });
  }
}

export const parseId = (raw: string | undefined, label = "id"): number => {
  const parsed = Number(raw);
  if (raw === undefined || raw === "" || !Number.isInteger(parsed) || parsed < 1) {
    throw new ValidationError(`"${label}" must be a positive integer`);
  }
  return parsed;
};

export const parseYear = (raw: string | undefined): number => {
  const parsed = Number(raw);
  if (raw === undefined || !/^\d{4}$/.test(raw)) {
    throw new ValidationError(`"year" must be a 4-digit integer`);
  }
  if (parsed < 1900 || parsed > 2100) {
    throw new ValidationError(`"year" must be between 1900 and 2100`);
  }
  return parsed;
};

export interface Pagination {
  skip: number;
  limit: number;
}

export const DEFAULT_PAGE_LIMIT = envInt(Bun.env.DEFAULT_PAGE_LIMIT, 50);
export const MAX_PAGE_LIMIT = envInt(Bun.env.MAX_PAGE_LIMIT, 200);

const parsePageInt = (raw: string, label: string): number => {
  const parsed = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(parsed) || parsed < 1) {
    throw new ValidationError(`"${label}" must be a positive integer`);
  }
  return parsed;
};

/**
 * Every list endpoint is paginated: with no `?page`/`?limit` the caller gets
 * the first `DEFAULT_PAGE_LIMIT` rows instead of the whole collection.
 */
export const parsePagination = (query: URLSearchParams): Pagination => {
  const rawPage = query.get("page");
  const rawLimit = query.get("limit");
  const page = rawPage === null ? 1 : parsePageInt(rawPage, "page");
  const limit =
    rawLimit === null
      ? DEFAULT_PAGE_LIMIT
      : Math.min(parsePageInt(rawLimit, "limit"), MAX_PAGE_LIMIT);
  return { skip: (page - 1) * limit, limit };
};

/** Cursor alternative to `page`: `?after=<id>&limit=<n>` (O(1) per page). */
export const parseAfter = (query: URLSearchParams): number | undefined => {
  const raw = query.get("after");
  if (raw === null) return undefined;
  return parseId(raw, "after");
};
