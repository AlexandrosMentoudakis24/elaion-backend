import type { Db } from "mongodb";
import { Collections, type Harvest, type HarvestCreate } from "../models/index.js";
import { makeRepository, type Repository } from "./base.repository.js";

export type HarvestRepository = Repository<Harvest> & {
  createHarvest(data: HarvestCreate): Promise<Harvest>;
  findByYear(year: number): Promise<Harvest[]>;
};

export const makeHarvestRepository = (db: Db): HarvestRepository => {
  const base = makeRepository<Harvest>(db, Collections.Harvests);

  return {
    ...base,
    createHarvest: async (data) =>
      base.create({
        ...data,
        status: data.status ?? "Completed",
        endDate: data.endDate ?? null,
        notes: data.notes ?? "",
        weather: data.weather ?? "",
      }),
    findByYear: async (year) => base.findAll({ year }, { sort: { year: -1, id: -1 } }),
  };
};