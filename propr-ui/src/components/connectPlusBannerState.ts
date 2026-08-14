import type { ConnectAccountStatus } from '../api/proprTypes';

export const CONNECT_PLUS_CAMPAIGN = 'connect-plus-v1';
const CONNECT_ORIGIN = 'https://connect.propr.dev';

export const connectPlusDismissalKey = (installationId: number, login: string): string =>
  `propr.banner.${CONNECT_PLUS_CAMPAIGN}.${installationId}.${encodeURIComponent(login.trim().toLowerCase())}`;

export const capacityFingerprint = (account: ConnectAccountStatus): string => [
  account.activeSeats,
  account.allowedSeats,
  account.seatsRemaining,
  account.billingCycleResetAt,
  account.seatLimitBlockedAt ?? 'none',
].join(':');

export const connectUpgradeUrl = (installationId: number): string => {
  const url = new URL('/dashboard', CONNECT_ORIGIN);
  url.searchParams.set('installation_id', String(installationId));
  url.searchParams.set('focus', 'billing');
  return url.toString();
};
