import { json, noContent } from "../http.js";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "../errors/app-errors.js";
import {
  Body,
  parseAfter,
  parseId,
  parsePagination,
  parseYear,
} from "../services/validation.js";
import {
  assertPasswordPolicy,
  assertUsernamePolicy,
  normalizeUsername,
} from "../services/policy.js";
import { logger } from "../logging.js";
import { buildOpenApi } from "../openapi.js";
import type { Metrics } from "../observability/metrics.js";
import type { AuditWriter } from "../observability/audit.js";
import type { LoginThrottle } from "../security/rate-limit.js";
import type { Stats } from "../services/stats.service.js";
import type { ExpenseRowsQuery, ExpenseRowsResult } from "../services/expense-rows.service.js";
import { hashPassword, type AuthService } from "../services/auth.service.js"; import { toUserProfile, type UserRepository } from "../repositories/user.repository.js";
import type { FieldRepository } from "../repositories/field.repository.js";
import type { EmployeeRepository } from "../repositories/employee.repository.js";
import type { HarvestRepository } from "../repositories/harvest.repository.js";
import type { HarvestDayRepository } from "../repositories/harvest-day.repository.js";
import type { GrindRepository } from "../repositories/grind.repository.js";
import type { SaleRepository } from "../repositories/sale.repository.js";
import type { ExpenseRepository } from "../repositories/expense.repository.js";
import {
  EXPENSE_CATEGORIES,
  HARVEST_STATUSES,
  IRRIGATION_TYPES,
  SOIL_TYPES,
  type AuditLogEntry,
  type ExpenseCreate,
  type FieldCreate,
  type GrindCreate,
  type HarvestCreate,
  type HarvestDayCreate,
  type SaleCreate,
  type UserCreate,
} from "../models/index.js";
import type { Db, Document, Filter, FindOptions, Sort } from "mongodb";

const BASE = "/api/v1";

export const OWNER_ROLE = "Owner";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export type Access = "public" | "authenticated" | "owner";

export interface Caller {
  username: string;
  role: string;
}

export interface RouteContext {
  request: Request;
  params: Record<string, string>;
  username: string | null;
  caller: Caller | null;
  token: string | null;
  requestId: string;
  ip: string;
  body: () => Promise<Body>;
  query: URLSearchParams;
}

export interface Route {
  method: HttpMethod;
  path: string;
  access: Access;
  handler: (ctx: RouteContext) => Promise<Response>;
}

export interface AppDeps {
  auth: AuthService;
  stats: () => Promise<Stats>;
  expenseRows: (query: ExpenseRowsQuery) => Promise<ExpenseRowsResult>;
  users: UserRepository;
  fields: FieldRepository;
  employees: EmployeeRepository;
  harvests: HarvestRepository;
  harvestDays: HarvestDayRepository;
  grinds: GrindRepository;
  sales: SaleRepository;
  expenses: ExpenseRepository;
  db?: Db;
  audit?: AuditWriter;
  loginThrottle?: LoginThrottle;
  metrics?: Metrics;
}

const route = (
  method: HttpMethod,
  path: string,
  handler: (ctx: RouteContext) => Promise<Response>,
  access: Access = "authenticated",
): Route => ({ method, path, access, handler });

const required = <T>(value: T | null, label: string): T => {
  if (value === null) throw new NotFoundError(`${label} not found`);
  return value;
};

const requireCaller = (ctx: RouteContext): Caller => {
  if (ctx.caller === null) throw new UnauthorizedError("Invalid or expired token");
  return ctx.caller;
};

const writeAudit = async (
  audit: AuditWriter | undefined,
  ctx: RouteContext,
  entry: Omit<AuditLogEntry, "actor" | "requestId" | "at">,
): Promise<void> => {
  if (!audit) return;
  await audit({
    ...entry,
    actor: ctx.caller?.username ?? null,
    requestId: ctx.requestId,
    at: new Date().toISOString(),
  });
};

