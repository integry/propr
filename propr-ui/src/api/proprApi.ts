import type { Task as ApiTask } from './tasks';
import { API_BASE_URL, apiFetch, handleApiResponse } from './apiClient';
import { isHostedUiOrigin, pathWithActiveHostedTunnelFlow } from '../config/runtimeConfig';
import { isAccountStatusTimestamp, isProprProxyUrl } from '@propr/shared';
import {
  reportPackagedAcceptanceCurrentUser,
  type PackagedAcceptanceCurrentUserClassification,
} from '../desktop/packagedAcceptanceCurrentUserValidation';

export * from './apiClient';

export interface DemoModeStatus {
  demoMode: boolean;
}

// Re-export all types for backward compatibility
export * from './proprTypes';

import type {
  SystemStatus, StatusResponse, TaskAnalysisResponse, QueueStats, GeneratingPlansResponse,
  GetTasksOptions, StopExecutionResponse, DeleteTaskResponse, CurrentUser,
  InstanceCatalogResponse, ConnectAccountStatus
} from './proprTypes';

export type { UserRepoPreferences } from './userRepoPreferencesApi';

export const getDemoModeStatus = async (): Promise<DemoModeStatus> => {
  const response = await apiFetch(`${API_BASE_URL}/api/auth/demo-mode`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const getSystemStatus = async (): Promise<SystemStatus> => {
  const response = await apiFetch(`${API_BASE_URL}/api/status`, { credentials: 'include' });
  await handleApiResponse(response);
  const data: StatusResponse = await response.json();
  const workers: { id: number; status: string }[] = [];
  for (let i = 0; i < (data.workerCount || 0); i++) workers.push({ id: i + 1, status: 'active' });
  const mapAuthStatus = (status?: string) => status === 'connected' ? 'Authenticated' : 'Failed';
  const mapAgentStatus = (status?: string) => status === 'connected' ? 'Ready' : status === 'degraded' ? 'Degraded' : 'Failed';
  const mapIndexingStatus = (status?: string) => {
    switch (status) {
      case 'active':
        return 'Active';
      case 'queued':
        return 'Queued';
      case 'idle':
        return 'Idle';
      case 'failed':
        return 'Failed';
      case 'connected':
        return 'Connected';
      case 'disconnected':
        return 'Unavailable';
      default:
        return 'Unavailable';
    }
  };
  // Human-readable label for the configured intake path. An unknown or absent
  // mode (older backends) falls back to 'Unknown' so the UI never shows a raw key.
  const intakeLabels: Record<string, string> = {
    routing_websocket: 'ProPR Connect',
    polling: 'Polling',
    direct_webhook: 'Direct Webhook',
  };
  const mapIntakeLabel = (mode?: string) => (mode && intakeLabels[mode]) || 'Unknown';
  const mapIntakeStatus = (status?: string) => {
    switch (status) {
      case 'connected':
        return 'Connected';
      case 'active':
        return 'Active';
      case 'disconnected':
        return 'Disconnected';
      default:
        return 'Unknown';
    }
  };
  const agents = (data.agents || []).map(agent => ({
    ...agent,
    status: mapAgentStatus(agent.status),
  }));
  const connectAccount = data.githubEventIntake === 'routing_websocket'
    && data.githubEventIntakeStatus === 'connected'
    ? parseConnectAccountStatus(data.connectAccount)
    : undefined;
  return {
    daemon: data.daemon === 'running' ? 'Running' : 'Stopped',
    workers,
    redis: data.redis === 'connected' ? 'Connected' : 'Disconnected',
    githubAuth: mapAuthStatus(data.githubAuth),
    claudeAuth: mapAuthStatus(data.claudeAuth),
    indexing: mapIndexingStatus(data.indexing),
    githubEventIntake: mapIntakeLabel(data.githubEventIntake),
    githubEventIntakeStatus: mapIntakeStatus(data.githubEventIntakeStatus),
    agents,
    warnings: data.warnings || [],
    ...(connectAccount ? { connectAccount } : {}),
  };
};

const isNonNegativeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

const isAccountLogin = (value: unknown): value is string | null =>
  value === null || (typeof value === 'string' && value.length > 0 && value.length <= 128);

const isAccountPlan = (value: unknown): value is ConnectAccountStatus['plan'] =>
  value === 'community' || value === 'plus';

const hasValidSeatCounts = (account: Record<string, unknown>): boolean =>
  isNonNegativeInteger(account.activeSeats)
  && isNonNegativeInteger(account.allowedSeats)
  && isNonNegativeInteger(account.seatsRemaining);

function parseConnectAccountStatus(value: unknown): ConnectAccountStatus | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const account = value as Record<string, unknown>;
  if (!Number.isSafeInteger(account.installationId) || (account.installationId as number) <= 0
    || !isAccountLogin(account.accountLogin)
    || !isAccountPlan(account.plan)
    || typeof account.hasPlusAccess !== 'boolean'
    || !hasValidSeatCounts(account)
    || !isAccountStatusTimestamp(account.billingCycleResetAt)
    || !(account.seatLimitBlockedAt === undefined
      || account.seatLimitBlockedAt === null
      || isAccountStatusTimestamp(account.seatLimitBlockedAt))
    || !isAccountStatusTimestamp(account.sentAt)) return undefined;
  if ((account.plan === 'plus') !== account.hasPlusAccess) return undefined;
  if ((account.seatsRemaining as number) !== Math.max(
    0,
    (account.allowedSeats as number) - (account.activeSeats as number),
  )) return undefined;

  return {
    installationId: account.installationId as number,
    accountLogin: account.accountLogin,
    plan: account.plan,
    hasPlusAccess: account.hasPlusAccess,
    activeSeats: account.activeSeats as number,
    allowedSeats: account.allowedSeats as number,
    seatsRemaining: account.seatsRemaining as number,
    billingCycleResetAt: account.billingCycleResetAt,
    ...(account.seatLimitBlockedAt !== undefined
      ? { seatLimitBlockedAt: account.seatLimitBlockedAt }
      : {}),
    sentAt: account.sentAt,
  };
}

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

export const getTasks = async (
  statusOrOptions: string | GetTasksOptions = 'all', limit = 50, offset = 0, repository = 'all', search = ''
): Promise<GetTasksResponse> => {
  let options: GetTasksOptions;
  if (typeof statusOrOptions === 'object') options = statusOrOptions;
  else options = { status: statusOrOptions, limit, offset, repository, search };
  const params = new URLSearchParams({
    status: options.status || 'all', limit: (options.limit ?? 50).toString(),
    offset: (options.offset ?? 0).toString(), repository: options.repository || 'all'
  });
  if (options.search) params.append('search', options.search);
  if (options.forReview) params.append('forReview', 'true');
  if (options.excludeMerged) params.append('excludeMerged', 'true');
  const response = await apiFetch(`${API_BASE_URL}/api/tasks?${params.toString()}`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const getTaskHistory = async (taskId: string): Promise<unknown> => {
  const response = await apiFetch(`${API_BASE_URL}/api/task/${taskId}/history`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const getTaskAnalysis = async (taskId: string): Promise<TaskAnalysisResponse> => {
  const response = await apiFetch(`${API_BASE_URL}/api/task/${taskId}/analysis`, { credentials: 'include' });
  if (response.status === 202) return { analysis: null, message: 'Analysis pending...' };
  await handleApiResponse(response);
  return response.json();
};

export const getTaskLiveDetails = async (taskId: string): Promise<unknown> => {
  const response = await apiFetch(`${API_BASE_URL}/api/task/${taskId}/live-details`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const getInstanceCatalog = async (): Promise<InstanceCatalogResponse> => {
  const response = await apiFetch(`${API_BASE_URL}/api/instance/catalog`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

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
  const response = await apiFetch(`${API_BASE_URL}/api/task/${taskId}/stop`, { method: 'POST', credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const deleteTask = async (taskId: string, force?: boolean): Promise<void> => {
  const url = force ? `${API_BASE_URL}/api/tasks/${taskId}?force=true` : `${API_BASE_URL}/api/tasks/${taskId}`;
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

export const logout = (): void | Promise<void> => {
  if (typeof window !== 'undefined' && window.proprDesktop) {
    return window.proprDesktop.auth.logout(API_BASE_URL).then(() => {
      window.location.hash = '/login?logged_out=true';
    });
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
