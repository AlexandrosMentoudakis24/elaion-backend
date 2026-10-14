import type { Db } from "mongodb";
import { Collections } from "../models/index.js";

export interface HarvestSummary {
  harvestId: number;
  sacks: number;
  oilNetL: number;
  laborPay: number;
}

export interface EmployeeSummary {
  employeeId: number;
  daysWorked: number;
  totalEarned: number;
}

export interface Stats {
  harvestSummaries: HarvestSummary[];
  employeeSummaries: EmployeeSummary[];
}

/** Soft-deleted rows must not appear in aggregates. */
const alive = { deletedAt: null } as const;

const byKey = <T>(items: T[], key: (item: T) => number): T[] =>
  [...items].sort((a, b) => key(a) - key(b));

/**
 * Aggregation runs inside MongoDB, so only the grouped summaries — bounded by
 * the number of harvests and employees — cross the wire, not every harvest
 * day and grind of every season.
 */
export const buildStats = async (db: Db): Promise<Stats> => {
  const days = db.collection(Collections.HarvestDays);
  const grinds = db.collection(Collections.Grinds);

  const [dayTotals, grindTotals, workerTotals] = await Promise.all([
    days
      .aggregate<{ _id: number; sacks: number; laborPay: number }>([
        { $match: alive },
        {
          $group: {
            _id: "$harvestId",
            sacks: { $sum: "$sacks" },
            laborPay: { $sum: { $sum: "$workers.pay" } },
          },
        },
      ])
      .toArray(),
    grinds
      .aggregate<{ _id: number; oilNetL: number }>([
        { $match: alive },
        {
          $group: {
            _id: "$harvestId",
            oilNetL: { $sum: { $subtract: ["$oilProducedL", "$taxKeptL"] } },
          },
        },
      ])
      .toArray(),
    days
      .aggregate<{ _id: number; daysWorked: number; totalEarned: number }>([
        { $match: alive },
        { $unwind: "$workers" },
        {
          $group: {
            _id: "$workers.employeeId",
            daysWorked: { $sum: 1 },
            totalEarned: { $sum: "$workers.pay" },
          },
        },
      ])
      .toArray(),
  ]);

  const harvests = new Map<number, HarvestSummary>();
  const upsert = (harvestId: number): HarvestSummary => {
    let summary = harvests.get(harvestId);
    if (summary === undefined) {
      summary = { harvestId, sacks: 0, oilNetL: 0, laborPay: 0 };
      harvests.set(harvestId, summary);
    }
    return summary;
  };

  for (const total of dayTotals) {
    const summary = upsert(total._id);
    summary.sacks = total.sacks;
    summary.laborPay = total.laborPay;
  }
  for (const total of grindTotals) {
    upsert(total._id).oilNetL = total.oilNetL;
  }

  const employees: EmployeeSummary[] = workerTotals.map((total) => ({
    employeeId: total._id,
    daysWorked: total.daysWorked,
    totalEarned: total.totalEarned,
  }));

  return {
    harvestSummaries: byKey([...harvests.values()], (summary) => summary.harvestId),
    employeeSummaries: byKey(employees, (employee) => employee.employeeId),
  };
};