/** Referential integrity: a child row may only point at a live parent. */
const requireRef = async <T>(record: T | null, label: string): Promise<T> => {
  if (record === null) throw new NotFoundError(`${label} not found`);
  return record;
};

const requireRefs = async (
  repo: { findAll: (filter: Filter<Document>) => Promise<{ id: number; }[]>; },
  ids: number[],
  label: string,
): Promise<void> => {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  const found = await repo.findAll({ id: { $in: unique } });
  const present = new Set(found.map((record) => record.id));
  const missing = unique.find((id) => !present.has(id));
  if (missing !== undefined) throw new NotFoundError(`${label} ${missing} not found`);
};

interface Crud {
  list: (filter: Filter<Document>, options: FindOptions<Document>) => Promise<unknown>;
  create: (body: Body) => Promise<unknown>;
  get: (id: number) => Promise<unknown | null>;
  update: (id: number, body: Body) => Promise<unknown | null>;
  remove: (id: number) => Promise<boolean>;
}

interface CrudOptions {
  audit?: AuditWriter | undefined;
  sort: Sort;
  /** Throw 409 to block a delete that would orphan child records. */
  guardDelete?: (id: number) => Promise<void>;
}

const entityId = (record: unknown): number | null => {
  const id = (record as { id?: unknown; } | null)?.id;
  return typeof id === "number" ? id : null;
};

const listOptions = (
  ctx: RouteContext,
  defaultSort: Sort,
): { filter: Filter<Document>; options: FindOptions<Document>; } => {
  const { skip, limit } = parsePagination(ctx.query);
  const after = parseAfter(ctx.query);
  // Cursor mode orders by id, so `after` is always a valid position in the
  // result order and each page costs O(1) instead of O(skip).
  if (after !== undefined) {
    return { filter: { id: { $gt: after } }, options: { sort: { id: 1 }, limit } };
  }
  return { filter: {}, options: { sort: defaultSort, skip, limit } };
};

const crudRoutes = (base: string, repo: Crud, label: string, hooks: CrudOptions): Route[] => [
  route("GET", `${BASE}${base}`, async (ctx) => {
    const { filter, options } = listOptions(ctx, hooks.sort);
    return json(await repo.list(filter, options));
  }),
  route("POST", `${BASE}${base}`, async (ctx) => {
    const created = await repo.create(await ctx.body());
    await writeAudit(hooks.audit, ctx, {
      action: "create",
      entity: label,
      entityId: entityId(created),
      after: created,
    });
    return json(created, 201);
  }),
  route("GET", `${BASE}${base}/:id`, async (ctx) =>
    json(required(await repo.get(parseId(ctx.params.id)), label)),
  ),
  route("PUT", `${BASE}${base}/:id`, async (ctx) => {
    const id = parseId(ctx.params.id);
    const before = required(await repo.get(id), label);
    const updated = required(await repo.update(id, await ctx.body()), label);
    await writeAudit(hooks.audit, ctx, {
      action: "update",
      entity: label,
      entityId: id,
      before,
      after: updated,
    });
    return json(updated);
  }),
  route("DELETE", `${BASE}${base}/:id`, async (ctx) => {
    const id = parseId(ctx.params.id);
    const before = required(await repo.get(id), label);
    if (hooks.guardDelete) await hooks.guardDelete(id);
    if (!(await repo.remove(id))) throw new NotFoundError(`${label} not found`);
    await writeAudit(hooks.audit, ctx, {
      action: "delete",
      entity: label,
      entityId: id,
      before,
    });
    return noContent();
  }),
];

const fieldInput = (body: Body): FieldCreate => ({
  name: body.string("name"),
  area: body.number("area", { min: 0, max: 1_000_000 }),
  trees: body.integer("trees", { min: 0, max: 10_000_000 }),
  variety: body.string("variety"),
  location: body.string("location"),
  soil: body.enum("soil", SOIL_TYPES, "Clay-loam"),
  irrigation: body.enum("irrigation", IRRIGATION_TYPES, "Drip"),
  notes: body.optionalString("notes") ?? "",
});

