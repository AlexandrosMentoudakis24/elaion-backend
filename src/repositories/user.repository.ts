import type { Db } from "mongodb";
import { Collections, type UserProfile, type UserRecord, type UserCreate } from "../models/index.js";
import { ConflictError, NotFoundError } from "../errors/app-errors.js";
import { makeRepository, type Repository } from "./base.repository.js";
import { normalizeUsername } from "../services/policy.js";
import type { Pagination } from "../services/validation.js";

export interface UserRepository extends Repository<UserRecord> {
  findByUsername(username: string): Promise<UserRecord | null>;
  createUser(data: UserCreate): Promise<UserRecord>;
  updateByUsername(username: string, data: Partial<UserCreate>): Promise<UserRecord | null>;
  deleteByUsername(username: string): Promise<boolean>;
  bumpTokenVersion(username: string): Promise<void>;
  listProfiles(pagination?: Pagination): Promise<UserProfile[]>;
  getProfile(username: string): Promise<UserProfile>;
}

export const toUserProfile = (user: UserRecord): UserProfile => ({
  username: user.username,
  name: user.name,
  role: user.role,
});

export const makeUserRepository = (db: Db): UserRepository => {
  // Credentials are hard-deleted: a soft-deleted account would keep occupying
  // its username and keep a recoverable password hash around.
  const base = makeRepository<UserRecord>(db, Collections.Users, { softDelete: false });

  const requireByUsername = async (username: string): Promise<UserRecord> => {
    const user = await base.findOne({ username: normalizeUsername(username) });
    if (!user) throw new NotFoundError(`User "${username}" not found`);
    return user;
  };

  return {
    ...base,

    findByUsername: async (username) =>
      base.findOne({ username: normalizeUsername(username) }),

    createUser: async (data) => {
      const username = normalizeUsername(data.username);
      if (await base.findOne({ username })) {
        throw new ConflictError(`Username "${username}" already exists`);
      }
      return base.create({
        ...data,
        username,
        name: data.name ?? "",
        role: data.role ?? "",
        tokenVersion: 0,
      });
    },

    updateByUsername: async (username, data) => {
      const existing = await requireByUsername(username);

      const updates: Partial<UserRecord> = {};
      if (data.password !== undefined) updates.password = data.password;
      if (data.name !== undefined) updates.name = data.name;
      if (data.role !== undefined) updates.role = data.role;

      if (data.username !== undefined && normalizeUsername(data.username) !== existing.username) {
        const next = normalizeUsername(data.username);
        if (await base.findOne({ username: next })) {
          throw new ConflictError(`Username "${next}" already exists`);
        }
        updates.username = next;
      }

      // Any change to credentials or privileges invalidates every outstanding
      // token for this user; the holder must log in again.
      if (
        updates.password !== undefined ||
        updates.role !== undefined ||
        updates.username !== undefined
      ) {
        updates.tokenVersion = (existing.tokenVersion ?? 0) + 1;
      }

      if (Object.keys(updates).length === 0) return existing;

      return base.update(existing.id, updates);
    },

    deleteByUsername: async (username) => {
      const existing = await base.findOne({ username: normalizeUsername(username) });
      if (!existing) return false;
      return base.delete(existing.id);
    },

    bumpTokenVersion: async (username) => {
      const existing = await base.findOne({ username: normalizeUsername(username) });
      if (!existing) return;
      await base.update(existing.id, { tokenVersion: (existing.tokenVersion ?? 0) + 1 });
    },

    listProfiles: async (pagination) =>
      (await base.findAll({}, { sort: { username: 1 }, ...pagination })).map(toUserProfile),

    getProfile: async (username) => toUserProfile(await requireByUsername(username)),
  };
};
