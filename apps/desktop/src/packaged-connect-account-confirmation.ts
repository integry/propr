import { lstatSync, realpathSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { DesktopGitHubAccount } from './shared/github-account';

/** The synthetic confirmer may only save into the Connect runner's disposable store. */
export const assertPackagedConnectProfileIsolation = (configRoot: string, userData: string): void => {
  const expectedUserData = resolve(configRoot, '..', 'desktop-user-data');
  if (basename(configRoot) !== 'config'
    || !/^propr-desktop-connect-smoke-[A-Za-z0-9]+$/.test(basename(resolve(configRoot, '..')))
    || userData !== expectedUserData || realpathSync.native(userData) !== expectedUserData
    || !lstatSync(userData).isDirectory()) {
    throw new Error('Packaged Connect journey requires its isolated profile store');
  }
};

/** Only constructed for the authorized, isolated packaged Connect loopback journey. */
export const createPackagedConnectAccountConfirmation = (endpoint: string, phase: 'pair' | 'reprobe') => {
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.origin !== endpoint) {
    throw new Error('Packaged Connect account confirmation requires the loopback fixture');
  }
  let confirmed = false;
  return {
    confirm: async (account: DesktopGitHubAccount, origin: string, signal: AbortSignal): Promise<boolean> => {
      if (phase !== 'pair' || confirmed || signal.aborted || origin !== endpoint
        || account.id !== '2290' || account.username !== 'packaged-owner' || account.avatarUrl !== null) return false;
      confirmed = true;
      return true;
    },
    assertComplete: (): void => {
      if (confirmed !== (phase === 'pair')) throw new Error('Packaged Connect account confirmation was not observed');
    },
  };
};
