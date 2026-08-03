import { DEMO_MODE_READ_ONLY_CODE } from '@propr/shared';
import { getApiBaseUrl } from '../config/runtimeConfig';

export const API_BASE_URL = getApiBaseUrl();
export const INSTANCE_AUTHORIZATION_CHANGED_EVENT = 'propr:instance-authorization-changed';

export class DemoModeReadOnlyError extends Error {
  readonly code = DEMO_MODE_READ_ONLY_CODE;

  constructor(message = 'Demo mode is read-only. Write and AI execution actions are disabled.') {
    super(message);
    this.name = 'DemoModeReadOnlyError';
  }
}

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
    return data.code === 'TOKEN_REFRESHED';
  } catch {
    return false;
  }
};

const isReplayableApiRequest = (input: RequestInfo | URL, init?: RequestInit): boolean => {
  const method = (init?.method ?? (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (typeof Request !== 'undefined' && input instanceof Request && (input.body || input.bodyUsed)) return false;
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
};

export const apiFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const response = await fetch(input, init);
  if (isReplayableApiRequest(input, init) && await shouldRetryAfterTokenRefresh(response)) return fetch(input, init);
  return response;
};

export const handleApiResponse = async (response: Response): Promise<Response> => {
  if (response.ok) return response;
  if (response.status === 401) {
    if (window.location.pathname === '/login') throw new Error('Authentication required');
    window.location.href = '/login';
    throw new Error('Authentication required');
  }

  let data: { code?: string; error?: string; message?: string } | null = null;
  try {
    data = await response.clone().json() as { code?: string; error?: string; message?: string };
  } catch { /* Preserve the generic status fallback for malformed error bodies. */ }
  if (data?.code === DEMO_MODE_READ_ONLY_CODE) {
    throw new DemoModeReadOnlyError(data.message || data.error);
  }
  if (data?.code === 'INSUFFICIENT_INSTANCE_PERMISSION') {
    window.dispatchEvent(new Event(INSTANCE_AUTHORIZATION_CHANGED_EVENT));
  }
  if (response.status < 500 && (data?.message || data?.error)) {
    throw new Error(data.message || data.error);
  }
  throw new Error(
    response.status >= 500
      ? `The server ran into a problem (HTTP ${response.status}). Please try again in a moment.`
      : `The request could not be completed (HTTP ${response.status}).`
  );
};
