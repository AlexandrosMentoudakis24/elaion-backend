import type { Db } from "mongodb";
import { Collections, type Expense, type ExpenseCreate } from "../models/index.js";
import { makeRepository, type Repository } from "./base.repository.js";

export type ExpenseRepository = Repository<Expense> & {
  createExpense(data: ExpenseCreate): Promise<Expense>;
  findByHarvestId(harvestId: number): Promise<Expense[]>;
};

export const makeExpenseRepository = (db: Db): ExpenseRepository => {
  const base = makeRepository<Expense>(db, Collections.Expenses);

  return {
    ...base,
    createExpense: async (data) =>
      base.create({ ...data, category: data.category ?? "Other" }),
    findByHarvestId: async (harvestId) =>
      base.findAll({ harvestId }, { sort: { date: 1, id: 1 } }),
  };
};