const employeeInput = (body: Body) => ({
  name: body.string("name"),
  role: body.string("role"),
  phone: body.optionalString("phone") ?? "",
  email: body.nullableString("email"),
  notes: body.nullableString("notes"),
});

const harvestInput = (body: Body): HarvestCreate => ({
  year: body.integer("year", { min: 1900, max: 2100 }),
  name: body.string("name"),
  status: body.enum("status", HARVEST_STATUSES, "Completed"),
  startDate: body.date("startDate"),
  endDate: body.optionalDate("endDate"),
  notes: body.optionalString("notes") ?? "",
  weather: body.optionalString("weather") ?? "",
});

const harvestDayInput = (body: Body): HarvestDayCreate => ({
  harvestId: body.integer("harvestId", { min: 1, max: 1_000_000_000 }),
  date: body.date("date"),
  fieldId: body.integer("fieldId", { min: 1, max: 1_000_000_000 }),
  sacks: body.integer("sacks", { min: 0, max: 1_000_000 }),
  workers: body.workerPays("workers"),
  notes: body.optionalString("notes") ?? "",
});

const grindInput = (body: Body): GrindCreate => ({
  harvestId: body.integer("harvestId", { min: 1, max: 1_000_000_000 }),
  date: body.date("date"),
  factoryName: body.string("factoryName"),
  olivesKg: body.integer("olivesKg", { min: 0, max: 100_000_000 }),
  oilProducedL: body.integer("oilProducedL", { min: 0, max: 100_000_000 }),
  taxKeptL: body.optionalNumber("taxKeptL", { min: 0, max: 100_000_000 }) ?? 0,
  acidity: body.optionalNumber("acidity", { min: 0, max: 100 }) ?? 0.3,
  notes: body.optionalString("notes") ?? "",
});

const saleInput = (body: Body): SaleCreate => ({
  harvestId: body.integer("harvestId", { min: 1, max: 1_000_000_000 }),
  date: body.date("date"),
  buyerName: body.string("buyerName"),
  oilL: body.integer("oilL", { min: 0, max: 100_000_000 }),
  pricePerL: body.number("pricePerL", { min: 0, max: 1_000_000 }),
  notes: body.optionalString("notes") ?? "",
});

const expenseInput = (body: Body): ExpenseCreate => ({
  harvestId: body.integer("harvestId", { min: 1, max: 1_000_000_000 }),
  date: body.date("date"),
  category: body.enum("category", EXPENSE_CATEGORIES, "Other"),
  description: body.string("description"),
  amount: body.number("amount", { min: 0, max: 1_000_000_000 }),
});

