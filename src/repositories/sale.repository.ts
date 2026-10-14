import type { Db } from "mongodb";
import { Collections, type Sale, type SaleCreate } from "../models/index.js";
import { makeRepository, type Repository } from "./base.repository.js";

export type SaleRepository = Repository<Sale> & {
  createSale(data: SaleCreate): Promise<Sale>;
  findByHarvestId(harvestId: number): Promise<Sale[]>;
};

export const makeSaleRepository = (db: Db): SaleRepository => {
  const base = makeRepository<Sale>(db, Collections.Sales);

  return {
    ...base,
    createSale: async (data) =>
      base.create({ ...data, notes: data.notes ?? "" }),
    findByHarvestId: async (harvestId) =>
      base.findAll({ harvestId }, { sort: { date: 1, id: 1 } }),
  };
};