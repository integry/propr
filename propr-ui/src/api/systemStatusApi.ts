import { isAccountStatusTimestamp } from '@propr/shared';
import { API_BASE_URL, apiFetch, handleApiResponse, shareInFlightApiRead } from './apiClient';
import type { ConnectAccountStatus, StatusResponse, SystemStatus } from './proprTypes';

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

const parseConnectAccountStatus = (value: unknown): ConnectAccountStatus | undefined => {
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
};

const mapAuthStatus = (status?: string) => status === 'connected' ? 'Authenticated' : 'Failed';
const mapClaudeAuthStatus = (status?: string) => status === 'not_applicable'
  ? 'Not applicable'
  : mapAuthStatus(status);
const mapAgentStatus = (status?: string) => status === 'connected' ? 'Ready' : status === 'degraded' ? 'Degraded' : 'Failed';

const mapIndexingStatus = (status?: string) => {
  switch (status) {
    case 'active': return 'Active';
    case 'queued': return 'Queued';
    case 'idle': return 'Idle';
    case 'failed': return 'Failed';
    case 'connected': return 'Connected';
    default: return 'Unavailable';
  }
};

const intakeLabels: Record<string, string> = {
  routing_websocket: 'ProPR Connect',
  polling: 'Polling',
  direct_webhook: 'Direct Webhook',
};
const mapIntakeLabel = (mode?: string) => (mode && intakeLabels[mode]) || 'Unknown';
const mapIntakeStatus = (status?: string) => {
  switch (status) {
    case 'connected': return 'Connected';
    case 'active': return 'Active';
    case 'disconnected': return 'Disconnected';
    default: return 'Unknown';
  }
};

export const getSystemStatus = (): Promise<SystemStatus> =>
  shareInFlightApiRead('system-status', async signal => {
    const response = await apiFetch(`${API_BASE_URL}/api/status`, { credentials: 'include', signal });
    await handleApiResponse(response);
    const data: StatusResponse = await response.json();
    const workers: { id: number; status: string }[] = [];
    for (let index = 0; index < (data.workerCount || 0); index++) {
      workers.push({ id: index + 1, status: 'active' });
    }
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
      claudeAuth: mapClaudeAuthStatus(data.claudeAuth),
      indexing: mapIndexingStatus(data.indexing),
      githubEventIntake: mapIntakeLabel(data.githubEventIntake),
      githubEventIntakeStatus: mapIntakeStatus(data.githubEventIntakeStatus),
      agents,
      warnings: data.warnings || [],
      ...(connectAccount ? { connectAccount } : {}),
    };
  });
