import type { Db } from "mongodb";
import { Collections, type HarvestDay, type HarvestDayCreate } from "../models/index.js";
import { makeRepository, type Repository } from "./base.repository.js";

export type HarvestDayRepository = Repository<HarvestDay> & {
  createHarvestDay(data: HarvestDayCreate): Promise<HarvestDay>;
  findByHarvestId(harvestId: number): Promise<HarvestDay[]>;
};

export const makeHarvestDayRepository = (db: Db): HarvestDayRepository => {
  const base = makeRepository<HarvestDay>(db, Collections.HarvestDays);

  return {
    ...base,
    createHarvestDay: async (data) =>
      base.create({
        ...data,
        workers: data.workers ?? [],
        notes: data.notes ?? "",
      }),
    findByHarvestId: async (harvestId) =>
      base.findAll({ harvestId }, { sort: { date: 1, id: 1 } }),
  };
};