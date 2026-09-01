import { normalizeApiBaseUrl } from '@propr/client';
import type { DesktopRendererBridge } from '../../../apps/desktop/src/shared/contract';
import { getDesktopConnectionScope, setDesktopConnectionScope } from '../api/apiClient';
import type { DesktopAdapters } from './types';

const snapshotStorage = (storage: Storage): [string, string][] => {
  const snapshot: [string, string][] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key !== null) snapshot.push([key, storage.getItem(key) ?? '']);
  }
  return snapshot;
};

const restoreStorage = (storage: Storage, snapshot: [string, string][]): void => {
  const expected = new Set(snapshot.map(([key]) => key));
  for (let index = storage.length - 1; index >= 0; index -= 1) {
    const key = storage.key(index);
    if (key !== null && !expected.has(key)) storage.removeItem(key);
  }
  snapshot.forEach(([key, value]) => storage.setItem(key, value));
};

const clearRendererProfileState = (): boolean => {
  let localSnapshot: [string, string][] = [];
  let sessionSnapshot: [string, string][] = [];
  try {
    localSnapshot = snapshotStorage(window.localStorage);
    sessionSnapshot = snapshotStorage(window.sessionStorage);
    window.localStorage.clear();
    window.sessionStorage.clear();
    if (window.localStorage.length !== 0 || window.sessionStorage.length !== 0) {
      throw new Error('Desktop renderer storage was not cleared');
    }
    return true;
  } catch {
    try { restoreStorage(window.localStorage, localSnapshot); } catch { /* fail closed below */ }
    try { restoreStorage(window.sessionStorage, sessionSnapshot); } catch { /* fail closed below */ }
    return false;
  }
};

/** Renderer-owned composition around the least-privileged staged preload bridge. */
export const createElectronDesktopAdapters = (bridge: DesktopRendererBridge): DesktopAdapters => {
  let publishedProfile: { id: string; origin: string; identityEpoch: string } | null = null;
  return {
    platform: bridge.platform,
    app: bridge.app,
    profiles: {
      list: () => bridge.profiles.list(),
      save: profile => bridge.profiles.save(profile),
      async remove(profileId) {
        await bridge.authentication.cancel(profileId);
        await bridge.profiles.remove(profileId);
      },
      getActiveId: () => bridge.profiles.getActiveId(),
      async setActiveId(profileId) {
        await bridge.profiles.setActiveId(profileId);
        if (profileId === null) setDesktopConnectionScope(null);
      },
    },
    discovery: bridge.discovery,
    authentication: {
      authenticate: profile => bridge.authentication.authenticate(profile),
      cancel: profileId => bridge.authentication.cancel(profileId),
    },
    externalBrowser: bridge.externalBrowser,
    localSetup: bridge.localSetup,
    connection: {
      probe: profile => bridge.connection.probe(profile),
      async activate(profile, result, isCurrent = () => true) {
        if (profile.kind === 'local' && result.activationTicket === undefined) {
          if (!isCurrent()) return { status: 'offline', message: 'This connection changed before activation completed.' };
          await bridge.profiles.setActiveId(profile.id);
          if (!isCurrent()) return { status: 'offline', message: 'This connection changed before activation completed.' };
          return result;
        }
        if (result.activationTicket === undefined) throw new Error('Desktop activation ticket is missing.');
        const previousProfileId = await bridge.profiles.getActiveId();
        const activated = await bridge.connection.activate(result.activationTicket);
        const discard = async () => {
          await bridge.connection.discard(activated).catch(() => undefined);
          const currentScope = getDesktopConnectionScope();
          if (currentScope?.profileId === activated.profileId
            && currentScope.transportScope === activated.transportScope) setDesktopConnectionScope(null);
        };
        if (activated.profileId !== profile.id || !isCurrent()
          || !/^[A-Za-z0-9_-]{22}$/.test(activated.identityEpoch)) {
          await discard();
          return {
            status: 'authentication-required',
            message: 'This connection changed while it was being activated. Check it again to continue.',
            version: result.version,
            authentication: result.authentication,
          };
        }
        const intendedOrigin = normalizeApiBaseUrl(profile.baseUrl);
        const isReplacement = publishedProfile === null
          || previousProfileId !== profile.id
          || publishedProfile.id !== profile.id
          || publishedProfile.origin !== intendedOrigin
          || publishedProfile.identityEpoch !== activated.identityEpoch;
        if (isReplacement && !clearRendererProfileState()) {
          await discard();
          return { status: 'offline', message: 'Desktop storage isolation failed. Restart ProPR Desktop before connecting again.' };
        }
        return {
          status: 'ready',
          version: result.version,
          authentication: result.authentication,
          profileId: activated.profileId,
          transportScope: activated.transportScope,
          identityEpoch: activated.identityEpoch,
        };
      },
      publishActivation(profile, result) {
        if (!result.transportScope || !result.identityEpoch || result.profileId !== profile.id) {
          setDesktopConnectionScope(null);
          throw new Error('Desktop connection activation changed before publication.');
        }
        setDesktopConnectionScope({
          bridge,
          profileId: result.profileId,
          transportScope: result.transportScope,
        }, profile.baseUrl);
        publishedProfile = {
          id: profile.id,
          origin: normalizeApiBaseUrl(profile.baseUrl),
          identityEpoch: result.identityEpoch,
        };
      },
      deactivate() {
        setDesktopConnectionScope(null);
      },
    },
  };
};
