import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SignJWT } from "jose";
import { connectDatabase, disconnectDatabase, type MongoContext } from "./config/database.js";
import { createApp, type App } from "./app.js";
import { buildStats } from "./services/stats.service.js";
import { buildExpenseRows } from "./services/expense-rows.service.js";
import { makeAuthService } from "./services/auth.service.js";
import { makeUserRepository } from "./repositories/user.repository.js";
import { makeFieldRepository } from "./repositories/field.repository.js";
import { makeEmployeeRepository } from "./repositories/employee.repository.js";
import { makeHarvestRepository } from "./repositories/harvest.repository.js";
import { makeHarvestDayRepository } from "./repositories/harvest-day.repository.js";
import { makeGrindRepository } from "./repositories/grind.repository.js";
import { makeSaleRepository } from "./repositories/sale.repository.js";
import { makeExpenseRepository } from "./repositories/expense.repository.js";
import { makeInMemoryTokenStore } from "./repositories/token-store.js";
import { Collections } from "./models/index.js";

const TEST_DB = "elaion-api-test";

const JWT = {
  secret: "integration-test-secret-value-that-is-long-enough",
  ttlSeconds: 3600,
  absoluteSessionSeconds: 60 * 60 * 24 * 30,
  refreshGraceSeconds: 3600,
  issuer: "elaion-api",
  audience: "elaion-mobile",
};

const BASE = "http://localhost:8080/api/v1";

let database: MongoContext;
let app: App;
let token: string;

