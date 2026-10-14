import type { Collection, Db, Document, Filter, FindOptions } from "mongodb";
import { Collections } from "../models/index.js";

export interface Identified {
  id: number;
}

export interface Repository<T extends Identified> {
  findAll(filter?: Filter<Document>, options?: FindOptions<Document>): Promise<T[]>;
  findById(id: number): Promise<T | null>;
  findOne(filter: Filter<Document>): Promise<T | null>;
  create(data: Omit<T, "id">): Promise<T>;
  update(id: number, data: Partial<Omit<T, "id">>): Promise<T | null>;
  delete(id: number): Promise<boolean>;
  count(filter?: Filter<Document>): Promise<number>;
}

export interface RepositoryOptions {
  /** Business records are soft-deleted so payroll/sales history stays recoverable. */
  softDelete?: boolean;
}

const counterCollection = (db: Db): Collection<{ _id: string; value: number }> =>
  db.collection<{ _id: string; value: number }>(Collections.Counters);

const isDuplicateKey = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: number }).code === 11000;

/**
 * Two concurrent requests can race to insert the *first* counter document for
 * a collection; the loser's upsert fails with E11000 instead of winning the
 * increment, so retry once.
 */
export const nextId = async (db: Db, key: string): Promise<number> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = await counterCollection(db).findOneAndUpdate(
        { _id: key },
        { $inc: { value: 1 } },
        { upsert: true, returnDocument: "after" },
      );
      if (!result) throw new Error(`Failed to allocate id for "${key}"`);
      return result.value;
    } catch (error) {
      if (!isDuplicateKey(error) || attempt === 2) throw error;
    }
  }
  throw new Error(`Failed to allocate id for "${key}"`);
};

const stripInternalFields = (data: object): Record<string, unknown> => {
  const { id: _id, _id: _oid, ...rest } = data as Record<string, unknown>;
  return rest;
};

export const makeRepository = <T extends Identified>(
  db: Db,
  collectionName: string,
  options: RepositoryOptions = {},
): Repository<T> => {
  const softDelete = options.softDelete ?? true;
  const collection = db.collection(collectionName);

  const alive = (filter: Filter<Document>): Filter<Document> =>
    softDelete ? { ...filter, deletedAt: null } : filter;

  const clean = (doc: Document | null): T | null => {
    if (!doc) return null;
    const { _id: _oid, deletedAt: _deleted, ...rest } = doc;
    return rest as T;
  };

  return {
    findAll: async (filter = {}, options = {}) =>
      (await collection.find(alive(filter), options).toArray()).map((doc) => clean(doc) as T),

    findById: async (id: number) => clean(await collection.findOne(alive({ id }))),

    findOne: async (filter) => clean(await collection.findOne(alive(filter))),

    create: async (data) => {
      const id = await nextId(db, collectionName);
      const entity = { ...stripInternalFields(data), id } as T;
      await collection.insertOne({ ...entity });
      return entity;
    },

    update: async (id, data) => {
      const updates = stripInternalFields(data);
      if (Object.keys(updates).length === 0) {
        return clean(await collection.findOne(alive({ id }))) as T;
      }

      const result = await collection.findOneAndUpdate(
        alive({ id }),
        { $set: updates },
        { returnDocument: "after" },
      );
      return clean(result);
    },

    delete: async (id: number) => {
      if (!softDelete) {
        return (await collection.deleteOne({ id })).deletedCount > 0;
      }
      const result = await collection.findOneAndUpdate(
        alive({ id }),
        { $set: { deletedAt: new Date().toISOString() } },
        { returnDocument: "after" },
      );
      return result !== null;
    },

    count: async (filter = {}) => collection.countDocuments(alive(filter)),
  };
};
