import {
  ApiError,
  ForbiddenError,
  UnauthorizedError,
} from "../api/errors.js";

export const LOGIN_REQUIRED_ERROR =
  "Error: Unauthorized. Please run 'propr login' first.";

export type CliApiErrorKind =
  | "unauthorized"
  | "forbidden"
  | "api"
  | "other";

export interface CliApiErrorClassification {
  kind: CliApiErrorKind;
  message: string;
  status?: number;
}

export interface PresentApiErrorOptions {
  forbiddenMessage: string;
  fallbackMessage: string | ((message: string) => string);
}

function getStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;

  for (const key of ["status", "statusCode"] as const) {
    const value = (error as Record<string, unknown>)[key];
    if (typeof value === "number") return value;
    if (typeof value === "string" && /^\d{3}$/.test(value)) {
      return Number(value);
    }
  }

  return undefined;
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/**
 * Classifies API failures for CLI presentation. API client error types and
 * explicit status fields take precedence over legacy message inspection.
 */
export function classifyApiError(error: unknown): CliApiErrorClassification {
  const message = getErrorMessage(error);

  if (error instanceof UnauthorizedError) {
    return { kind: "unauthorized", message, status: error.status };
  }
  if (error instanceof ForbiddenError) {
    return { kind: "forbidden", message, status: error.status };
  }

  const status = error instanceof ApiError ? error.status : getStatus(error);
  if (status === 401) return { kind: "unauthorized", message, status };
  if (status === 403) return { kind: "forbidden", message, status };

  // Legacy callers sometimes discard the response status and retain only
  // strings such as "401 Unauthorized" or "HTTP 403: Forbidden".
  if (/\b401\b/.test(message)) {
    return { kind: "unauthorized", message, status: 401 };
  }
  if (/\b403\b/.test(message)) {
    return { kind: "forbidden", message, status: 403 };
  }
  if (/\bunauthori[sz]ed\b|\bauthentication required\b/i.test(message)) {
    return { kind: "unauthorized", message };
  }
  if (/\bforbidden\b|\baccess denied\b/i.test(message)) {
    return { kind: "forbidden", message };
  }

  return {
    kind: error instanceof ApiError ? "api" : "other",
    message,
    status,
  };
}

/** Prints a consistent authentication/authorization error for CLI commands. */
export function presentApiError(
  error: unknown,
  options: PresentApiErrorOptions
): CliApiErrorClassification {
  const classification = classifyApiError(error);

  if (classification.kind === "unauthorized") {
    console.error(LOGIN_REQUIRED_ERROR);
  } else if (classification.kind === "forbidden") {
    console.error(options.forbiddenMessage);
  } else {
    const fallback = options.fallbackMessage;
    console.error(
      typeof fallback === "function"
        ? fallback(classification.message)
        : fallback
    );
  }

  return classification;
}
