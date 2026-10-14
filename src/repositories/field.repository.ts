import type { Db } from "mongodb";
import { Collections, type Field, type FieldCreate } from "../models/index.js";
import { makeRepository, type Repository } from "./base.repository.js";

export type FieldRepository = Repository<Field> & {
  createField(data: FieldCreate): Promise<Field>;
};

export const makeFieldRepository = (db: Db): FieldRepository => {
  const base = makeRepository<Field>(db, Collections.Fields);

  return {
    ...base,
    createField: async (data) =>
      base.create({
        ...data,
        soil: data.soil ?? "Clay-loam",
        irrigation: data.irrigation ?? "Drip",
        notes: data.notes ?? "",
      }),
  };
};