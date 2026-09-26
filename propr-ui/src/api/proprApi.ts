import { DESKTOP_LOGGED_OUT_EVENT } from '../desktop/types';
import type { Task as ApiTask } from './tasks';
import {
  API_BASE_URL,
  apiFetch,
  getAuthenticatedApiReadScopeGeneration,
  handleApiResponse,
  getDesktopConnectionScope,
  setAuthenticatedApiReadIdentity,
  setDesktopConnectionScope,
  shareInFlightApiRead,
} from './apiClient';
import { isHostedUiOrigin, pathWithActiveHostedTunnelFlow } from '../config/runtimeConfig';
import { isProprProxyUrl } from '@propr/shared';
import {
  reportPackagedAcceptanceCurrentUser,
  type PackagedAcceptanceCurrentUserClassification,
} from '../desktop/packagedAcceptanceCurrentUserValidation';

export * from './apiClient';
export { getSystemStatus } from './systemStatusApi';

export interface DemoModeStatus {
  demoMode: boolean;
}

// Re-export all types for backward compatibility
export * from './proprTypes';

import type {
  TaskAnalysisResponse, QueueStats, GeneratingPlansResponse,
  GetTasksOptions, StopExecutionResponse, DeleteTaskResponse, CurrentUser,
  InstanceCatalogResponse
} from './proprTypes';

export type { UserRepoPreferences } from './userRepoPreferencesApi';

