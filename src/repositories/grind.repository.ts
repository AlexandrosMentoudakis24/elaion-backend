import type { Db } from "mongodb";
import { Collections, type Grind, type GrindCreate } from "../models/index.js";
import { makeRepository, type Repository } from "./base.repository.js";

export type GrindRepository = Repository<Grind> & {
  createGrind(data: GrindCreate): Promise<Grind>;
  findByHarvestId(harvestId: number): Promise<Grind[]>;
};

export const makeGrindRepository = (db: Db): GrindRepository => {
  const base = makeRepository<Grind>(db, Collections.Grinds);

  return {
    ...base,
    createGrind: async (data) =>
      base.create({
        ...data,
        taxKeptL: data.taxKeptL ?? 0,
        acidity: data.acidity ?? 0.3,
        notes: data.notes ?? "",
      }),
    findByHarvestId: async (harvestId) =>
      base.findAll({ harvestId }, { sort: { date: 1, id: 1 } }),
  };
};