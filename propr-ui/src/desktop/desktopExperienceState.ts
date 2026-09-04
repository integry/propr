import type { DesktopAdapters, DesktopConnectionResult, DesktopProfile } from './types';

export type ExperienceState =
  | { phase: 'loading' }
  | { phase: 'choose' }
  | { phase: 'connecting'; profile: DesktopProfile }
  | { phase: 'blocked'; profile: DesktopProfile; result: Exclude<DesktopConnectionResult, { status: 'ready' }> }
  | { phase: 'recovery-review'; profile: DesktopProfile; candidate: DesktopProfile }
  | { phase: 'connected'; profile: DesktopProfile; result: Extract<DesktopConnectionResult, { status: 'ready' }> };

export const mergeProfiles = (current: DesktopProfile[], incoming: DesktopProfile[]): DesktopProfile[] => {
  const profiles = new Map(current.map(profile => [profile.id, profile]));
  incoming.forEach(profile => profiles.set(profile.id, profile));
  return [...profiles.values()].sort((a, b) =>
    (b.lastConnectedAt || '').localeCompare(a.lastConnectedAt || ''));
};

export const recoverableError = (message: string): string => `${message} Try again.`;

export const settleAuthenticationCancellation = (adapters: DesktopAdapters, profileId: string): void => {
  // Back/navigation must remain synchronous. Cancellation is best effort and
  // its rejection is deliberately consumed so shutdown cannot create an
  // unhandled promise containing host-specific IPC details.
  void Promise.resolve()
    .then(() => adapters.authentication.cancel?.(profileId))
    .catch(() => undefined);
};
