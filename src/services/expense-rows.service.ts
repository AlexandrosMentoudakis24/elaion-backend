import type { Db, Document } from "mongodb";
import { Collections } from "../models/index.js";
import type { Pagination } from "./validation.js";

export interface ExpenseRow {
  id: number | string;
  harvestId: number;
  harvestName: string;
  date: string;
  category: string;
  description: string;
  amount: number;
  isLabor: boolean;
}

export interface ExpenseRowsQuery {
  harvestId?: number;
  category?: string;
  pagination?: Pagination;
}

export interface ExpenseRowsResult {
  rows: ExpenseRow[];
  totalRows: number;
  sum: number;
  grandTotal: number;
  categories: string[];
}

interface RawRow {
  id: number | string;
  harvestId: number;
  date: string;
  category: string;
  description: string;
  amount: number;
  isLabor: boolean;
}

/**
 * Manual expenses and harvest-day labour are unioned and totalled inside
 * MongoDB (`$unionWith` + `$facet`): only the requested page of rows leaves the
 * database, while `totalRows`/`sum`/`grandTotal`/`categories` are computed by
 * the server over the full (filtered) set.
 *
 * Ordering: date descending, ties broken by id ascending — manual rows carry
 * numeric ids and labour rows string ids, and MongoDB orders numbers before
 * strings, which reproduces the app's "manual first" grouping deterministically
 * (a stable order is what keeps `page`/`after` pagination gap-free).
 */
export const buildExpenseRows = async (
  db: Db,
  query: ExpenseRowsQuery = {},
): Promise<ExpenseRowsResult> => {
  const filter: Document = {};
  if (query.harvestId !== undefined) filter.harvestId = query.harvestId;
  if (query.category !== undefined) filter.category = query.category;

  const pagination = query.pagination ?? { skip: 0, limit: 50 };

  const manualRows: Document = {
    $project: {
      _id: 0,
      id: 1,
      harvestId: 1,
      date: 1,
      category: 1,
      description: 1,
      amount: 1,
      isLabor: { $literal: false },
    },
  };

  const laborRows: Document = {
    $project: {
      _id: 0,
      id: {
        $concat: ["labor-", { $toString: "$id" }, "-", { $toString: "$workers.employeeId" }],
      },
      harvestId: 1,
      date: 1,
      category: { $literal: "Labor" },
      description: { $concat: ["Day labor · ", "$date"] },
      amount: "$workers.pay",
      isLabor: { $literal: true },
    },
  };

  const [aggregated, harvests] = await Promise.all([
    db
      .collection(Collections.Expenses)
      .aggregate<{
        rows: RawRow[];
        totals: { _id: null; totalRows: number; sum: number }[];
        grand: { _id: null; grandTotal: number }[];
        categories: { name: string }[];
      }>([
        { $match: { deletedAt: null } },
        manualRows,
        {
          $unionWith: {
            coll: Collections.HarvestDays,
            pipeline: [
              { $match: { deletedAt: null } },
              { $unwind: "$workers" },
              laborRows,
            ],
          },
        },
        { $sort: { date: -1, id: 1 } },
        {
          $facet: {
            rows: [
              { $match: filter },
              { $skip: pagination.skip },
              { $limit: pagination.limit },
            ],
            totals: [
              { $match: filter },
              {
                $group: {
                  _id: null,
                  totalRows: { $sum: 1 },
                  sum: { $sum: "$amount" },
                },
              },
            ],
            grand: [{ $group: { _id: null, grandTotal: { $sum: "$amount" } } }],
            categories: [
              { $group: { _id: "$category" } },
              { $sort: { _id: 1 } },
              { $project: { _id: 0, name: "$_id" } },
            ],
          },
        },
      ])
      .toArray(),
    db
      .collection<{ id: number; name: string }>(Collections.Harvests)
      .find({ deletedAt: null }, { projection: { _id: 0, id: 1, name: 1 } })
      .toArray(),
  ]);

  const names = new Map(harvests.map((harvest) => [harvest.id, harvest.name]));

  const facet = aggregated[0];
  const total = facet?.totals[0];
  const grand = facet?.grand[0];

  const rows: ExpenseRow[] = (facet?.rows ?? []).map((row) => ({
    ...row,
    harvestName: names.get(row.harvestId) ?? "",
  }));

  return {
    rows,
    totalRows: total?.totalRows ?? 0,
    sum: total?.sum ?? 0,
    grandTotal: grand?.grandTotal ?? 0,
    categories: (facet?.categories ?? []).map((entry) => entry.name),
  };
};
