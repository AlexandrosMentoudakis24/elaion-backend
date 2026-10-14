# Backend — Production Readiness Backlog

Audit of `./src` against the API contract (`mobile_application/lib/docs/api.md`) and
production-grade requirements (security, availability, operability, correctness).

**Verification performed at time of audit:** `bun run typecheck` clean · `bun test` → 89 passing
(unit + live MongoDB integration) · manual HTTP smoke test on port 8080.

**Severity:**

- **P0** — exploitable or availability-breaking; must fix before any production traffic.
- **P1** — production-grade blocker; fix before public exposure.
- **P2** — correctness / scale / maintainability debt; fix soon after launch.
- **P3** — nice-to-have improvements.

---

## P0 — Must fix before production traffic

- [ ] **1. There is no authorization model — only authentication.**
      Every authenticated caller gets full admin power. `ctx.username` is never read by any handler
      (`src/routes/index.ts`), so **any logged-in user can:**
      - `POST /users` and mint an account with `role: "Owner"` (`routes/index.ts:251`)
      - `PUT /users/{username}` and change **any other user's password, role or username** (`routes/index.ts:264`)
      - `DELETE /users/{username}` and delete the owner (`routes/index.ts:284`)

      This is classic broken access control (CWE-639/285). The `role` field exists (`Owner`,
      `Field Supervisor`) but is never enforced anywhere.
      **Fix:** define an authorization policy (at minimum: user-management endpoints are Owner-only,
      a user may only self-edit `name`/`password`), implement it as a reusable guard applied in
      `app.ts` before dispatch, and return `403` (spec lists `403 Forbidden` as a legal status but
      nothing emits it today).

- [ ] **2. Unhandled exception path: malformed URI escapes the error handler.**
      `matchRoute()` is called **outside** the `try` block in `src/app.ts:41`, and it runs
      `decodeURIComponent(received)` (`src/routes/index.ts:417`), which throws on invalid
      percent-encoding. Verified:
      `GET /api/v1/fields/%ZZ` → `URIError` propagates out of `fetch`.
      Consequences: unhandled exception, no CORS headers, HTML/stack-trace error page, no structured log.
      **Fix:** move dispatch inside `try`, and make param decoding total
      (`try { decodeURIComponent(x) } catch { raw }`).

- [ ] **3. Unbounded list queries → memory exhaustion / DoS.**
      - `parsePagination()` returns `undefined` when no `?page`/`?limit` is supplied
        (`src/services/validation.ts:187`, verified), so **the default `GET /fields`, `GET /harvest-days`,
        `GET /expenses`, … return the entire collection with no `limit` at all.**
      - `GET /stats` loads **all** harvest days and grinds on every request
        (`src/services/stats.service.ts:42`).
      - `GET /expense-rows` loads all harvests + all expenses + all harvest days per request
        (`src/services/expense-rows.service.ts:61`).

      A few thousand rows plus one large request is enough to stall the event loop.
      **Fix:** always apply a default limit; push the aggregation into MongoDB (`$group`/`$lookup`)
      instead of `findAll()` + in-memory reduce; keep unpaginated totals behind indexed aggregation.

- [ ] **4. No rate limiting or lockout on `POST /auth/login`.**
      `src/app.ts` has no throttling anywhere. Unlimited credential-stuffing attempts against a
      farm-management app that holds payroll, sales and expense data.
      **Fix:** per-IP and per-username sliding-window limiter (e.g. `Bun.redis` or an in-memory
      token bucket for a single instance), plus exponential backoff/lockout after N failures,
      returning `429`.

- [ ] **5. Refresh can extend a session forever; logout does nothing.**
      - `verifyForRefresh` accepts a token for an extra full TTL (`clockTolerance: ttlSeconds`,
        `src/services/auth.service.ts:65`) and `refresh` then mints a **brand-new token with a full
        TTL** (`:91`). A single leaked token that gets refreshed inside the grace window never expires —
        a permanently sliding session.
      - `logout: async () => {}` (`src/services/auth.service.ts:101`) is a no-op; the spec returns
        `204` but the token remains valid for up to 7 days afterwards.
      - Nothing invalidates tokens on password change or username rename (no `tokenVersion`/denylist).

      **Fix:** rotate refresh tokens with a one-time-use jti denylist, bound total session age
      (`iat`-based maximum), make logout revoke the presented token/`jti`, and bump a per-user
      `tokenVersion` on password change so outstanding tokens die.

