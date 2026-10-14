import { connectDatabase, disconnectDatabase } from "../config/database.js";
import { Collections, type HarvestDay, type UserRecord } from "../models/index.js";
import { makeUserRepository } from "../repositories/user.repository.js";
import { makeFieldRepository } from "../repositories/field.repository.js";
import { makeEmployeeRepository } from "../repositories/employee.repository.js";
import { makeHarvestRepository } from "../repositories/harvest.repository.js";
import { makeHarvestDayRepository } from "../repositories/harvest-day.repository.js";
import { makeGrindRepository } from "../repositories/grind.repository.js";
import { makeSaleRepository } from "../repositories/sale.repository.js";
import { makeExpenseRepository } from "../repositories/expense.repository.js";
import { hashPassword } from "../services/auth.service.js";

const database = await connectDatabase();

const users = makeUserRepository(database.db);
const fields = makeFieldRepository(database.db);
const employees = makeEmployeeRepository(database.db);
const harvests = makeHarvestRepository(database.db);
const harvestDays = makeHarvestDayRepository(database.db);
const grinds = makeGrindRepository(database.db);
const sales = makeSaleRepository(database.db);
const expenses = makeExpenseRepository(database.db);

await Promise.all([
  database.db.collection(Collections.Users).deleteMany({}),
  database.db.collection(Collections.Fields).deleteMany({}),
  database.db.collection(Collections.Employees).deleteMany({}),
  database.db.collection(Collections.Harvests).deleteMany({}),
  database.db.collection(Collections.HarvestDays).deleteMany({}),
  database.db.collection(Collections.Grinds).deleteMany({}),
  database.db.collection(Collections.Sales).deleteMany({}),
  database.db.collection(Collections.Expenses).deleteMany({}),
  database.db.collection(Collections.Counters).deleteMany({}),
]);

const admin: UserRecord = await users.createUser({
  username: "admin",
  password: await hashPassword("olive123"),
  name: "Alexandros Mentoudakis",
  role: "Owner",
});
console.log(`Seeded user "${admin.username}"`);

const grove = await fields.createField({
  name: "North Grove",
  area: 12.5,
  trees: 640,
  variety: "Kalamata",
  location: "Ierapetra, Crete",
  soil: "Clay-loam",
  irrigation: "Drip",
  notes: "Oldest grove on the farm",
});
console.log(`Seeded field #${grove.id}`);

const worker = await employees.createEmployee({
  name: "Nikos Papadakis",
  role: "Harvest Lead",
  phone: "+30 6900000000",
  email: "nikos@example.com",
  notes: null,
});
console.log(`Seeded employee #${worker.id}`);

const harvest = await harvests.createHarvest({
  year: 2025,
  name: "Harvest 2025 - Ierapetra",
  status: "Completed",
  startDate: "2025-10-08",
  endDate: "2025-11-02",
  notes: "Good yields overall.",
  weather: "Warm and dry",
});
console.log(`Seeded harvest #${harvest.id}`);

const day = await harvestDays.createHarvestDay({
  harvestId: harvest.id,
  date: "2025-10-08",
  fieldId: grove.id,
  sacks: 42,
  workers: [{ employeeId: worker.id, pay: 120 }],
  notes: "Morning pick",
});
console.log(`Seeded harvest day #${day.id}`);

const grind = await grinds.createGrind({
  harvestId: harvest.id,
  date: "2025-10-20",
  factoryName: "Ierapetra Mill",
  olivesKg: 18400,
  oilProducedL: 2980,
  taxKeptL: 210,
  acidity: 0.28,
  notes: "",
});
console.log(`Seeded grind #${grind.id}`);

const sale = await sales.createSale({
  harvestId: harvest.id,
  date: "2025-11-10",
  buyerName: "Athens Olive Co.",
  oilL: 1200,
  pricePerL: 7.4,
  notes: "Partial shipment",
});
console.log(`Seeded sale #${sale.id}`);

const expense = await expenses.createExpense({
  harvestId: harvest.id,
  date: "2025-10-20",
  category: "Milling",
  description: "Milling fee for 18.4t",
  amount: 920,
});
console.log(`Seeded expense #${expense.id}`);

const totalDays: HarvestDay[] = await harvestDays.findAll();
console.log(`Seed complete: ${totalDays.length} harvest day(s), harvestId=${harvest.id}`);

await disconnectDatabase(database);