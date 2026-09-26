import type { DesktopConnectionResult } from './types';

export const managedRecoveryMessage =
  'ProPR Desktop could not reach the selected ProPR Connect endpoint. Retry it, re-enter its address, or use trusted local Connect discovery to refresh it.';

export const managedRediscoveryUnavailableMessage =
  'Trusted local Connect discovery is unavailable on this device. Retry the saved connection or re-enter its Connect address.';

export const safeConnectionMessage = (
  result: Exclude<DesktopConnectionResult, { status: 'ready' }>,
  managed: boolean,
): string => {
  if (managed && result.status === 'offline') return managedRecoveryMessage;
  if (result.status === 'authentication-required') return 'Sign in to continue to this instance.';
  if (result.status === 'incompatible') return 'This instance is not compatible with this version of ProPR Desktop.';
  return 'ProPR Desktop could not reach this instance. Check that it is running and try again.';
};