- [ ] **6. `JWT_SECRET` entropy floor is 8 characters.**
      `src/config/env.ts` accepts any string ≥ 8 chars as a signing secret. An 8-char HS256 secret is
      brute-forceable.
      **Fix:** require ≥ 32 bytes of high entropy (`openssl rand -hex 64`), reject known sample values,
      and **fail hard in production** instead of falling back to a default.

---

## P1 — Production-grade blockers

- [ ] **7. Referential integrity: deletes cascade nothing.**
      `DELETE /harvests/{id}` removes only the harvest (`routes/index.ts:327`); its harvest days,
      grinds, sales and expenses become orphans and are still returned by
      `GET /harvests/{id}/days|grinds|sales|expenses`. Same for deleting a `Field` referenced by
      harvest days, and an `Employee` referenced by `worker.employeeId`.
      **Fix:** either cascade deletes (delete children in one operation), or block the parent delete
      with `409` when dependents exist. Prefer: block by default, cascade only when explicit.

- [ ] **8. Foreign keys are never validated on write.**
      My own integration test posts `fieldId: 99` to `/harvest-days` and gets `201`. Same for
      `harvestId` on harvest-days/grinds/sales/expenses and `employeeId` in `workers`.
      **Fix:** resolve referenced parents on create/update and return `400`/`404` if missing.

- [ ] **9. No request body size limit or content-type enforcement.**
      `readBody` (`src/app.ts:7`) accepts any payload; `Bun.serve`'s default `maxRequestBodySize` is
      ~128 MiB. A single request can pin the process.
      **Fix:** set `maxRequestBodySize` to a small sane value (e.g. 64–256 KiB), reject
      `content-type` other than `application/json` with `415`, and cap nested array length
      (`workers` can be arbitrarily long).

- [ ] **10. No numeric bounds validation.**
      `Body.integer()`/`Body.number()` (`src/services/validation.ts`) only check the *type*, so
      `sacks: -5`, `trees: -1`, `pay: -100`, `amount: -9999.99`, `acidity: 1e9`, `year: 0`
      are all accepted and persisted.
      **Fix:** add `min`/`max` guards for every quantity, price, count and date-bearing year;
      reject negatives where the domain forbids them.

- [ ] **11. Password hashing blocks the event loop; legacy plaintext path remains.**
      - `Bun.password.hashSync(...)` (`src/services/auth.service.ts:9`) is synchronous and CPU-heavy;
        `POST /users` and `PUT /users` hash inline on the request thread.
      - Default argon2id parameters are used — no explicit OWASP-recommended `memoryCost`/`timeCost`/`parallelism`.
      - `verifyPassword` falls back to `plain === stored` (`:19`), permanently keeping a plaintext
        credential path alive.

      **Fix:** use `await Bun.password.hash(...)`, set explicit argon2id parameters, run a one-shot
      migration to re-hash legacy plaintext rows, then delete the fallback branch.

- [ ] **12. Login timing oracle.**
      `if (!user || !verifyPassword(...))` (`auth.service.ts:85`) short-circuits when the user is
      absent, so response time reveals which usernames exist.
      **Fix:** always run a dummy verification against a fixed hash when the lookup misses.

- [ ] **13. Secrets and environment hygiene.**
      `.env` contains a live Atlas credential (`mongodb+srv://th3mental1stgr24_db_user:…@financial-dashboard…`)
      in plaintext. It is gitignored, but it belongs to a cluster named for another project and the
      repo directory holds it at rest.
      **Fix:** rotate that password; provision a dedicated Elaion database/user; inject secrets from
      the platform (secret manager / task role), not a file in the working tree; document rotation.

- [ ] **14. Seed script can wipe production data.**
      `src/scripts/seed.ts` runs `deleteMany({})` across every collection with no guard, and reads the
      same `.env` as the server — so `bun run seed` against the production Atlas URI erases real data.
      **Fix:** refuse to run when `NODE_ENV=production` (or require an explicit `--force`), require an
      explicit `--db` target, and split "dev fixtures" from "bootstrap an admin".

- [ ] **15. Startup/shutdown resilience.**
      - `server.stop(true)` force-closes connections then `process.exit(0)` (`src/index.ts`) — no
        draining of in-flight requests, no timeout guard.
      - No `unhandledRejection` / `uncaughtException` handlers.
      - `Bun.serve` has no `error` callback, so any failure outside the request `try` returns Bun's
        default non-JSON response.

      **Fix:** drain gracefully with a hard timeout, register process-level handlers, add a
      `fetch`/`error` safety net that always returns the documented `{ error, status }` JSON shape.

