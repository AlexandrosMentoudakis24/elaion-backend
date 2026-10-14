import type { Route } from "./routes/index.js";

const BASE = "/api/v1";

const errorResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
});

const STATUS_RESPONSES: Record<string, { description: string }> = {
  "400": { description: "Validation error" },
  "401": { description: "Missing or invalid token" },
  "403": { description: "Insufficient privileges" },
  "404": { description: "Not found" },
  "409": { description: "Conflict" },
  "429": { description: "Rate limited" },
  "500": { description: "Internal server error" },
};

/**
 * OpenAPI 3 document generated from the live route table so the spec cannot
 * drift from the implementation. Response bodies are described loosely; the
 * machine-readable contract for the mobile client lives in
 * `mobile_application/lib/docs/api.md`.
 */
export const buildOpenApi = (routes: Route[]): Record<string, unknown> => {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const target of routes) {
    const path = target.path.startsWith(BASE)
      ? target.path.slice(BASE.length) || "/"
      : target.path;

    const openApiPath = path.replace(/:(\w+)/g, "{$1}");
    const parameters = [...path.matchAll(/:(\w+)/g)].map((match) => ({
      name: match[1],
      in: "path",
      required: true,
      schema: { type: "string" },
    }));

    const successStatus =
      target.method === "POST" ? "201" : target.method === "DELETE" ? "204" : "200";

    const responses: Record<string, unknown> = {
      [successStatus]: { description: "Success" },
    };
    for (const [status, description] of Object.entries(STATUS_RESPONSES)) {
      responses[status] = errorResponse(description.description);
    }

    paths[openApiPath] ??= {};
    paths[openApiPath][target.method.toLowerCase()] = {
      summary: `${target.method} ${openApiPath}`,
      tags: [openApiPath.split("/")[1] ?? "misc"],
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(target.access === "public" ? {} : { security: [{ bearerAuth: [] }] }),
      responses,
    };
  }

  return {
    openapi: "3.0.3",
    info: {
      title: "Elaion API",
      version: "1.0.0",
      description:
        "Olive farm management API. Generated from the route table; see GET /api/v1/health for liveness.",
    },
    servers: [{ url: "/api/v1" }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      },
      schemas: {
        Error: {
          type: "object",
          required: ["error", "status"],
          properties: {
            error: { type: "string" },
            status: { type: "integer" },
          },
        },
      },
    },
    paths,
  };
};
