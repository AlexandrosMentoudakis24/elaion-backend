import type { Db } from "mongodb";
import { Collections, type Employee, type EmployeeCreate } from "../models/index.js";
import { makeRepository, type Repository } from "./base.repository.js";

export type EmployeeRepository = Repository<Employee> & {
  createEmployee(data: EmployeeCreate): Promise<Employee>;
};

export const makeEmployeeRepository = (db: Db): EmployeeRepository => {
  const base = makeRepository<Employee>(db, Collections.Employees);

  return {
    ...base,
    createEmployee: async (data) =>
      base.create({
        ...data,
        phone: data.phone ?? "",
        email: data.email ?? null,
        notes: data.notes ?? null,
      }),
  };
};