const pingDatabase = async (db: Db, timeoutMs = 1_500): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      db.command({ ping: 1 }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("database ping timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export const makeRoutes = (deps: AppDeps): Route[] => {
  const { audit } = deps;

  const guardHarvestDelete = async (id: number): Promise<void> => {
    const [days, grinds, sales, expenses] = await Promise.all([
      deps.harvestDays.count({ harvestId: id }),
      deps.grinds.count({ harvestId: id }),
      deps.sales.count({ harvestId: id }),
      deps.expenses.count({ harvestId: id }),
    ]);
    if (days + grinds + sales + expenses > 0) {
      throw new ConflictError(
        `Harvest ${id} still has dependent harvest days, grinds, sales or expenses`,
      );
    }
  };

  const guardFieldDelete = async (id: number): Promise<void> => {
    if ((await deps.harvestDays.count({ fieldId: id })) > 0) {
      throw new ConflictError(`Field ${id} is still referenced by harvest days`);
    }
  };

  const guardEmployeeDelete = async (id: number): Promise<void> => {
    if ((await deps.harvestDays.count({ "workers.employeeId": id })) > 0) {
      throw new ConflictError(`Employee ${id} is still referenced by harvest days`);
    }
  };

  const assertHarvestExists = async (harvestId: number): Promise<void> => {
    await requireRef(await deps.harvests.findById(harvestId), `Harvest ${harvestId}`);
  };

  const assertHarvestDayRefs = async (day: HarvestDayCreate): Promise<void> => {
    await Promise.all([
      assertHarvestExists(day.harvestId),
      requireRef(await deps.fields.findById(day.fieldId), `Field ${day.fieldId}`),
      requireRefs(deps.employees, (day.workers ?? []).map((worker) => worker.employeeId), "Employee"),
    ]);
  };

  const nested = (
    name: "grinds" | "sales" | "expenses",
    find: (harvestId: number) => Promise<unknown>,
  ): Route =>
    route("GET", `${BASE}/harvests/:harvestId/${name}`, async (ctx) =>
      json(await find(parseId(ctx.params.harvestId, "harvestId"))),
    );

  const routes: Route[] = [
    route("GET", `${BASE}/health`, async () => json({ status: "ok" }), "public"),

    route("GET", `${BASE}/ready`, async () => {
      if (!deps.db) return json({ status: "unavailable", database: "unconfigured" }, 503);
      try {
        await pingDatabase(deps.db);
        return json({ status: "ok", database: "up" });
      } catch (error) {
        logger.warn("readiness probe failed", { error });
        return json({ status: "unavailable", database: "down" }, 503);
      }
    }, "public"),

    route("GET", `${BASE}/stats`, async () => json(await deps.stats())),

    route("GET", `${BASE}/expense-rows`, async (ctx) => {
      const query: ExpenseRowsQuery = {};
      const rawHarvestId = ctx.query.get("harvestId");
      if (rawHarvestId !== null) {
        query.harvestId = parseId(rawHarvestId, "harvestId");
      }
      const rawCategory = ctx.query.get("category");
      if (rawCategory !== null && rawCategory !== "") {
        query.category = rawCategory;
      }
      query.pagination = parsePagination(ctx.query);
      return json(await deps.expenseRows(query));
    }),

    route("GET", `${BASE}/metrics`, async () => {
      const render = deps.metrics?.render ?? (() => "");
      return new Response(render(), {
        headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
      });
    }, "owner"),

    route("POST", `${BASE}/auth/login`, async (ctx) => {
      const body = await ctx.body();
      const username = body.string("username");
      const password = body.string("password");
      const throttle = deps.loginThrottle;
      if (!throttle) return json(await deps.auth.login(username, password));

      throttle.beforeAttempt(ctx.ip, username);
      try {
        const response = await deps.auth.login(username, password);
        throttle.reset(ctx.ip, username);
        return json(response);
      } catch (error) {
        if (error instanceof UnauthorizedError) throttle.recordFailure(ctx.ip, username);
        throw error;
      }
    }, "public"),

    route("POST", `${BASE}/auth/logout`, async (ctx) => {
      await deps.auth.logout(ctx.token);
      return noContent();
    }),

    // Public: the caller only has an expired token, so the auth middleware
    // would reject it before the handler could exchange it. The handler
    // validates the body token itself (signature + bounded grace window).
    route("POST", `${BASE}/auth/refresh`, async (ctx) => {
      const body = await ctx.body();
      return json(await deps.auth.refresh(body.string("token")));
    }, "public"),

    route("GET", `${BASE}/users`, async (ctx) =>
      json(await deps.users.listProfiles(parsePagination(ctx.query))),
    ),
    route("POST", `${BASE}/users`, async (ctx) => {
      const body = await ctx.body();
      const username = assertUsernamePolicy(body.string("username"));
      const password = body.string("password");

      // Conflict is checked before the password policy so a duplicate
      // username keeps answering 409 regardless of what it was sent with.
      if (await deps.users.findByUsername(username)) {
        throw new ConflictError(`Username "${username}" already exists`);
      }
      assertPasswordPolicy(password);

      const user = await deps.users.createUser({
        username,
        password: await hashPassword(password),
        name: body.optionalString("name") ?? "",
        role: body.optionalString("role") ?? "",
      });
      await writeAudit(audit, ctx, {
        action: "create",
        entity: "User",
        entityId: user.username,
        after: toUserProfile(user),
      });
      return json(toUserProfile(user), 201);
    }, "owner"),

    route("GET", `${BASE}/users/:username`, async (ctx) =>
      json(await deps.users.getProfile(ctx.params.username ?? "")),
    ),

    route("PUT", `${BASE}/users/:username`, async (ctx) => {
      const caller = requireCaller(ctx);
      const target = normalizeUsername(ctx.params.username ?? "");
      const owner = caller.role === OWNER_ROLE;

      if (!owner && caller.username !== target) {
        throw new ForbiddenError("You may only edit your own profile");
      }

      const body = await ctx.body();
      const updates: Partial<UserCreate> = {};

      const username = body.optionalString("username");
      const password = body.optionalString("password");
      const name = body.optionalString("name");
      const role = body.optionalString("role");

      if (!owner && (username !== undefined || role !== undefined)) {
        throw new ForbiddenError("Only an owner can change usernames or roles");
      }

      if (username !== undefined) updates.username = assertUsernamePolicy(username);
      if (password !== undefined) {
        assertPasswordPolicy(password);
        updates.password = await hashPassword(password);
      }
      if (name !== undefined) updates.name = name;
      if (role !== undefined) updates.role = role;

      const before = await deps.users.getProfile(target);
      const updated = required(await deps.users.updateByUsername(target, updates), "User");
      await writeAudit(audit, ctx, {
        action: "update",
        entity: "User",
        entityId: updated.username,
        before,
        after: toUserProfile(updated),
      });
      return json(toUserProfile(updated));
    }),

    route("DELETE", `${BASE}/users/:username`, async (ctx) => {
      const username = normalizeUsername(ctx.params.username ?? "");
      const before = await deps.users.getProfile(username);
      if (!(await deps.users.deleteByUsername(username))) {
        throw new NotFoundError("User not found");
      }
      await writeAudit(audit, ctx, {
        action: "delete",
        entity: "User",
        entityId: username,
        before,
      });
      return noContent();
    }, "owner"),

    ...crudRoutes(
      "/fields",
      {
        list: (filter, options) => deps.fields.findAll(filter, options),
        create: (body) => deps.fields.createField(fieldInput(body)),
        get: (id) => deps.fields.findById(id),
        update: (id, body) => deps.fields.update(id, fieldInput(body)),
        remove: (id) => deps.fields.delete(id),
      },
      "Field",
      { audit, sort: { name: 1 }, guardDelete: guardFieldDelete },
    ),

    ...crudRoutes(
      "/employees",
      {
        list: (filter, options) => deps.employees.findAll(filter, options),
        create: (body) => deps.employees.createEmployee(employeeInput(body)),
        get: (id) => deps.employees.findById(id),
        update: (id, body) => deps.employees.update(id, employeeInput(body)),
        remove: (id) => deps.employees.delete(id),
      },
      "Employee",
      { audit, sort: { name: 1 }, guardDelete: guardEmployeeDelete },
    ),

    route("GET", `${BASE}/harvests/year/:year`, async (ctx) =>
      json(await deps.harvests.findByYear(parseYear(ctx.params.year))),
    ),

    ...crudRoutes(
      "/harvests",
      {
        list: (filter, options) => deps.harvests.findAll(filter, options),
        create: (body) => deps.harvests.createHarvest(harvestInput(body)),
        get: (id) => deps.harvests.findById(id),
        update: (id, body) => deps.harvests.update(id, harvestInput(body)),
        remove: (id) => deps.harvests.delete(id),
      },
      "Harvest",
      { audit, sort: { year: -1, id: -1 }, guardDelete: guardHarvestDelete },
    ),

    route("GET", `${BASE}/harvests/:harvestId/days`, async (ctx) =>
      json(await deps.harvestDays.findByHarvestId(parseId(ctx.params.harvestId, "harvestId"))),
    ),
    nested("grinds", (harvestId) => deps.grinds.findByHarvestId(harvestId)),
    nested("sales", (harvestId) => deps.sales.findByHarvestId(harvestId)),
    nested("expenses", (harvestId) => deps.expenses.findByHarvestId(harvestId)),

    ...crudRoutes(
      "/harvest-days",
      {
        list: (filter, options) => deps.harvestDays.findAll(filter, options),
        create: async (body) => {
          const input = harvestDayInput(body);
          await assertHarvestDayRefs(input);
          return deps.harvestDays.createHarvestDay(input);
        },
        get: (id) => deps.harvestDays.findById(id),
        update: async (id, body) => {
          const input = harvestDayInput(body);
          await assertHarvestDayRefs(input);
          return deps.harvestDays.update(id, input);
        },
        remove: (id) => deps.harvestDays.delete(id),
      },
      "Harvest day",
      { audit, sort: { date: -1, id: -1 } },
    ),

    ...crudRoutes(
      "/grinds",
      {
        list: (filter, options) => deps.grinds.findAll(filter, options),
        create: async (body) => {
          const input = grindInput(body);
          await assertHarvestExists(input.harvestId);
          return deps.grinds.createGrind(input);
        },
        get: (id) => deps.grinds.findById(id),
        update: async (id, body) => {
          const input = grindInput(body);
          await assertHarvestExists(input.harvestId);
          return deps.grinds.update(id, input);
        },
        remove: (id) => deps.grinds.delete(id),
      },
      "Grind",
      { audit, sort: { date: -1, id: -1 } },
    ),

    ...crudRoutes(
      "/sales",
      {
        list: (filter, options) => deps.sales.findAll(filter, options),
        create: async (body) => {
          const input = saleInput(body);
          await assertHarvestExists(input.harvestId);
          return deps.sales.createSale(input);
        },
        get: (id) => deps.sales.findById(id),
        update: async (id, body) => {
          const input = saleInput(body);
          await assertHarvestExists(input.harvestId);
          return deps.sales.update(id, input);
        },
        remove: (id) => deps.sales.delete(id),
      },
      "Sale",
      { audit, sort: { date: -1, id: -1 } },
    ),

    ...crudRoutes(
      "/expenses",
      {
        list: (filter, options) => deps.expenses.findAll(filter, options),
        create: async (body) => {
          const input = expenseInput(body);
          await assertHarvestExists(input.harvestId);
          return deps.expenses.createExpense(input);
        },
        get: (id) => deps.expenses.findById(id),
        update: async (id, body) => {
          const input = expenseInput(body);
          await assertHarvestExists(input.harvestId);
          return deps.expenses.update(id, input);
        },
        remove: (id) => deps.expenses.delete(id),
      },
      "Expense",
      { audit, sort: { date: -1, id: -1 } },
    ),
  ];

  routes.push(
    route("GET", `${BASE}/openapi.json`, async () => json(buildOpenApi(routes)), "public"),
  );

  return routes;
};

const segmentsOf = (path: string): string[] => path.split("/").filter(Boolean);

/** Total: invalid percent-encoding must never throw out of the matcher. */
const safeDecode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export const matchRoute = (
  method: string,
  pathname: string,
  routes: Route[],
): { route: Route; params: Record<string, string>; } | null => {
  const actual = segmentsOf(pathname);
  let best: { route: Route; params: Record<string, string>; score: number; } | null = null;

  for (const candidate of routes) {
    if (candidate.method !== method) continue;

    const pattern = segmentsOf(candidate.path);
    if (pattern.length !== actual.length) continue;

    const params: Record<string, string> = {};
    let matches = true;

    for (let index = 0; index < pattern.length; index += 1) {
      const expected = pattern[index] ?? "";
      const received = actual[index] ?? "";

      if (expected.startsWith(":")) {
        params[expected.slice(1)] = safeDecode(received);
      } else if (expected !== received) {
        matches = false;
        break;
      }
    }

    if (!matches) continue;

    const score = pattern.filter((segment) => !segment.startsWith(":")).length;
    if (!best || score > best.score) best = { route: candidate, params, score };
  }

  return best ? { route: best.route, params: best.params } : null;
};
