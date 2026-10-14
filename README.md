# Elaion API

Backend for the Elaion olive-farm mobile application. Built with **Bun** and **MongoDB**, implementing the contract in
`mobile_application/lib/docs/api.md`.

## Stack

| Concern          | Choice                                      |
| ---------------- | ------------------------------------------- |
| Runtime / server | Bun (`Bun.serve`)                           |
| Database         | MongoDB (official `mongodb` driver)         |
| Auth             | JWT bearer tokens (`jose`), HS256           |
| Password hashing | `Bun.password` (argon2id)                   |
| Validation       | Hand-written validators (`src/services/validation.ts`) |

## Project layout

```
src/
  app.ts                    # Builds the fetch handler from repositories + routes
  index.ts                  # Entrypoint: config, Mongo connection, Bun.serve
  http.ts                   # JSON/204/error response helpers
  errors/app-errors.ts      # AppError hierarchy mapped to HTTP status codes
  config/
    env.ts                  # Environment configuration
    database.ts             # Mongo connection lifecycle
  models/index.ts           # Domain types, enums and collection names
  repositories/             # MongoDB data access (base + per-entity)
  routes/index.ts           # Route table + path matcher
  services/
    auth.service.ts         # Login/refresh, JWT issue + verify, password hashing
    validation.ts           # Request body + path-param validation
  scripts/
    migrate.ts              # Idempotent collection + index creation
    seed.ts                 # Sample data (admin / olive123)
```

## Getting started

### 1. Prerequisites

- [Bun](https://bun.sh) >= 1.4
- A running MongoDB instance (local or Atlas)

### 2. Install

```bash
bun install
```

### 3. Configure

```bash
cp .env.example .env
```

| Variable          | Default                     | Notes                          |
| ----------------- | --------------------------- | ------------------------------ |
| `PORT`            | `8080`                      | The mobile contract expects 8080 |
| `MONGODB_URI`     | `mongodb://localhost:27017` |                                |
| `MONGODB_DB_NAME` | `elaion`                    |                                |
| `JWT_SECRET`      | —                           | Required, minimum 8 characters |
| `JWT_TTL_SECONDS` | `604800`                    |                                |
| `JWT_ISSUER`      | `elaion-api`                |                                |
| `JWT_AUDIENCE`    | `elaion-mobile`             |                                |
| `CORS_ORIGIN`     | `*`                         |                                |

### 4. Migrate and seed

```bash
bun run db:migrate   # idempotent: creates collections and indexes
bun run seed         # wipes the collections and inserts sample data
```

### 5. Run

```bash
bun run dev          # watch mode
bun run start        # production
bun test             # unit + MongoDB integration tests
bun run typecheck    # tsc --noEmit
```

The server listens on `http://localhost:8080/api/v1`.

## API

Login with `admin` / `olive123` after seeding. Every route except `/auth/login` and `/health`
requires `Authorization: Bearer <token>`.

| Resource     | Routes                                                                                  |
| ------------ | -------------------------------------------------------------------------------------- |
| Auth         | `POST /auth/login`, `POST /auth/logout`, `POST /auth/refresh`                          |
| Users        | `GET/POST /users`, `GET/PUT/DELETE /users/{username}`                                   |
| Fields       | `GET/POST /fields`, `GET/PUT/DELETE /fields/{id}`                                       |
| Employees    | `GET/POST /employees`, `GET/PUT/DELETE /employees/{id}`                                 |
| Harvests     | `GET/POST /harvests`, `GET/PUT/DELETE /harvests/{id}`, `GET /harvests/year/{year}`      |
| Harvest days | `GET/POST /harvest-days`, `GET/PUT/DELETE /harvest-days/{id}`, `GET /harvests/{id}/days` |
| Grinds       | `GET/POST /grinds`, `GET/PUT/DELETE /grinds/{id}`, `GET /harvests/{id}/grinds`          |
| Sales        | `GET/POST /sales`, `GET/PUT/DELETE /sales/{id}`, `GET /harvests/{id}/sales`             |
| Expenses     | `GET/POST /expenses`, `GET/PUT/DELETE /expenses/{id}`, `GET /harvests/{id}/expenses`    |

Non-2xx responses use `{ "error": string, "status": number }` with statuses `400`, `401`, `404`, `409`, `500`.

## Notes on the MongoDB mapping

- The API contract requires **auto-increment integer IDs**. MongoDB has no native sequence, so a `counters`
  collection is incremented atomically via `findOneAndUpdate({ $inc: { value: 1 } }, { upsert: true })`.
- The internal `_id` (ObjectId) is never exposed; repositories strip it from every response.
- Entities use unique indexes on `id`, and `users` is keyed by a unique `username`.
- Passwords are hashed with argon2id on write and never returned. `verifyPassword` also accepts legacy
  plaintext values so existing rows keep working until reseeded.
