import {
  ApiError,
  ForbiddenError,
  NetworkError,
  NotFoundError,
  TimeoutError,
  UnauthorizedError,
} from "../api/errors.js";

export const CLI_EXIT_CODES = {
  general: 1,
  usage: 2,
  unauthorized: 10,
  forbidden: 11,
  notFound: 12,
  network: 13,
  timeout: 14,
} as const;

export type CliExitCode = (typeof CLI_EXIT_CODES)[keyof typeof CLI_EXIT_CODES];

export interface CliErrorPayload {
  success: false;
  error: {
    code: string;
    message: string;
    status?: number;
  };
}

export function getExitCodeForError(error: unknown): CliExitCode {
  if (error instanceof UnauthorizedError) return CLI_EXIT_CODES.unauthorized;
  if (error instanceof ForbiddenError) return CLI_EXIT_CODES.forbidden;
  if (error instanceof NotFoundError) return CLI_EXIT_CODES.notFound;
  if (error instanceof NetworkError) return CLI_EXIT_CODES.network;
  if (error instanceof TimeoutError) return CLI_EXIT_CODES.timeout;
  return CLI_EXIT_CODES.general;
}

export function getErrorCode(error: unknown, fallback = "ERROR"): string {
  if (error instanceof ApiError) return error.code;
  return fallback;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function exitWithError(
  error: unknown,
  options: {
    json?: boolean;
    message?: string;
    exitCode?: CliExitCode;
    code?: string;
  } = {}
): never {
  const exitCode = options.exitCode ?? getExitCodeForError(error);
  if (options.json) {
    const payload: CliErrorPayload = {
      success: false,
      error: {
        code: options.code ?? getErrorCode(error),
        message: options.message ?? errorMessage(error),
      },
    };
    if (error instanceof ApiError && error.status > 0) {
      payload.error.status = error.status;
    }
    console.error(JSON.stringify(payload, null, 2));
  } else if (options.message) {
    console.error(options.message);
  } else {
    console.error(errorMessage(error));
  }
  process.exit(exitCode);
}

export function exitWithUsageError(message: string, json?: boolean, code = "USAGE_ERROR"): never {
  exitWithError(new Error(message), {
    json,
    message: json ? message : `Error: ${message}`,
    exitCode: CLI_EXIT_CODES.usage,
    code,
  });
}
