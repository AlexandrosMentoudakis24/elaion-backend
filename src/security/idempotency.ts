import type { Db } from "mongodb";
import { Collections } from "../models/index.js";

export interface StoredResponse {
  status: number;
  body: unknown;
}

export interface IdempotencyStore {
  find(key: string): Promise<StoredResponse | null>;
  save(key: string, response: StoredResponse): Promise<void>;
}

const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

/**
 * Replay cache for `Idempotency-Key`. A retried POST over a flaky mobile
 * connection returns the first stored response instead of allocating a second
 * entity id. Keyed by SHA-256 of method+path+key, scoped per instance.
 */
export const makeIdempotencyStore = (
  db: Db,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): IdempotencyStore => {
  const collection = db.collection<{
    _id: string;
    status: number;
    body: unknown;
    expiresAt: Date;
  }>(Collections.IdempotencyKeys);

  return {
    find: async (key) => {
      const doc = await collection.findOne({ _id: key });
      if (!doc) return null;
      return { status: doc.status, body: doc.body };
    },
    save: async (key, response) => {
      await collection.updateOne(
        { _id: key },
        {
          $set: {
            status: response.status,
            body: response.body,
            expiresAt: new Date(Date.now() + ttlSeconds * 1000),
          },
        },
        { upsert: true },
      );
    },
  };
};

export const idempotencyHash = async (
  method: string,
  path: string,
  key: string,
): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${method} ${path} ${key}`),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};
