import { describe, expect, test } from "bun:test";
import { matchRoute, type Route } from "./index.js";

const route = (method: Route["method"], path: string): Route => ({
  method,
  path,
  access: "authenticated",
  handler: async () => new Response(null),
});

const routes: Route[] = [
  route("GET", "/api/v1/health"),
  route("GET", "/api/v1/harvests/year/:year"),
  route("GET", "/api/v1/harvests/:id"),
  route("GET", "/api/v1/harvests/:harvestId/days"),
  route("GET", "/api/v1/harvests/:harvestId/grinds"),
  route("POST", "/api/v1/harvests"),
];

const matched = (method: string, path: string) => matchRoute(method, path, routes);

describe("matchRoute", () => {
  test("matches a literal route", () => {
    expect(matched("GET", "/api/v1/health")?.route.path).toBe("/api/v1/health");
  });

  test("prefers static segments over params", () => {
    const result = matched("GET", "/api/v1/harvests/year/2024");
    expect(result?.route.path).toBe("/api/v1/harvests/year/:year");
    expect(result?.params).toEqual({ year: "2024" });
  });

  test("falls back to the id param for numeric segments", () => {
    const result = matched("GET", "/api/v1/harvests/12");
    expect(result?.route.path).toBe("/api/v1/harvests/:id");
    expect(result?.params).toEqual({ id: "12" });
  });

  test("matches nested harvest sub-resources", () => {
    expect(matched("GET", "/api/v1/harvests/7/days")?.route.path).toBe(
      "/api/v1/harvests/:harvestId/days",
    );
    expect(matched("GET", "/api/v1/harvests/7/grinds")?.route.path).toBe(
      "/api/v1/harvests/:harvestId/grinds",
    );
  });

  test("decodes encoded params", () => {
    expect(matched("GET", "/api/v1/harvests/7/days")?.params).toEqual({ harvestId: "7" });
  });

  test("returns null on method mismatch", () => {
    expect(matched("DELETE", "/api/v1/harvests/year/2024")).toBeNull();
  });

  test("returns null when segment count differs", () => {
    expect(matched("GET", "/api/v1/harvests")).toBeNull();
    expect(matched("GET", "/api/v1/harvests/7/days/extra")).toBeNull();
  });

  test("does not match a different prefix", () => {
    expect(matched("GET", "/api/v2/health")).toBeNull();
  });
});
