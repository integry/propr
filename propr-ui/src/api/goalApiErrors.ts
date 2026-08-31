import { handleApiResponse } from './apiClient';

export class GoalContractError extends Error {
  constructor(path: string, expected: string) {
    super(`Goal API contract mismatch at ${path}: expected ${expected}. Please update the UI and backend together.`);
    this.name = 'GoalContractError';
  }
}

export class GoalMutationUncertainError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'The mutation response could not be decoded.');
    this.name = 'GoalMutationUncertainError';
    this.cause = cause;
  }
}

export class GoalApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = 'GoalApiError';
    this.code = code;
    this.status = status;
  }
}

export const isGoalApiErrorCode = (error: unknown, code: string): boolean =>
  error instanceof GoalApiError && error.code === code;

interface GoalErrorResponse {
  code?: unknown;
  error?: unknown;
  message?: unknown;
}

export const handleGoalResponse = async (response: Response): Promise<Response> => {
  if (response.ok) return response;
  let body: GoalErrorResponse | null = null;
  try {
    body = await response.clone().json() as GoalErrorResponse;
  } catch {
    // The status and shared response handler still provide a safe fallback.
  }
  const suppliedCode = typeof body?.code === 'string' && body.code.startsWith('goal_') ? body.code : null;
  const code = suppliedCode
    ?? (response.status === 403 ? 'goal_access_denied'
      : response.status === 404 ? 'goal_not_found' : null);
  if (code?.startsWith('goal_')) {
    const message = typeof body?.error === 'string'
      ? body.error
      : typeof body?.message === 'string' ? body.message : `Goal request failed (${code})`;
    throw new GoalApiError(code, response.status, message);
  }
  return handleApiResponse(response);
};
