import {
  ApiError,
  ForbiddenError,
  NetworkError,
  NotFoundError,
  TimeoutError,
  UnauthorizedError,
} from "../api/errors.js";

export const EXIT_CODES = {
  success: 0,
  general: 1,
  usage: 2,
  unauthorized: 10,
  forbidden: 11,
  notFound: 12,
  network: 20,
  timeout: 21,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export interface CliErrorPayload {
  success: false;
  error: {
    message: string;
    type: string;
    code?: string;
    status?: number;
    exitCode: ExitCode;
  };
}

export function getExitCode(error: unknown): ExitCode {
  if (error instanceof UnauthorizedError) return EXIT_CODES.unauthorized;
  if (error instanceof ForbiddenError) return EXIT_CODES.forbidden;
  if (error instanceof NotFoundError) return EXIT_CODES.notFound;
  if (error instanceof NetworkError) return EXIT_CODES.network;
  if (error instanceof TimeoutError) return EXIT_CODES.timeout;
  if (error instanceof Error && error.name === "JsonInputError") return EXIT_CODES.usage;
  return EXIT_CODES.general;
}

export function printJsonError(error: unknown, message?: string): void {
  const exitCode = getExitCode(error);
  const payload: CliErrorPayload = {
    success: false,
    error: {
      message: message ?? errorMessage(error),
      type: errorType(error),
      exitCode,
    },
  };

  if (error instanceof ApiError) {
    payload.error.code = error.code;
    payload.error.status = error.status;
  }

  console.log(JSON.stringify(payload, null, 2));
}

export function exitWithError(error: unknown): never {
  process.exit(getExitCode(error));
}

export function exitWithUsageError(json: boolean, message: string, details?: Record<string, unknown>): never {
  if (json) {
    console.log(JSON.stringify({
      success: false,
      error: {
        message,
        type: "UsageError",
        code: "USAGE",
        exitCode: EXIT_CODES.usage,
        ...details,
      },
    }, null, 2));
  } else {
    console.error(`Error: ${message}`);
  }
  process.exit(EXIT_CODES.usage);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorType(error: unknown): string {
  return error instanceof Error ? error.name : "Error";
}
