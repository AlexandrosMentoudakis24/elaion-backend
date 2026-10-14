export class AppError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = new.target.name;
    this.status = status;
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 400);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string) {
    super(message, 401);
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string) {
    super(message, 403);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super(message, 404);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409);
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message: string) {
    super(message, 413);
  }
}

export class UnsupportedMediaTypeError extends AppError {
  constructor(message: string) {
    super(message, 415);
  }
}

export class TooManyRequestsError extends AppError {
  readonly retryAfterSeconds: number;

  constructor(message: string, retryAfterSeconds: number) {
    super(message, 429);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message: string) {
    super(message, 503);
  }
}