export const getDemoModeStatus = async (): Promise<DemoModeStatus> => {
  const response = await apiFetch(`${API_BASE_URL}/api/auth/demo-mode`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const getQueueStats = async (): Promise<QueueStats> => {
  const [queueResponse, generatingPlansResponse] = await Promise.all([
    apiFetch(`${API_BASE_URL}/api/queue/stats`, { credentials: 'include' }),
    apiFetch(`${API_BASE_URL}/api/stats/generating-plans`, { credentials: 'include' }).catch(() => null)
  ]);
  await handleApiResponse(queueResponse);
  const queueStats: QueueStats = await queueResponse.json();
  let generatingCount = 0;
  if (generatingPlansResponse && generatingPlansResponse.ok) {
    try {
      const generatingPlans: GeneratingPlansResponse = await generatingPlansResponse.json();
      generatingCount = generatingPlans.count || 0;
    } catch { /* ignore */ }
  }
  return { ...queueStats, active: queueStats.active + generatingCount };
};

export interface GetTasksResponse { tasks: ApiTask[]; total?: number; offset?: number; limit?: number; }

const normalizeGetTasksOptions = (
  statusOrOptions: string | GetTasksOptions = 'all',
  limit = 50,
  offset = 0,
  repository = 'all',
  search = '',
): GetTasksOptions => typeof statusOrOptions === 'object'
  ? statusOrOptions
  : { status: statusOrOptions, limit, offset, repository, search };

const getTasksRequest = async (
  options: GetTasksOptions,
  signal?: AbortSignal,
): Promise<GetTasksResponse> => {
  const params = new URLSearchParams({
    status: options.status || 'all', limit: (options.limit ?? 50).toString(),
    offset: (options.offset ?? 0).toString(), repository: options.repository || 'all'
  });
  if (options.search) params.append('search', options.search);
  if (options.forReview) params.append('forReview', 'true');
  if (options.excludeMerged) params.append('excludeMerged', 'true');
  const response = await apiFetch(`${API_BASE_URL}/api/tasks?${params.toString()}`, {
    credentials: 'include',
    ...(signal ? { signal } : {}),
  });
  await handleApiResponse(response);
  return response.json();
};

export const getTasks = (
  statusOrOptions: string | GetTasksOptions = 'all', limit = 50, offset = 0, repository = 'all', search = ''
): Promise<GetTasksResponse> => getTasksRequest(
  normalizeGetTasksOptions(statusOrOptions, limit, offset, repository, search),
);

/** The onboarding existence query is distinct from list and review task reads. */
export const getReadinessTaskExistence = (): Promise<GetTasksResponse> =>
  shareInFlightApiRead('readiness-task-existence', signal =>
    getTasksRequest({ status: 'all', limit: 1, offset: 0, repository: 'all' }, signal));

export const getTaskHistory = async (taskId: string): Promise<unknown> => {
  const response = await apiFetch(`${API_BASE_URL}/api/task/${encodeURIComponent(taskId)}/history`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const getTaskAnalysis = async (taskId: string): Promise<TaskAnalysisResponse> => {
  const response = await apiFetch(`${API_BASE_URL}/api/task/${encodeURIComponent(taskId)}/analysis`, { credentials: 'include' });
  if (response.status === 202) return { analysis: null, message: 'Analysis pending...' };
  await handleApiResponse(response);
  return response.json();
};

export const getTaskLiveDetails = async (taskId: string): Promise<unknown> => {
  const response = await apiFetch(`${API_BASE_URL}/api/task/${encodeURIComponent(taskId)}/live-details`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const getInstanceCatalog = (): Promise<InstanceCatalogResponse> => shareInFlightApiRead('instance-catalog', async signal => {
  const response = await apiFetch(`${API_BASE_URL}/api/instance/catalog`, { credentials: 'include', signal });
  await handleApiResponse(response);
  return response.json();
});

export const fetchPrompt = async (promptPath: string): Promise<string> => {
  const response = await apiFetch(`${API_BASE_URL}${promptPath}`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.text();
};

export const fetchLogFiles = async (logsPath: string): Promise<unknown> => {
  const response = await apiFetch(`${API_BASE_URL}${logsPath}`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const fetchLogFile = async (logFilePath: string): Promise<string> => {
  const response = await apiFetch(`${API_BASE_URL}${logFilePath}`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.text();
};

export const stopTaskExecution = async (taskId: string): Promise<StopExecutionResponse> => {
  const response = await apiFetch(`${API_BASE_URL}/api/task/${encodeURIComponent(taskId)}/stop`, { method: 'POST', credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const deleteTask = async (taskId: string, force?: boolean): Promise<void> => {
  const encodedTaskId = encodeURIComponent(taskId);
  const url = force ? `${API_BASE_URL}/api/tasks/${encodedTaskId}?force=true` : `${API_BASE_URL}/api/tasks/${encodedTaskId}`;
  const response = await apiFetch(url, { method: 'DELETE', credentials: 'include' });
  if (response.status === 204) return;
  if (response.status === 400) {
    const data: DeleteTaskResponse = await response.json();
    throw new Error(data.message || data.error || 'Cannot delete task in active state');
  }
  await handleApiResponse(response);
};

export interface CurrentUserValidationOptions {
  scopeGeneration?: number;
  activeScopePresent?: boolean;
}

const CURRENT_USER_SCOPE_GENERATION_QUERY = 'proprDesktopScopeGeneration';

const isNullableString = (value: unknown): value is string | null => value === null || typeof value === 'string';

export const isCurrentUserResponse = (value: unknown): value is CurrentUser => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const user = value as Partial<CurrentUser>;
  const permissions = new Set(['instance.manage_agents', 'instance.manage_members', 'instance.manage_runtime', 'instance.manage_settings']);
  return typeof user.id === 'string'
    && typeof user.login === 'string'
    && typeof user.username === 'string'
    && typeof user.displayName === 'string'
    && isNullableString(user.email)
    && isNullableString(user.avatarUrl)
    && (user.role === 'admin' || user.role === 'member')
    && Array.isArray(user.permissions)
    && user.permissions.every(permission => permissions.has(permission))
    && ['bootstrap', 'local', 'managed', 'implicit', 'demo'].includes(user.authorizationSource ?? '');
};

const currentUserResponseClassification = async (
  response: Response,
): Promise<PackagedAcceptanceCurrentUserClassification> => {
  if (response.ok) return 'success';
  if (response.status === 403) return 'forbidden';
  if (response.status >= 500) return 'server-error';
  if (response.status !== 401) return 'unauthenticated';
  try {
    const body = await response.clone().json() as { code?: unknown };
    return ['INVALID_INSTANCE_TOKEN', 'INSTANCE_TOKEN_EXPIRED', 'INSTANCE_TOKEN_REVOKED'].includes(String(body.code))
      ? 'revoked'
      : 'unauthenticated';
  } catch {
    return 'unauthenticated';
  }
};

export const getCurrentUser = async (options: CurrentUserValidationOptions = {}): Promise<CurrentUser> => {
  const authenticatedReadScopeGeneration = getAuthenticatedApiReadScopeGeneration();
  const requestedScopeGeneration = options.scopeGeneration;
  const scopeGeneration = typeof requestedScopeGeneration === 'number'
    && Number.isSafeInteger(requestedScopeGeneration) && requestedScopeGeneration >= 0
    ? requestedScopeGeneration
    : 0;
  const activeScopePresent = options.activeScopePresent === true;
  const currentUserUrl = activeScopePresent
    ? `${API_BASE_URL}/api/auth/user?${CURRENT_USER_SCOPE_GENERATION_QUERY}=${scopeGeneration}`
    : `${API_BASE_URL}/api/auth/user`;
  if (activeScopePresent) {
    reportPackagedAcceptanceCurrentUser({
      phase: 'request-issued', scopeGeneration, activeScopePresent,
      responseStatus: 0, classification: 'pending', schemaAccepted: false,
    });
  }
  const response = await apiFetch(currentUserUrl, activeScopePresent
    ? { credentials: 'include' }
    : { credentials: 'include', cache: 'no-store' });
  const classification = await currentUserResponseClassification(response);
  if (activeScopePresent) {
    reportPackagedAcceptanceCurrentUser({
      phase: 'response-completed', scopeGeneration, activeScopePresent,
      responseStatus: response.status, classification, schemaAccepted: false,
    });
  }
  await handleApiResponse(response);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (activeScopePresent) {
      reportPackagedAcceptanceCurrentUser({
        phase: 'parsed-user-rejected', scopeGeneration, activeScopePresent,
        responseStatus: response.status, classification: 'invalid-schema', schemaAccepted: false,
      });
    }
    throw new Error('Current-user response schema was invalid.');
  }
  if (!isCurrentUserResponse(body)) {
    if (activeScopePresent) {
      reportPackagedAcceptanceCurrentUser({
        phase: 'parsed-user-rejected', scopeGeneration, activeScopePresent,
        responseStatus: response.status, classification: 'invalid-schema', schemaAccepted: false,
      });
    }
    throw new Error('Current-user response schema was invalid.');
  }
  if (activeScopePresent) {
    reportPackagedAcceptanceCurrentUser({
      phase: 'parsed-user-accepted', scopeGeneration, activeScopePresent,
      responseStatus: response.status, classification, schemaAccepted: true,
    });
  }
  setAuthenticatedApiReadIdentity(body.id, authenticatedReadScopeGeneration);
  return body;
};

export const HOSTED_LOGOUT_FAILED_MESSAGE =
  'Unable to log out from the active hosted ProPR tunnel. Check the connection and try again.';

let hostedLogoutInFlight: Promise<void> | null = null;

const isHostedLogoutResponseComplete = (response: Response): boolean =>
  response.ok || response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400);

const hostedLogout = async (): Promise<void> => {
  try {
    const response = await fetch(new URL('/api/auth/logout', API_BASE_URL), {
      credentials: 'include',
      redirect: 'manual',
    });
    if (!isHostedLogoutResponseComplete(response)) {
      throw new Error(`Hosted logout failed with HTTP ${response.status}`);
    }
    window.location.href = pathWithActiveHostedTunnelFlow('/login?logged_out=true');
  } catch (error) {
    console.error('[propr] Hosted logout failed; keeping the active hosted tunnel in this tab.', error);
    window.alert(HOSTED_LOGOUT_FAILED_MESSAGE);
  } finally {
    hostedLogoutInFlight = null;
  }
};

let desktopLogoutInFlight: Promise<void> | null = null;

const desktopLogout = async (): Promise<void> => {
  const scope = getDesktopConnectionScope();
  if (!scope) {
    window.alert('Unable to log out: the active desktop connection changed. Reconnect and try again.');
    return;
  }
  // Cancels REST and disconnects the scoped socket before invoking main.
  setDesktopConnectionScope(null);
  try {
    await scope.bridge.auth.logout({ profileId: scope.profileId, transportScope: scope.transportScope });
  } catch {
    if (!getDesktopConnectionScope()) setDesktopConnectionScope(scope);
    window.alert('Unable to log out from ProPR Desktop. The local credential could not be removed. Try again.');
    return;
  }
  // A late logout must never clear a newer profile's renderer state.
  if (getDesktopConnectionScope()) return;
  window.dispatchEvent(new CustomEvent(DESKTOP_LOGGED_OUT_EVENT, { detail: scope }));
  // The desktop shell now owns sign-in. Reset account-specific routes so a
  // later successful pairing boots the dashboard and validates its new user.
  window.location.hash = '/';
  try {
    // These legacy keys belong to the mounted account UI. Keep instance
    // configuration, device preferences and any other profile namespaces.
    for (const key of [
      'dismissed_plan_ids', 'dismissed_task_ids', 'dismissed_task_timestamps',
      'plannerSettings', 'propr.goalFormSettings', 'propr:push-subscription-owner',
    ]) window.localStorage.removeItem(key);
    window.sessionStorage.removeItem('agent-tank-banner-dismissed');
  } catch {
    window.alert('You are signed out, but ProPR could not clear the account display cache. Restart ProPR Desktop before signing in again.');
  }
};

export const logout = (): void | Promise<void> => {
  setAuthenticatedApiReadIdentity(null);
  if (typeof window !== 'undefined' && window.proprDesktop) {
    desktopLogoutInFlight ??= desktopLogout().finally(() => { desktopLogoutInFlight = null; });
    return desktopLogoutInFlight;
  }
  if (typeof window !== 'undefined' && isHostedUiOrigin(window.location.hostname) && isProprProxyUrl(API_BASE_URL)) {
    hostedLogoutInFlight ??= hostedLogout();
    return hostedLogoutInFlight;
  }

  window.location.href = `${API_BASE_URL}/api/auth/logout`;
};

export * from './configApi';
export * from './plannerApi';
export * from './taskStatsApi';
export * from './agentChatApi';
export * from './repoIndexingApi';
export * from './summaryApi';
export * from './planIssuesApi';
export * from './repoChatApi';
export * from './repoImprovementsApi';
export * from './tasks';
export * from './repoTodosApi';
export * from './userRepoPreferencesApi';
export * from './revertApi';
export * from './agentLoginApi';

export type { ChatMessage } from './plannerApi';
export type { PlanIssueStatus } from './planIssuesApi';
export type {
  CommitInfo, DeleteTaskResponse, PostFollowupResponse,
  RevertParams, RevertPreviewResponse, TriggerReindexAllResponse
} from './proprTypes';