- [ ] **16. `/health` is a static string — not a health check.**
      `GET /health` returns `{"status":"ok"}` (`routes/index.ts:198`) even when MongoDB is unreachable,
      so orchestrator probes will route traffic to a broken instance.
      **Fix:** split into liveness (`/health`) and readiness (`/ready`) that runs
      `await db.command({ ping: 1 })` with a short timeout; return `503` on failure.

- [ ] **17. Observability: `console.log` only.**
      There is no structured logging, no request IDs, no request duration, no error tracking, and
      `console.error(error)` (`src/http.ts:12`) dumps raw errors (potentially containing request data)
      to stdout.
      **Fix:** structured JSON logs with a per-request correlation ID, log level from config,
      redact body/token fields, add latency + status metrics, and hook up an error tracker.

- [ ] **18. No security headers / cache policy.**
      Responses carry no `X-Content-Type-Options: nosniff`, no HSTS (if TLS is terminated in-app),
      no `Cache-Control: no-store` on token responses, and `CORS_ORIGIN` defaults to `*`
      (`src/config/env.ts`).
      **Fix:** set global headers in `app.ts`, default CORS to an explicit origin allowlist, and
      return `Vary: Origin`.

- [ ] **19. Migration tooling has no versioning or schema enforcement.**
      `src/scripts/migrate.ts` only creates collections and indexes: no `schema_migrations` record,
      no ordering/rollback for future data migrations, and no `$jsonSchema` collection validators, so
      the database will accept structurally invalid documents (nulls in required fields, wrong types).
      **Fix:** add a versioned migrations table, run ordered migrations, and attach `$jsonSchema`
      validators with `validationLevel: "moderate"`.

- [ ] **20. Tests are not hermetic.**
      `src/api.test.ts` connects to a **real shared Atlas database** (`elaion-api-test`) and calls
      `dropDatabase()`. CI therefore needs network access and production-grade credentials, and a
      mis-set env var could drop a real database. There is also no CI workflow, no lint, no formatter,
      and no dependency audit.
      **Fix:** run the integration suite against `mongodb-memory-server` (or a service container),
      hard-fail if the test database name is missing or equals the production DB name, add a CI
      pipeline running `typecheck` + `test` + `bun audit` + lint/format, and add a `Dockerfile`.

---

## P2 — Correctness, scale, maintainability

- [ ] **21. `counters` upsert race.** `findOneAndUpdate({ _id }, { $inc }, { upsert: true })`
      (`src/repositories/base.repository.ts:22`) can throw `E11000` when two requests create the first
      ID for a collection concurrently. **Fix:** catch duplicate-key and retry once. Also note IDs are
      consumed even if the subsequent `insertOne` fails, so IDs can have gaps (document or avoid).

- [ ] **22. Deep pagination is O(skip).** `page/limit` → `skip` (`validation.ts:198`) degrades
      as pages grow. **Fix:** switch to cursor/`_id`-based pagination for large collections; keep
      `page` only where the client needs it.

- [ ] **23. N×M work in `expense-rows`.** `harvestList.find(...)` runs inside `.map()` over every
      expense (`expense-rows.service.ts:70`) → O(expenses × harvests), repeated for every row.
      **Fix:** build a `Map` once, or aggregate with `$lookup` server-side.

- [ ] **24. The `stats`/`expense-rows` doc comments are misleading.** `stats.service.ts:33` claims
      callers avoid "downloading those collections in full", yet `findAll()` does exactly that;
      `expense-rows.service.ts:48` similarly. **Fix:** correct the comments once the aggregation is
      server-side.

- [ ] **25. Token `sub` is a mutable username.** Renaming a user silently invalidates their tokens
      (refresh resolves `sub` → `404`) and frees the old username for a new account, which could be
      pre-registered by an attacker. **Fix:** use the immutable `id` as `sub` and look up by ID.

- [ ] **26. Enum values are silently defaulted.** `Body.enum()` (`validation.ts:88`) falls back to
      the default for unknown input rather than returning `400`, so typos are silently persisted as
      a different category. **Fix:** decide explicitly — strict `400` for clients, or lenient only for
      a documented legacy alias set — and log when an unknown value is coerced.

