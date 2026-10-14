import { errorResponse, json } from "./http.js";
import {
  makeRoutes,
  matchRoute,
  OWNER_ROLE,
  type AppDeps,
  type Route,
  type RouteContext,
} from "./routes/index.js";
import {
  ForbiddenError,
  PayloadTooLargeError,
  UnauthorizedError,
  UnsupportedMediaTypeError,
  ValidationError,
} from "./errors/app-errors.js";
import { Body } from "./services/validation.js";
import { bearerToken } from "./services/auth.service.js";
import { logger, type Logger } from "./logging.js";
import { makeMetrics, type Metrics } from "./observability/metrics.js";
import {
  idempotencyHash,
  makeIdempotencyStore,
  type IdempotencyStore,
} from "./security/idempotency.js";

export interface App {
  fetch: (request: Request) => Promise<Response>;
  /** Resolves once no request is in flight (or the timeout elapses). */
  drain(timeoutMs?: number): Promise<void>;
}

export interface CreateAppOptions {
  corsOrigin?: string;
  clientIp?: (request: Request) => string;
  maxRequestBodyBytes?: number;
  logger?: Logger;
  metrics?: Metrics;
  idempotency?: IdempotencyStore;
  requestId?: () => string;
}

interface RequestMeta {
  route: string;
  actor: string | null;
}

const BODY_METHODS = new Set(["POST", "PUT", "DELETE"]);

const defaultClientIp = (request: Request): string => {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return "local";
};

const readBody = async (request: Request): Promise<Body> => {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new ValidationError("Request body must be valid JSON");
  }
  return new Body(raw);
};

const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

export const createApp = (deps: AppDeps, options: CreateAppOptions = {}): App => {
  const routes = makeRoutes(deps);
  const corsOrigin = options.corsOrigin ?? "*";
  const log = options.logger ?? logger;
  const metrics = options.metrics ?? deps.metrics ?? makeMetrics();
  const idempotency =
    options.idempotency ?? (deps.db ? makeIdempotencyStore(deps.db) : undefined);
  const clientIp = options.clientIp ?? defaultClientIp;
  const maxRequestBodyBytes = options.maxRequestBodyBytes ?? 64 * 1024;
  const newRequestId = options.requestId ?? (() => crypto.randomUUID());

  let inFlight = 0;

  const corsHeaders = (): Record<string, string> => ({
    "access-control-allow-origin": corsOrigin,
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,authorization,idempotency-key,if-none-match",
    "access-control-max-age": "86400",
    ...(corsOrigin === "*" ? {} : { vary: "Origin" }),
  });

  const harden = (response: Response, requestId: string): Response => {
    const headers = new Headers(response.headers);
    headers.set("x-content-type-options", "nosniff");
    headers.set("x-frame-options", "DENY");
    headers.set("referrer-policy", "no-referrer");
    headers.set("x-request-id", requestId);
    if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
    for (const [key, value] of Object.entries(corsHeaders())) headers.set(key, value);

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };

  /** Weak content hash on reads so mobile clients can revalidate cheaply. */
  const applyEtag = async (request: Request, response: Response): Promise<Response> => {
    if (request.method !== "GET" || response.status !== 200) return response;

    const text = await response.clone().text();
    const etag = `W/"${await sha256Hex(text)}"`;
    const ifNoneMatch = request.headers.get("if-none-match");

    if (ifNoneMatch && ifNoneMatch.split(",").some((value) => value.trim() === etag)) {
      const headers = new Headers(response.headers);
      headers.set("etag", etag);
      return new Response(null, { status: 304, headers });
    }

    const headers = new Headers(response.headers);
    headers.set("etag", etag);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };

  const authenticate = async (
    matched: { route: Route; },
    token: string | null,
    meta: RequestMeta,
  ): Promise<RouteContext["caller"]> => {
    if (matched.route.access === "public") return null;

    if (token === null) throw new UnauthorizedError("Missing or invalid token");
    const payload = await deps.auth.verifyToken(token);
    if (payload === null) throw new UnauthorizedError("Invalid or expired token");

    const caller = { username: payload.sub, role: payload.role };
    meta.actor = caller.username;
    if (matched.route.access === "owner" && caller.role !== OWNER_ROLE) {
      throw new ForbiddenError("Owner privileges are required");
    }
    return caller;
  };

  const handle = async (
    request: Request,
    requestId: string,
    matched: { route: Route; params: Record<string, string>; } | null,
    meta: RequestMeta,
  ): Promise<Response> => {
    if (request.method === "OPTIONS") return new Response(null, { status: 204 });

    const url = new URL(request.url);

    if (BODY_METHODS.has(request.method)) {
      const contentType = request.headers.get("content-type");
      if (contentType !== null && !contentType.toLowerCase().includes("application/json")) {
        throw new UnsupportedMediaTypeError("Content-Type must be application/json");
      }
      const declared = Number(request.headers.get("content-length") ?? "0");
      if (Number.isFinite(declared) && declared > maxRequestBodyBytes) {
        throw new PayloadTooLargeError(
          `Request body must be at most ${maxRequestBodyBytes} bytes`,
        );
      }
    }

    if (!matched) return json({ error: "Route not found", status: 404 }, 404);

    const token = bearerToken(request);
    const caller = await authenticate(matched, token, meta);

    const ctx: RouteContext = {
      request,
      params: matched.params,
      username: caller?.username ?? null,
      caller,
      token,
      requestId,
      ip: clientIp(request),
      body: () => readBody(request),
      query: url.searchParams,
    };

    const response = await matched.route.handler(ctx);

    if (idempotency && request.method === "POST") {
      const key = request.headers.get("idempotency-key");
      if (key !== null) {
        const hash = await idempotencyHash(request.method, url.pathname, key);
        const stored = await idempotency.find(hash);
        if (stored) return json(stored.body, stored.status);

        if (response.status >= 200 && response.status < 300) {
          const text = await response.clone().text();
          await idempotency.save(hash, {
            status: response.status,
            body: text === "" ? null : JSON.parse(text),
          });
        }
      }
    }

    return response;
  };

  const fetch = async (request: Request): Promise<Response> => {
    const started = performance.now();
    const requestId = newRequestId();
    const ip = clientIp(request);
    const meta: RequestMeta = { route: "unmatched", actor: null };

    inFlight += 1;
    try {
      let response: Response;
      try {
        const url = new URL(request.url);
        const matched = matchRoute(request.method, url.pathname, routes);
        if (matched) meta.route = matched.route.path;
        response = await handle(request, requestId, matched, meta);
      } catch (error) {
        response = errorResponse(error, requestId);
      }

      response = await applyEtag(request, response);
      response = harden(response, requestId);

      const durationMs = Math.round((performance.now() - started) * 100) / 100;
      metrics.observe(request.method, meta.route, response.status, durationMs);

      const fields = {
        requestId,
        method: request.method,
        route: meta.route,
        status: response.status,
        durationMs,
        ip,
        ...(meta.actor === null ? {} : { actor: meta.actor }),
      };
      if (response.status >= 500) log.error("request failed", fields);
      else if (response.status >= 400) log.warn("request rejected", fields);
      else log.info("request", fields);

      return response;
    } finally {
      inFlight -= 1;
    }
  };

  return {
    fetch,
    drain: async (timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      while (inFlight > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
  };
};
