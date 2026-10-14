import { AppError, TooManyRequestsError } from "./errors/app-errors.js";
import { logger } from "./logging.js";

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

export const noContent = (): Response => new Response(null, { status: 204 });

export const errorResponse = (error: unknown, requestId?: string): Response => {
  if (error instanceof AppError) {
    if (error instanceof TooManyRequestsError) {
      return json({ error: error.message, status: error.status }, error.status, {
        "retry-after": String(error.retryAfterSeconds),
      });
    }
    return json({ error: error.message, status: error.status }, error.status);
  }

  logger.error("unhandled error", { requestId, error });
  return json({ error: "Internal server error", status: 500 }, 500);
};
