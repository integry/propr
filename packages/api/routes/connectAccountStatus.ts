import type { GithubEventIntakeMode } from '@propr/shared';

const MAX_ACCOUNT_LOGIN_LENGTH = 128;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** UI-safe projection of Connect's authenticated installation account status. */
export interface ConnectAccountStatus {
  installationId: number;
  accountLogin: string | null;
  plan: 'community' | 'plus';
  hasPlusAccess: boolean;
  activeSeats: number;
  allowedSeats: number;
  seatsRemaining: number;
  billingCycleResetAt: string;
  seatLimitBlockedAt?: string | null;
  sentAt: string;
}

export interface RoutingState {
  connected: boolean;
  routingUrl: string;
  lastDeliveryId: string | null;
  lastAckAt: string | null;
  connectAccount?: ConnectAccountStatus;
}

export function applyRoutingStatus(
  status: Record<string, unknown>,
  intakeMode: GithubEventIntakeMode | 'unknown',
  routing: RoutingState | undefined
): void {
  if (!routing) return;
  const { connectAccount, ...routingDiagnostics } = routing;
  if (intakeMode !== 'routing_websocket') {
    status.routing = routingDiagnostics;
    return;
  }
  status.routing = routing;
  if (routing.connected && connectAccount) status.connectAccount = connectAccount;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && ISO_TIMESTAMP_PATTERN.test(value)
    && !Number.isNaN(Date.parse(value));
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function hasValidIdentity(account: Record<string, unknown>): boolean {
  return Number.isSafeInteger(account.installationId)
    && (account.installationId as number) > 0
    && (account.accountLogin === null
      || (typeof account.accountLogin === 'string'
        && account.accountLogin.length > 0
        && account.accountLogin.length <= MAX_ACCOUNT_LOGIN_LENGTH));
}

function hasValidPlan(account: Record<string, unknown>): boolean {
  return (account.plan === 'community' || account.plan === 'plus')
    && typeof account.hasPlusAccess === 'boolean';
}

function hasValidSeatCounts(account: Record<string, unknown>): boolean {
  return isNonNegativeInteger(account.activeSeats)
    && isNonNegativeInteger(account.allowedSeats)
    && isNonNegativeInteger(account.seatsRemaining);
}

function hasValidTimestamps(account: Record<string, unknown>): boolean {
  return isTimestamp(account.billingCycleResetAt)
    && (account.seatLimitBlockedAt === undefined
      || account.seatLimitBlockedAt === null
      || isTimestamp(account.seatLimitBlockedAt))
    && isTimestamp(account.sentAt);
}

/** Strictly validate a daemon snapshot before exposing it through the API. */
export function parseConnectAccountStatus(value: unknown): ConnectAccountStatus | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const account = value as Record<string, unknown>;
  if (!hasValidIdentity(account)
    || !hasValidPlan(account)
    || !hasValidSeatCounts(account)
    || !hasValidTimestamps(account)) return undefined;
  if ((account.plan === 'plus') !== account.hasPlusAccess) return undefined;
  if (account.seatsRemaining !== Math.max(
    0,
    (account.allowedSeats as number) - (account.activeSeats as number)
  )) return undefined;

  return {
    installationId: account.installationId as number,
    accountLogin: account.accountLogin as string | null,
    plan: account.plan as 'community' | 'plus',
    hasPlusAccess: account.hasPlusAccess as boolean,
    activeSeats: account.activeSeats as number,
    allowedSeats: account.allowedSeats as number,
    seatsRemaining: account.seatsRemaining as number,
    billingCycleResetAt: account.billingCycleResetAt as string,
    ...(account.seatLimitBlockedAt !== undefined
      ? { seatLimitBlockedAt: account.seatLimitBlockedAt as string | null }
      : {}),
    sentAt: account.sentAt as string
  };
}
