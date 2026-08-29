import { DEMO_MODE_READ_ONLY_CODE, DESKTOP_TRANSPORT_SCOPE_HEADER } from '@propr/shared';
import { ProprClient } from '@propr/client';
import type { DesktopBridge } from '../../../apps/desktop/src/shared/contract';
import { getApiBaseUrl, pathWithActiveHostedTunnelFlow } from '../config/runtimeConfig';
import { currentUiPathname, isDesktopRuntime, navigateToUiPath } from '../config/runtimeMode';
import { DESKTOP_ACCESS_INVALID_EVENT } from '../desktop/types';

export interface DesktopConnectionScope {
  bridge: DesktopBridge;
  profileId: string;
  transportScope: string;
}

let desktopConnectionScope: DesktopConnectionScope | null = null;
const desktopScopeListeners = new Set<() => void>();
const responseScopes = new WeakMap<Response, DesktopConnectionScope | null>();
const DEFINITIVE_INSTANCE_TOKEN_CODES = new Set([
  'INVALID_INSTANCE_TOKEN',
  'INSTANCE_TOKEN_EXPIRED',
  'INSTANCE_TOKEN_REVOKED',
]);
const AUTHORIZATION_CHANGE_CODES = new Set([
  'AUTHORIZATION_CHANGED',
  'USER_NOT_WHITELISTED',
  'INSUFFICIENT_INSTANCE_PERMISSION',
]);

const createProprClient = (baseUrl: string): ProprClient => new ProprClient({
  baseUrl,
  authentication: isDesktopRuntime()
    ? { type: 'none' }
    : { type: 'session', applyByDefault: false },
});

export let API_BASE_URL = getApiBaseUrl();
export let proprClient = createProprClient(API_BASE_URL);

/** Update the live bindings used by existing API modules when desktop profiles switch. */
export const setApiBaseUrl = (value: string): void => {
  const nextApiBaseUrl = value.trim().replace(/\/+$/, '');
  const nextProprClient = createProprClient(nextApiBaseUrl);
  API_BASE_URL = nextApiBaseUrl;
  proprClient = nextProprClient;
  desktopScopeListeners.forEach(listener => listener());
};

export const setDesktopConnectionScope = (
  scope: DesktopConnectionScope | null,
  apiBaseUrl?: string,
): void => {
  const nextApiBaseUrl = apiBaseUrl === undefined ? API_BASE_URL : apiBaseUrl.trim().replace(/\/+$/, '');
  const nextProprClient = createProprClient(nextApiBaseUrl);
  API_BASE_URL = nextApiBaseUrl;
  desktopConnectionScope = scope;
  proprClient = nextProprClient;
  desktopScopeListeners.forEach(listener => listener());
};

export const getDesktopConnectionScope = (): DesktopConnectionScope | null => desktopConnectionScope;
export const subscribeDesktopConnectionScope = (listener: () => void): (() => void) => {
  desktopScopeListeners.add(listener);
  return () => desktopScopeListeners.delete(listener);
};
export const getDesktopSocketConfigurationKey = (): string => {
  const scope = desktopConnectionScope;
  return `${isDesktopRuntime() ? 'desktop' : 'browser'}\u0000${API_BASE_URL}\u0000${scope?.profileId ?? ''}\u0000${scope?.transportScope ?? ''}`;
};
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

const isCurrentDesktopScope = (scope: DesktopConnectionScope | null): boolean => {
  if (!scope) return !isDesktopRuntime();
  return desktopConnectionScope?.profileId === scope.profileId
    && desktopConnectionScope.transportScope === scope.transportScope;
};

const scopeForResponse = (response: Response): DesktopConnectionScope | null =>
  responseScopes.has(response) ? responseScopes.get(response) ?? null : desktopConnectionScope;

export const handleDesktopAccessCode = async (
  code: string | undefined,
  scope: DesktopConnectionScope | null,
): Promise<'invalidated' | 'authorization-changed' | 'retryable'> => {
  if (!code) return 'retryable';
  if (AUTHORIZATION_CHANGE_CODES.has(code)) {
    if (!isCurrentDesktopScope(scope)) return 'retryable';
    window.dispatchEvent(new Event(INSTANCE_AUTHORIZATION_CHANGED_EVENT));
    return 'authorization-changed';
  }
  if (!scope) return 'retryable';
  if (DEFINITIVE_INSTANCE_TOKEN_CODES.has(code)) {
    const result = await scope.bridge.connection.invalidate({
      profileId: scope.profileId,
      transportScope: scope.transportScope,
      code,
    });
    if (result.invalidated && isCurrentDesktopScope(scope)) {
      window.dispatchEvent(new CustomEvent(DESKTOP_ACCESS_INVALID_EVENT, {
        detail: {
          profileId: scope.profileId,
          transportScope: scope.transportScope,
          code,
        },
      }));
      return 'invalidated';
    }
    return 'retryable';
  }
  return 'retryable';
};

const throwUnauthorizedResponse = async (data: ApiErrorBody | null, response: Response): Promise<never> => {
  if (data?.code === TOKEN_REFRESHED_CODE) {
    throw new TokenRefreshRetryRequiredError(getApiErrorMessage(data));
  }
  if (isDesktopRuntime()) {
    await handleDesktopAccessCode(data?.code, scopeForResponse(response));
    throw new Error(data?.code === 'INVALID_INSTANCE_TOKEN'
      ? 'This desktop connection was revoked or expired.'
      : 'Desktop authentication is required.');
  }
  if (currentUiPathname() === '/login') throw new Error('Authentication required');
  // Preserve only the validated active flow so login/OAuth cannot be driven by
  // arbitrary raw URL input or copied sessionStorage.
  navigateToUiPath(pathWithActiveHostedTunnelFlow('/login'));
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
  return options.replayMutationAfterTokenRefresh === true
    && (init?.body == null || typeof init.body === 'string');
};

const scopedRequestInit = (
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  scope: DesktopConnectionScope | null,
): RequestInit | undefined => {
  if (!scope) return init;
  const headers = new Headers(typeof Request !== 'undefined' && input instanceof Request
    ? input.headers
    : undefined);
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
  headers.set(DESKTOP_TRANSPORT_SCOPE_HEADER, scope.transportScope);
  return { ...init, headers };
};

export const apiFetch = async (
  input: RequestInfo | URL,
  init?: RequestInit,
  options: ApiFetchOptions = {}
): Promise<Response> => {
  const requestScope = desktopConnectionScope;
  const requestClient = proprClient;
  const requestInit = scopedRequestInit(input, init, requestScope);
  const response = await requestClient.fetch(input, requestInit);
  responseScopes.set(response, requestScope);
  if (isReplayableApiRequest(input, init, options)
    && await shouldRetryAfterTokenRefresh(response)
    && isCurrentDesktopScope(requestScope)) {
    const retried = await requestClient.fetch(input, requestInit);
    responseScopes.set(retried, requestScope);
    return retried;
  }
  return response;
};

export const handleApiResponse = async (response: Response): Promise<Response> => {
  if (response.ok) return response;

  const data = await parseApiErrorBody(response);
  if (response.status === 401) return await throwUnauthorizedResponse(data, response);
  const errorMessage = getApiErrorMessage(data);

  if (data?.code === DEMO_MODE_READ_ONLY_CODE) {
    throw new DemoModeReadOnlyError(errorMessage);
  }
  if (data?.code === 'INSUFFICIENT_INSTANCE_PERMISSION') {
    await handleDesktopAccessCode(data.code, scopeForResponse(response));
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
