/**
 * API Error Classes
 *
 * Custom error classes for API client error handling.
 */

import { ApiErrorCode, ApiErrorResponse } from "./types.js";

/**
 * Base error class for API-related errors.
 */
export class ApiError extends Error {
  public readonly code: ApiErrorCode;
  public readonly status: number;
  public readonly response?: ApiErrorResponse;

  constructor(
    message: string,
    code: ApiErrorCode,
    status: number,
    response?: ApiErrorResponse
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.response = response;
  }
}

/**
 * Error thrown when authentication fails (401 Unauthorized).
 */
export class UnauthorizedError extends ApiError {
  constructor(message: string = "Authentication required. Please check your GitHub token.", response?: ApiErrorResponse) {
    super(message, "UNAUTHORIZED", 401, response);
    this.name = "UnauthorizedError";
  }
}

/**
 * Error thrown when access is forbidden (403 Forbidden).
 */
export class ForbiddenError extends ApiError {
  constructor(message: string = "Access denied. You do not have permission to perform this action.", response?: ApiErrorResponse) {
    super(message, "FORBIDDEN", 403, response);
    this.name = "ForbiddenError";
  }
}

/**
 * Error thrown when a resource is not found (404 Not Found).
 */
export class NotFoundError extends ApiError {
  constructor(message: string = "The requested resource was not found.", response?: ApiErrorResponse) {
    super(message, "NOT_FOUND", 404, response);
    this.name = "NotFoundError";
  }
}

/**
 * Error thrown when the request is invalid (400 Bad Request).
 */
export class BadRequestError extends ApiError {
  constructor(message: string = "Invalid request.", response?: ApiErrorResponse) {
    super(message, "BAD_REQUEST", 400, response);
    this.name = "BadRequestError";
  }
}

/**
 * Error thrown when the server encounters an error (500+ Internal Server Error).
 */
export class InternalServerError extends ApiError {
  constructor(message: string = "The server encountered an error.", status: number = 500, response?: ApiErrorResponse) {
    super(message, "INTERNAL_ERROR", status, response);
    this.name = "InternalServerError";
  }
}

/**
 * Error thrown when a network error occurs (connection refused, DNS failure, etc).
 */
export class NetworkError extends ApiError {
  constructor(message: string = "Network error. Please check your connection.", originalError?: Error) {
    super(message, "NETWORK_ERROR", 0);
    this.name = "NetworkError";
    if (originalError) {
      this.cause = originalError;
    }
  }
}

/**
 * Error thrown when a request times out.
 */
export class TimeoutError extends ApiError {
  constructor(message: string = "Request timed out.", timeoutMs?: number) {
    const fullMessage = timeoutMs
      ? `${message} (timeout: ${timeoutMs}ms)`
      : message;
    super(fullMessage, "TIMEOUT", 0);
    this.name = "TimeoutError";
  }
}

/**
 * Creates an appropriate ApiError subclass based on the HTTP status code.
 *
 * @param status - The HTTP status code.
 * @param response - The error response body.
 * @returns An ApiError subclass instance.
 */
export function createApiError(status: number, response?: ApiErrorResponse): ApiError {
  const message = response?.error ?? getDefaultErrorMessage(status);

  switch (status) {
    case 400:
      return new BadRequestError(message, response);
    case 401:
      return new UnauthorizedError(message, response);
    case 403:
      return new ForbiddenError(message, response);
    case 404:
      return new NotFoundError(message, response);
    default:
      if (status >= 500) {
        return new InternalServerError(message, status, response);
      }
      return new ApiError(message, "UNKNOWN", status, response);
  }
}

/**
 * Gets a default error message for a given HTTP status code.
 *
 * @param status - The HTTP status code.
 * @returns A default error message.
 */
function getDefaultErrorMessage(status: number): string {
  switch (status) {
    case 400:
      return "Invalid request.";
    case 401:
      return "Authentication required. Please check your GitHub token.";
    case 403:
      return "Access denied. You do not have permission to perform this action.";
    case 404:
      return "The requested resource was not found.";
    case 500:
      return "The server encountered an error.";
    case 502:
      return "Bad gateway. The server is temporarily unavailable.";
    case 503:
      return "Service unavailable. Please try again later.";
    case 504:
      return "Gateway timeout. The server took too long to respond.";
    default:
      if (status >= 500) {
        return "The server encountered an error.";
      }
      return `Request failed with status ${status}.`;
  }
}
