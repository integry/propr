import { DEMO_MODE_READ_ONLY_CODE } from '@propr/shared';
import { getApiBaseUrl } from '../config/runtimeConfig';

export const API_BASE_URL = getApiBaseUrl();
export const INSTANCE_AUTHORIZATION_CHANGED_EVENT = 'propr:instance-authorization-changed';
const TOKEN_REFRESHED_CODE = 'TOKEN_REFRESHED';
const SAFE_PUBLIC_ERROR_CODES = new Set(['AGENT_VERSION_LOOKUP_UNAVAILABLE']);

export class DemoModeReadOnlyError extends Error {
  readonly code = DEMO_MODE_READ_ONLY_CODE;

  constructor(message = 'Demo mode is read-only. Write and AI execution actions are disabled.') {
    super(message);
    this.name = 'DemoModeReadOnlyError';
  }
}

interface CommittedConfigWriteBody {
  committed: true;
  error?: string;
  warning?: string;
  lock_lost_after_commit?: boolean;
  [key: string]: unknown;
}

interface ApiErrorBody {
  code?: string;
  committed?: boolean;
  error?: string;
  lock_lost_after_commit?: boolean;
  message?: string;
  warning?: string;
  [key: string]: unknown;
}

export class CommittedConfigWriteError extends Error {
  readonly committed = true;
  readonly status: number;
  readonly warning?: string;
  readonly lockLostAfterCommit: boolean;
  readonly responseBody: CommittedConfigWriteBody;

  constructor(status: number, body: CommittedConfigWriteBody) {
    super(body.warning || body.error || 'Configuration changes were committed, but the request did not complete normally.');
    this.name = 'CommittedConfigWriteError';
    this.status = status;
    this.warning = body.warning;
    this.lockLostAfterCommit = body.lock_lost_after_commit === true;
    this.responseBody = body;
  }
}

export class TokenRefreshRetryRequiredError extends Error {
  readonly code = TOKEN_REFRESHED_CODE;

  constructor(message = 'Your GitHub token was refreshed. Please retry the request.') {
    super(message);
    this.name = 'TokenRefreshRetryRequiredError';
  }
}

export const isCommittedConfigWriteError = (error: unknown): error is CommittedConfigWriteError =>
  error instanceof CommittedConfigWriteError || (
    error instanceof Error
    && 'committed' in error
    && (error as { committed?: unknown }).committed === true
  );

export const isDemoModeReadOnlyError = (error: unknown): error is DemoModeReadOnlyError =>
  error instanceof DemoModeReadOnlyError || (
    error instanceof Error
    && 'code' in error
    && (error as { code?: unknown }).code === DEMO_MODE_READ_ONLY_CODE
  );

const shouldRetryAfterTokenRefresh = async (response: Response): Promise<boolean> => {
  if (response.status !== 401) return false;
  try {
    const data = await response.clone().json() as { code?: string };
    return data.code === TOKEN_REFRESHED_CODE;
  } catch {
    return false;
  }
};

const parseApiErrorBody = async (response: Response): Promise<ApiErrorBody | null> => {
  try {
    return await response.clone().json() as ApiErrorBody;
  } catch {
    return null;
  }
};

const getApiErrorMessage = (data: ApiErrorBody | null): string | undefined =>
  data?.message || data?.error;

const throwUnauthorizedResponse = (data: ApiErrorBody | null): never => {
  if (data?.code === TOKEN_REFRESHED_CODE) {
    throw new TokenRefreshRetryRequiredError(getApiErrorMessage(data));
  }
  if (window.location.pathname === '/login') throw new Error('Authentication required');
  window.location.href = '/login';
  throw new Error('Authentication required');
};

const isSafePublicError = (data: ApiErrorBody | null): boolean =>
  typeof data?.code === 'string' && SAFE_PUBLIC_ERROR_CODES.has(data.code);

export interface ApiFetchOptions {
  /** Only enable when the route guarantees TOKEN_REFRESHED is returned before side effects. */
  replayMutationAfterTokenRefresh?: boolean;
}

const isReplayableApiRequest = (
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  options: ApiFetchOptions
): boolean => {
  const method = (init?.method ?? (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (typeof Request !== 'undefined' && input instanceof Request && (input.body || input.bodyUsed)) return false;
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
  return options.replayMutationAfterTokenRefresh === true && typeof init?.body === 'string';
};

export const apiFetch = async (
  input: RequestInfo | URL,
  init?: RequestInit,
  options: ApiFetchOptions = {}
): Promise<Response> => {
  const response = await fetch(input, init);
  if (isReplayableApiRequest(input, init, options) && await shouldRetryAfterTokenRefresh(response)) return fetch(input, init);
  return response;
};

export const handleApiResponse = async (response: Response): Promise<Response> => {
  if (response.ok) return response;

  const data = await parseApiErrorBody(response);
  if (response.status === 401) throwUnauthorizedResponse(data);
  const errorMessage = getApiErrorMessage(data);

  if (data?.code === DEMO_MODE_READ_ONLY_CODE) {
    throw new DemoModeReadOnlyError(errorMessage);
  }
  if (data?.code === 'INSUFFICIENT_INSTANCE_PERMISSION') {
    window.dispatchEvent(new Event(INSTANCE_AUTHORIZATION_CHANGED_EVENT));
  }
  if (data?.committed === true) {
    throw new CommittedConfigWriteError(response.status, {
      ...data,
      committed: true,
    });
  }
  if (isSafePublicError(data) && errorMessage) {
    throw new Error(errorMessage);
  }
  if (response.status < 500 && errorMessage) {
    throw new Error(errorMessage);
  }
  throw new Error(
    response.status >= 500
      ? `The server ran into a problem (HTTP ${response.status}). Please try again in a moment.`
      : `The request could not be completed (HTTP ${response.status}).`
  );
};
