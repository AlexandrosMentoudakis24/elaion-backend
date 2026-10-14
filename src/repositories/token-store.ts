import type { Db } from "mongodb";
import { Collections } from "../models/index.js";

/**
 * Revocation list for JWTs (`jti`). A token is valid only while its `jti` is
 * absent from this store, which is what makes logout and refresh-rotation
 * meaningful instead of cosmetic.
 */
export interface TokenStore {
  revoke(jti: string, expiresAtSeconds: number): Promise<void>;
  isRevoked(jti: string): Promise<boolean>;
}

export const makeInMemoryTokenStore = (): TokenStore => {
  const revoked = new Map<string, number>();

  const prune = (now: number): void => {
    for (const [jti, expiresAt] of revoked) {
      if (expiresAt <= now) revoked.delete(jti);
    }
  };

  return {
    revoke: async (jti, expiresAtSeconds) => {
      revoked.set(jti, expiresAtSeconds);
      prune(Math.floor(Date.now() / 1000));
    },
    isRevoked: async (jti) => {
      const expiresAt = revoked.get(jti);
      if (expiresAt === undefined) return false;
      if (expiresAt <= Math.floor(Date.now() / 1000)) {
        revoked.delete(jti);
        return false;
      }
      return true;
    },
  };
};

export const makeMongoTokenStore = (db: Db): TokenStore => {
  const collection = db.collection<{ _id: string; expiresAt: Date }>(
    Collections.RevokedTokens,
  );

  return {
    revoke: async (jti, expiresAtSeconds) => {
      await collection.updateOne(
        { _id: jti },
        { $set: { expiresAt: new Date(expiresAtSeconds * 1000) } },
        { upsert: true },
      );
    },
    isRevoked: async (jti) => (await collection.findOne({ _id: jti })) !== null,
  };
};
