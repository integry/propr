import type { ConnectAccountStatus } from '../api/proprTypes';

export type CapacityFingerprintInput = Pick<
  ConnectAccountStatus,
  | 'activeSeats'
  | 'allowedSeats'
  | 'seatsRemaining'
  | 'billingCycleResetAt'
  | 'seatLimitBlockedAt'
>;

export const CONNECT_PLUS_CAMPAIGN = 'connect-plus-v1';
const CONNECT_ORIGIN = 'https://connect.propr.dev';

export const connectPlusDismissalKey = (installationId: number, login: string): string =>
  `propr.banner.${CONNECT_PLUS_CAMPAIGN}.${installationId}.${encodeURIComponent(login.trim().toLowerCase())}`;

export const capacityFingerprint = async (account: CapacityFingerprintInput): Promise<string> => {
  const fingerprintSource = JSON.stringify([
    account.activeSeats,
    account.allowedSeats,
    account.seatsRemaining,
    account.billingCycleResetAt,
    account.seatLimitBlockedAt,
  ]);
  const digest = await window.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(fingerprintSource),
  );
  const hexDigest = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return `sha256:${hexDigest}`;
};

export const connectUpgradeUrl = (installationId: number): string => {
  const url = new URL('/dashboard', CONNECT_ORIGIN);
  url.searchParams.set('installation_id', String(installationId));
  url.searchParams.set('focus', 'billing');
  return url.toString();
};
