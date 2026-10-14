import { connectDatabase, disconnectDatabase } from "./config/database.js";
import { loadConfig } from "./config/env.js";
import { createApp } from "./app.js";
import { json } from "./http.js";
import { logger } from "./logging.js";
import { makeAuthService } from "./services/auth.service.js";
import { makeMongoTokenStore } from "./repositories/token-store.js";
import { makeUserRepository } from "./repositories/user.repository.js";
import { makeFieldRepository } from "./repositories/field.repository.js";
import { makeEmployeeRepository } from "./repositories/employee.repository.js";
import { makeHarvestRepository } from "./repositories/harvest.repository.js";
import { makeHarvestDayRepository } from "./repositories/harvest-day.repository.js";
import { makeGrindRepository } from "./repositories/grind.repository.js";
import { makeSaleRepository } from "./repositories/sale.repository.js";
import { makeExpenseRepository } from "./repositories/expense.repository.js";
import { makeAuditWriter } from "./observability/audit.js";
import { makeMetrics } from "./observability/metrics.js";
import { makeLoginThrottle } from "./security/rate-limit.js";
import { buildStats } from "./services/stats.service.js";
import { buildExpenseRows } from "./services/expense-rows.service.js";

const config = loadConfig();
const database = await connectDatabase();

const users = makeUserRepository(database.db);

const fields = makeFieldRepository(database.db);
const employees = makeEmployeeRepository(database.db);
const harvests = makeHarvestRepository(database.db);
const harvestDays = makeHarvestDayRepository(database.db);
const grinds = makeGrindRepository(database.db);
const sales = makeSaleRepository(database.db);
const expenses = makeExpenseRepository(database.db);

const metrics = makeMetrics();

let server: ReturnType<typeof Bun.serve> | undefined;

const app = createApp(
  {
    auth: makeAuthService(users, config.jwt, makeMongoTokenStore(database.db)),
    users,
    fields,
    employees,
    harvests,
    harvestDays,
    grinds,
    sales,
    expenses,
    db: database.db,
    audit: makeAuditWriter(database.db),
    metrics,
    loginThrottle: makeLoginThrottle(config.rateLimit),
    stats: () => buildStats(database.db),
    expenseRows: (query) => buildExpenseRows(database.db, query),
  },
  {
    corsOrigin: config.corsOrigin,
    maxRequestBodyBytes: config.limits.maxRequestBodyBytes,
    clientIp: (request) => server?.requestIP(request)?.address ?? "local",
    logger: logger.child({ service: "elaion-api" }),
  },
);

server = Bun.serve({
  port: config.port,
  fetch: app.fetch,
  maxRequestBodySize: config.limits.maxRequestBodyBytes,
  // Safety net for failures that escape the per-request handler: still the
  // documented `{ error, status }` JSON shape, never an HTML stack page.
  error: (error) => {
    logger.error("server error", { error });
    return json({ error: "Internal server error", status: 500 }, 500);
  },
});

logger.info("server listening", {
  port: server.port,
  baseUrl: `http://localhost:${server.port}/api/v1`,
  env: Bun.env.NODE_ENV ?? "development",
});

let shuttingDown = false;
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("shutdown requested", { signal });

  server?.stop(false); // stop accepting, let in-flight requests finish
  await app.drain(10_000);
  await disconnectDatabase(database);

  logger.info("shutdown complete", { signal });
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => {
  logger.error("unhandled rejection", { reason });
});
process.on("uncaughtException", (error) => {
  logger.error("uncaught exception", { error });
  process.exit(1);
});
