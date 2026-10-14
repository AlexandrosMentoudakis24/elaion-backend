import type { Db } from "mongodb";
import { Collections, type AuditLogEntry } from "../models/index.js";
import { logger } from "../logging.js";

export type AuditWriter = (entry: AuditLogEntry) => Promise<void>;

/**
 * Fire-and-forget audit trail: a failed audit write must never turn a
 * successful business operation into a 500, so failures are logged loudly
 * instead of propagated.
 */
export const makeAuditWriter = (db: Db): AuditWriter => {
  const collection = db.collection<AuditLogEntry>(Collections.AuditLogs);

  return async (entry) => {
    try {
      await collection.insertOne(entry);
    } catch (error) {
      logger.error("audit write failed", { error, entity: entry.entity, action: entry.action });
    }
  };
};