- [ ] **27. `POST /users` has no password policy.** Any non-empty string is accepted; usernames are
      case-sensitive and unnormalized (`Admin` ≠ `admin`). **Fix:** minimum length/complexity,
      normalized username (lowercase, trim), and length caps.

- [ ] **28. Contract drift: undocumented endpoints.** `GET /stats` and `GET /expense-rows` are not
      in `api.md`, but the file is the stated source of truth for the mobile client.
      **Fix:** document both (including `page`/`limit` and response shape), or move them behind an
      agreed endpoint set. Note that adding pagination to `GET /users` etc. also changes response
      semantics versus the spec's bare arrays.

- [ ] **29. Dead / redundant code.**
      - `parseBody` (`routes/index.ts:78`) is never used — `app.ts` supplies `ctx.body`.
      - `Body.integerList()` (`validation.ts:116`) has no call sites.
      - `auth.service.ts` imports `UnauthorizedError` twice (`:1` and aliased at `:6`).
      - `config/env.ts` exports an `AppConfig` interface that duplicates the returned object shape.

- [ ] **30. No audit trail.** No record of who created/updated/deleted a resource, or when a
      password/role changed — important for payroll, sales and expense data. **Fix:** write an
      `audit_logs` collection (actor, action, entity, before/after diff, timestamp, request ID).

- [ ] **31. No mutation idempotency.** Retried `POST`s (mobile flaky networks) allocate new IDs
      and duplicate rows. **Fix:** support an `Idempotency-Key` header on all `POST` routes.

- [ ] **32. Missing indexes for current query shapes.** Sorts used by lists
      (`{ name: 1 }`, `{ date: -1, id: -1 }`, `{ year: -1, id: -1 }`) have no matching compound
      indexes; only `username`, `id`, `year`, `category`, `harvestId/date`, `name`, `fieldId` exist
      (`migrate.ts`). **Fix:** review `explain()` per endpoint and add compound indexes.

- [ ] **33. MongoDB driver configuration is minimal.** Only `serverSelectionTimeoutMS` and
      `connectTimeoutMS` are set (`src/config/database.ts:18`); no `socketTimeoutMS`,
      `waitQueueTimeoutMS`, explicit `retryWrites`, or write-concern tuning. **Fix:** add timeouts so
      a stuck connection fails the request instead of hanging it.

- [ ] **34. No API documentation endpoint.** There is no OpenAPI spec, so clients regenerate types
      by hand and regressions go unnoticed. **Fix:** emit OpenAPI from the route table and serve it.

- [ ] **35. No metrics or tracing.** No `/metrics`, no latency histograms, no OpenTelemetry.
      **Fix:** expose request count/duration/error-rate by route, plus Mongo operation timings.

---

## P3 — Nice to have

- [ ] **36.** Soft-delete (`deletedAt`) instead of hard `DELETE`, so recoverable business records.
- [ ] **37.** `ETag`/`If-None-Match` on list endpoints for mobile bandwidth.
- [ ] **38.** `Vary: Origin` on CORS responses; currently `withCors` rebuilds each `Response`
          (`app.ts:31`) and drops `statusText`.
- [ ] **39.** Load-test plan (k6/autocannon) with a defined RPS + p95 budget.
- [ ] **40.** Blue/green or rolling deploy notes; document rollback and backup/restore for MongoDB
          (MMS snapshots or `mongodump` cron + periodic restore drill).

---

## Already in good shape

- `bun run typecheck` clean under `strict` + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`.
- 89 tests: validation, router precedence, password/JWT flows, and an integration suite driving the
  real handler against MongoDB.
- Integer auto-increment IDs via an atomic `counters` collection — matches `api.md`.
- Internal Mongo `_id` never leaks into responses (covered by regression tests).
- Idempotent migration (`db:migrate` verified twice).
- Error shape `{ error, status }` with statuses `400/401/404/409/500` consistent across the API.
- argon2id password hashing, JWT verified with issuer + audience, `.env` gitignored, no `any` in
  production sources.

---

## Suggested order

1. **Authorization** (#1) and **the crash path** (#2) — both are exploitable today.
2. **Availability**: rate limiting (#4), query limits (#3), body limits (#9), health (#16).
3. **Session security**: refresh/logout/token invalidation (#5) + secret strength (#6).
4. **Data integrity**: cascade rules (#7) and FK validation (#8).
5. **Operability**: structured logging (#17), graceful shutdown (#15), CI + hermetic tests (#20),
   secret rotation (#13), production-guarded seed (#14).
6. Work down P2 in order of risk to real farm data.
