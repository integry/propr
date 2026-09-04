import type { DesktopConnectionResult } from './types';

export const managedRecoveryMessage =
  'This ProPR Connect endpoint may be stale or the local stack may have restarted. Restart Connect if needed, then retry, re-enter, or rediscover the connection.';

export const managedRediscoveryUnavailableMessage =
  'Connect rediscovery is unavailable. Retry the saved connection or re-enter its Connect address.';

export const safeConnectionMessage = (
  result: Exclude<DesktopConnectionResult, { status: 'ready' }>,
  managed: boolean,
): string => {
  if (managed && result.status === 'offline') return managedRecoveryMessage;
  if (result.status === 'authentication-required') return 'Sign in to continue to this instance.';
  if (result.status === 'incompatible') return 'This instance is not compatible with this version of ProPR Desktop.';
  return 'ProPR Desktop could not reach this instance. Check that it is running and try again.';
};