const call = async (
  method: string,
  path: string,
  options: { body?: unknown; auth?: boolean } = {},
): Promise<{ status: number; body: any }> => {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.auth !== false && token) headers.authorization = `Bearer ${token}`;

  const response = await app.fetch(
    new Request(`${BASE}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
  );

  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};

beforeAll(async () => {
  database = await connectDatabase(undefined, TEST_DB);
  await Promise.all(
    Object.values(Collections).map((name) =>
      database.db.collection(name).deleteMany({}),
    ),
  );

  const users = makeUserRepository(database.db);
  await users.createUser({
    username: "admin",
    password: "olive123",
    name: "Alexandros Mentoudakis",
    role: "Owner",
  });

  const fields = makeFieldRepository(database.db);
  const employees = makeEmployeeRepository(database.db);
  const harvests = makeHarvestRepository(database.db);
  const harvestDays = makeHarvestDayRepository(database.db);
  const grinds = makeGrindRepository(database.db);
  const sales = makeSaleRepository(database.db);
  const expenses = makeExpenseRepository(database.db);

  app = createApp({
    auth: makeAuthService(users, JWT, makeInMemoryTokenStore()),
    users,
    fields,
    employees,
    harvests,
    harvestDays,
    grinds,
    sales,
    expenses,
    stats: () => buildStats(database.db),
    expenseRows: (query) =>
      buildExpenseRows(database.db, query),
  });
});

afterAll(async () => {
  await database.db.dropDatabase();
  await disconnectDatabase(database);
});

describe("health and auth", () => {
  test("health is reachable without a token", async () => {
    const res = await call("GET", "/health", { auth: false });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  test("rejects a missing token with 401", async () => {
    const res = await call("GET", "/fields", { auth: false });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Missing or invalid token", status: 401 });
  });

  test("rejects a garbage token with 401", async () => {
    const res = await app.fetch(new Request(`${BASE}/fields`, { headers: { authorization: "Bearer nope" } }));
    expect(res.status).toBe(401);
  });

  test("logs in and returns a token plus a password-free profile", async () => {
    const res = await call("POST", "/auth/login", {
      auth: false,
      body: { username: "admin", password: "olive123" },
    });

    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe("string");
    expect(res.body.user).toEqual({
      username: "admin",
      name: "Alexandros Mentoudakis",
      role: "Owner",
    });

    token = res.body.token;
  });

  test("rejects bad credentials with 401", async () => {
    const res = await call("POST", "/auth/login", {
      auth: false,
      body: { username: "admin", password: "wrong" },
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid credentials");
  });

  test("refreshes a session", async () => {
    const res = await call("POST", "/auth/refresh", { body: { token } });
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe("admin");
  });

  const signAgedToken = (expiredSecondsAgo: number): Promise<string> => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ sub: "admin", name: "Alexandros Mentoudakis", role: "Owner" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now - expiredSecondsAgo - 60)
      .setIssuer(JWT.issuer)
      .setAudience(JWT.audience)
      .setExpirationTime(now - expiredSecondsAgo)
      .sign(new TextEncoder().encode(JWT.secret));
  };

  test("refreshes without any Authorization header (expired callers)", async () => {
    const res = await call("POST", "/auth/refresh", {
      auth: false,
      body: { token },
    });
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe("admin");
  });

  test("accepts a just-expired token within the grace window", async () => {
    const expired = await signAgedToken(60); // expired 1 min ago, grace = ttl
    const res = await call("POST", "/auth/refresh", {
      auth: false,
      body: { token: expired },
    });
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe("admin");
    expect(typeof res.body.token).toBe("string");
  });

  test("rejects a token expired beyond the grace window", async () => {
    const ancient = await signAgedToken(JWT.ttlSeconds * 2 + 10);
    const res = await call("POST", "/auth/refresh", {
      auth: false,
      body: { token: ancient },
    });
    expect(res.status).toBe(401);
  });

  test("logout returns 204", async () => {
    const res = await call("POST", "/auth/logout");
    expect(res.status).toBe(204);
  });
});

describe("users", () => {
  test("never exposes passwords", async () => {
    const res = await call("GET", "/users");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].password).toBeUndefined();
  });

  test("creates and fetches by username", async () => {
    const created = await call("POST", "/users", {
      body: { username: "olivia", password: "secret123", name: "Olivia", role: "Field Supervisor" },
    });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      username: "olivia",
      name: "Olivia",
      role: "Field Supervisor",
    });

    const fetched = await call("GET", "/users/olivia");
    expect(fetched.status).toBe(200);
    expect(fetched.body.username).toBe("olivia");
  });

  test("returns 409 on a duplicate username", async () => {
    const res = await call("POST", "/users", { body: { username: "olivia", password: "x" } });
    expect(res.status).toBe(409);
    expect(res.body.status).toBe(409);
  });

  test("returns 404 for an unknown username", async () => {
    const res = await call("GET", "/users/ghost");
    expect(res.status).toBe(404);
  });

  test("updates and deletes a user", async () => {
    const updated = await call("PUT", "/users/olivia", { body: { role: "Owner" } });
    expect(updated.status).toBe(200);
    expect(updated.body.role).toBe("Owner");

    const deleted = await call("DELETE", "/users/olivia");
    expect(deleted.status).toBe(204);

    expect((await call("GET", "/users/olivia")).status).toBe(404);
  });
});

describe("fields", () => {
  let fieldId = 0;

  test("creates with contract defaults", async () => {
    const res = await call("POST", "/fields", {
      body: { name: "North Grove", area: 12.5, trees: 640, variety: "Kalamata", location: "Crete" },
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: "North Grove",
      area: 12.5,
      trees: 640,
      soil: "Clay-loam",
      irrigation: "Drip",
      notes: "",
    });
    expect(Number.isInteger(res.body.id)).toBe(true);
    expect("_id" in res.body).toBe(false);
    fieldId = res.body.id;
  });

  test("assigns sequential integer ids", async () => {
    const second = await call("POST", "/fields", {
      body: { name: "South Grove", area: 8, trees: 400, variety: "Koroneiki", location: "Crete" },
    });
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(fieldId + 1);
    expect("_id" in second.body).toBe(false);
  });

  test("never leaks the internal Mongo _id on reads", async () => {
    const fetched = await call("GET", `/fields/${fieldId}`);
    expect("_id" in fetched.body).toBe(false);

    const listed = await call("GET", "/fields");
    for (const field of listed.body) {
      expect("_id" in field).toBe(false);
    }
  });

  test("lists, fetches, updates and deletes", async () => {
    expect((await call("GET", "/fields")).body).toHaveLength(2);
    expect((await call("GET", `/fields/${fieldId}`)).body.name).toBe("North Grove");

    const updated = await call("PUT", `/fields/${fieldId}`, {
      body: { name: "North Grove", area: 13, trees: 650, variety: "Kalamata", location: "Crete", notes: "x" },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.area).toBe(13);
    expect(updated.body.notes).toBe("x");

    expect((await call("DELETE", `/fields/${fieldId}`)).status).toBe(204);
    expect((await call("GET", `/fields/${fieldId}`)).status).toBe(404);
  });

  test("returns 400 for a missing required field", async () => {
    const res = await call("POST", "/fields", { body: { name: "Broken" } });
    expect(res.status).toBe(400);
    expect(res.body.status).toBe(400);
    expect(typeof res.body.error).toBe("string");
  });

  test("returns 400 for a malformed id", async () => {
    expect((await call("GET", "/fields/abc")).status).toBe(400);
  });
});

describe("harvests and nested resources", () => {
  let harvestId = 0;
  let employeeId = 0;

  test("creates a harvest with defaults", async () => {
    const res = await call("POST", "/harvests", {
      body: { year: 2025, name: "Harvest 2025 - Ierapetra", startDate: "2025-10-08" },
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      year: 2025,
      status: "Completed",
      endDate: null,
      notes: "",
      weather: "",
    });
    harvestId = res.body.id;
  });

  test("filters harvests by year", async () => {
    expect((await call("GET", "/harvests/year/2025")).body).toHaveLength(1);
    expect((await call("GET", "/harvests/year/1999")).body).toHaveLength(0);
    expect((await call("GET", "/harvests/year/20x5")).status).toBe(400);
  });

  test("creates an employee", async () => {
    const res = await call("POST", "/employees", { body: { name: "Nikos", role: "Harvest Lead" } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ phone: "", email: null, notes: null });
    employeeId = res.body.id;
  });

  test("creates a harvest day with embedded workers", async () => {
    const res = await call("POST", "/harvest-days", {
      body: {
        harvestId,
        date: "2025-10-08",
        fieldId: 99,
        sacks: 42,
        workers: [{ employeeId, pay: 120 }],
      },
    });

    expect(res.status).toBe(201);
    expect(res.body.workers).toEqual([{ employeeId, pay: 120 }]);
    expect(Number.isInteger(res.body.harvestId)).toBe(true);
  });

  test("defaults workers to an empty list", async () => {
    const res = await call("POST", "/harvest-days", {
      body: { harvestId, date: "2025-10-09", fieldId: 99, sacks: 10 },
    });
    expect(res.body.workers).toEqual([]);
  });

  test("rejects malformed workers", async () => {
    const res = await call("POST", "/harvest-days", {
      body: { harvestId, date: "2025-10-09", fieldId: 99, sacks: 10, workers: [{ employeeId: "x", pay: 1 }] },
    });
    expect(res.status).toBe(400);
  });

  test("returns nested days", async () => {
    const res = await call("GET", `/harvests/${harvestId}/days`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  test("creates grinds, sales and expenses and lists them nested", async () => {
    const grind = await call("POST", "/grinds", {
      body: { harvestId, date: "2025-10-20", factoryName: "Mill", olivesKg: 18400, oilProducedL: 2980 },
    });
    expect(grind.status).toBe(201);
    expect(grind.body).toMatchObject({ taxKeptL: 0, acidity: 0.3, notes: "" });

    const sale = await call("POST", "/sales", {
      body: { harvestId, date: "2025-11-10", buyerName: "Athens Olive Co.", oilL: 1200, pricePerL: 7.4 },
    });
    expect(sale.status).toBe(201);
    expect(sale.body.oilL).toBe(1200);
    expect(sale.body.pricePerL).toBe(7.4);

    const expense = await call("POST", "/expenses", {
      body: { harvestId, date: "2025-10-20", description: "Milling fee", amount: 920 },
    });
    expect(expense.status).toBe(201);
    expect(expense.body.category).toBe("Other");

    expect((await call("GET", `/harvests/${harvestId}/grinds`)).body).toHaveLength(1);
    expect((await call("GET", `/harvests/${harvestId}/sales`)).body).toHaveLength(1);
    expect((await call("GET", `/harvests/${harvestId}/expenses`)).body).toHaveLength(1);
  });

  test("does not confuse /harvests/year/:year with /harvests/:id", async () => {
    const res = await call("GET", "/harvests/year/2025");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe("error contract", () => {
  test("returns 404 for an unknown route with the documented shape", async () => {
    const res = await call("GET", "/nope");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Route not found", status: 404 });
  });

  test("answers CORS preflight", async () => {
    const response = await app.fetch(
      new Request(`${BASE}/fields`, { method: "OPTIONS" }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("pagination", () => {
  test("pages through list results with page/limit", async () => {
    for (const name of ["Pag Alpha", "Pag Beta", "Pag Gamma"]) {
      const created = await call("POST", "/fields", {
        body: { name, area: 1, trees: 10, variety: "Koroneiki", location: "Crete" },
      });
      expect(created.status).toBe(201);
    }

    const all = await call("GET", "/fields");
    expect(all.status).toBe(200);
    expect(all.body.length).toBeGreaterThanOrEqual(3);

    const limit = 2;
    const seen: number[] = [];
    for (let page = 1; page <= Math.ceil(all.body.length / limit); page++) {
      const res = await call("GET", `/fields?page=${page}&limit=${limit}`);
      expect(res.status).toBe(200);
      expect(res.body.length).toBeLessThanOrEqual(limit);
      seen.push(...res.body.map((f: any) => f.id));
    }
    // Paged union equals the unpaginated list, with no duplicates or gaps.
    expect(seen).toEqual(all.body.map((f: any) => f.id));
    expect(new Set(seen).size).toBe(seen.length);

    const beyond = await call("GET", "/fields?page=99&limit=2");
    expect(beyond.status).toBe(200);
    expect(beyond.body).toHaveLength(0);
  });

  test("rejects invalid pagination with the documented error shape", async () => {
    const res = await call("GET", "/fields?page=0");
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe("string");
    expect(res.body.status).toBe(400);
  });
});

describe("stats and expense rows", () => {
  test("aggregates harvest and employee summaries", async () => {
    const res = await call("GET", "/stats");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.harvestSummaries)).toBe(true);
    expect(Array.isArray(res.body.employeeSummaries)).toBe(true);

    const harvests = await call("GET", "/harvests");
    const ids = harvests.body.map((h: any) => h.id);
    expect(res.body.harvestSummaries.length).toBeGreaterThanOrEqual(1);
    for (const summary of res.body.harvestSummaries) {
      expect(ids).toContain(summary.harvestId);
    }

    const summary = res.body.harvestSummaries[0];
    expect(summary.sacks).toBeGreaterThanOrEqual(52); // 42 + 10 seeded days
    expect(summary.laborPay).toBeGreaterThanOrEqual(120);
    expect(typeof summary.oilNetL).toBe("number");

    expect(res.body.employeeSummaries.length).toBeGreaterThanOrEqual(1);
    expect(res.body.employeeSummaries[0].daysWorked).toBeGreaterThanOrEqual(1);
    expect(res.body.employeeSummaries[0].totalEarned).toBeGreaterThanOrEqual(120);
  });

  test("joins manual expenses with labor rows", async () => {
    const harvests = await call("GET", "/harvests");
    const harvestId = harvests.body[0].id;

    const created = await call("POST", "/expenses", {
      body: {
        harvestId,
        date: "2025-10-10",
        category: "Electricity",
        description: "Demo irrigation pump",
        amount: 80.5,
      },
    });
    expect(created.status).toBe(201);

    const res = await call("GET", "/expense-rows");
    expect(res.status).toBe(200);

    const manual = res.body.rows.filter((r: any) => r.isLabor === false);
    const labor = res.body.rows.filter((r: any) => r.isLabor === true);
    const mine = manual.find(
      (r: any) => r.description === "Demo irrigation pump",
    );
    expect(mine).toBeDefined();
    expect(mine.harvestName).toBe(harvests.body[0].name);
    expect(mine.amount).toBe(80.5);
    expect(labor.length).toBeGreaterThanOrEqual(1);
    expect(typeof labor[0].id).toBe("string");
    expect(labor[0].id.startsWith("labor-")).toBe(true);

    expect(res.body.categories).toContain("Labor");
    expect(res.body.categories).toContain("Electricity");
    expect(res.body.totalRows).toBe(res.body.rows.length); // unpaginated
    expect(res.body.grandTotal).toBeGreaterThanOrEqual(res.body.sum);
  });

  test("filters by harvest and category server-side", async () => {
    const harvests = await call("GET", "/harvests");
    const harvestId = harvests.body[0].id;

    const electricity = await call(
      "GET",
      "/expense-rows?category=Electricity",
    );
    expect(electricity.status).toBe(200);
    expect(electricity.body.rows).toHaveLength(1);
    expect(
      electricity.body.rows.every((r: any) => r.category === "Electricity"),
    ).toBe(true);

    const labor = await call("GET", "/expense-rows?category=Labor");
    expect(labor.body.rows.length).toBeGreaterThanOrEqual(1);
    expect(labor.body.rows.every((r: any) => r.isLabor === true)).toBe(true);
    expect(labor.body.sum).toBeLessThanOrEqual(labor.body.grandTotal);

    const byHarvest = await call(
      "GET",
      `/expense-rows?harvestId=${harvestId}`,
    );
    expect(
      byHarvest.body.rows.every((r: any) => r.harvestId === harvestId),
    ).toBe(true);

    const none = await call("GET", "/expense-rows?harvestId=99999");
    expect(none.body.rows).toHaveLength(0);
    expect(none.body.totalRows).toBe(0);
    expect(none.body.sum).toBe(0);
    expect(none.body.grandTotal).toBeGreaterThan(0);
  });

  test("paginates rows without changing the totals", async () => {
    const page1 = await call("GET", "/expense-rows?page=1&limit=1");
    const page2 = await call("GET", "/expense-rows?page=2&limit=1");
    expect(page1.status).toBe(200);
    expect(page1.body.rows).toHaveLength(1);
    expect(page2.body.rows).toHaveLength(1);
    expect(page1.body.totalRows).toBeGreaterThanOrEqual(2);
    expect(page1.body.rows[0].id).not.toBe(page2.body.rows[0].id);
    expect(page1.body.grandTotal).toBe(page2.body.grandTotal);
    expect(page1.body.sum).toBe(page2.body.sum);
    expect(page1.body.categories).toEqual(page2.body.categories);
  });

  test("rejects malformed query params", async () => {
    const badPage = await call("GET", "/expense-rows?page=abc");
    expect(badPage.status).toBe(400);
    expect(badPage.body.status).toBe(400);
    const badId = await call("GET", "/expense-rows?harvestId=x");
    expect(badId.status).toBe(400);
  });
});
