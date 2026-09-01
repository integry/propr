import { normalizeApiBaseUrl } from '@propr/client';
import { isProprLoopbackHostname, parseProprConnectEndpoint } from '@propr/shared';
import type { DesktopBridge, DesktopDiscoveryCandidate, DesktopProfile as StoredDesktopProfile } from '../../../apps/desktop/src/shared/contract';
import { getDesktopConnectionScope, setDesktopConnectionScope } from '../api/apiClient';
import type { DesktopAdapters, DesktopPlatform, DesktopProfile } from './types';

const platform = (value: string): DesktopPlatform => {
  const normalized = value.toLowerCase();
  if (normalized.includes('mac')) return 'macos';
  if (normalized.includes('win')) return 'windows';
  return 'linux';
};

const isLocal = (baseUrl: string): boolean => {
  return isProprLoopbackHostname(new URL(baseUrl).hostname);
};

const fromStoredProfile = (profile: StoredDesktopProfile): DesktopProfile => ({
  id: profile.id,
  name: profile.label,
  baseUrl: profile.apiBaseUrl,
  kind: isLocal(profile.apiBaseUrl) ? 'local' : 'remote',
  lastConnectedAt: profile.updatedAt,
});

const toStoredProfile = (profile: DesktopProfile) => ({
  id: profile.id,
  label: profile.name,
  apiBaseUrl: normalizeApiBaseUrl(profile.baseUrl),
});

const fromDiscoveryCandidate = (candidate: DesktopDiscoveryCandidate): DesktopProfile | null => {
  const endpoint = parseProprConnectEndpoint(candidate.apiBaseUrl);
  if (
    !endpoint
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(candidate.id)
    || candidate.label.length === 0
    || candidate.label.length > 80
  ) return null;
  return {
    id: candidate.id,
    name: candidate.label,
    baseUrl: endpoint.origin,
    kind: 'remote',
  };
};

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
    if (window.localStorage.length !== 0) throw new Error('Local storage was not cleared');
    window.sessionStorage.clear();
    if (window.sessionStorage.length !== 0) throw new Error('Session storage was not cleared');
    return true;
  } catch {
    try { restoreStorage(window.localStorage, localSnapshot); } catch { /* fail closed below */ }
    try { restoreStorage(window.sessionStorage, sessionSnapshot); } catch { /* fail closed below */ }
    return false;
  }
};

export const createElectronDesktopAdapters = (bridge: DesktopBridge): DesktopAdapters => {
  let publishedProfile: { id: string; origin: string; identityEpoch: string } | null = null;
  return {
  platform: platform(navigator.platform || navigator.userAgent),
  app: { onDeepLink: listener => bridge.app.onDeepLink(listener) },
  profiles: {
    async list() {
      return (await bridge.profiles.list()).profiles.map(fromStoredProfile);
    },
    async save(profile) {
      await bridge.profiles.save(toStoredProfile(profile));
    },
    async remove(profileId) {
      await bridge.authentication.cancel(profileId);
      await bridge.profiles.remove(profileId);
    },
    async getActiveId() {
      return (await bridge.profiles.list()).activeProfileId;
    },
    async setActiveId(profileId) {
      await bridge.profiles.setActive(profileId);
      if (profileId === null) {
        setDesktopConnectionScope(null);
      }
    },
  },
  discovery: {
    supported: bridge.discovery.supported,
    async discover() {
      return (await bridge.discovery.discover())
        .map(fromDiscoveryCandidate)
        .filter((profile): profile is DesktopProfile => profile !== null);
    },
  },
  managedTunnelRecovery: {
    async rediscover(profileId) {
      const candidate = await bridge.discovery.rediscover(profileId);
      if (!candidate || candidate.id !== profileId) return null;
      return fromDiscoveryCandidate(candidate);
    },
  },
  authentication: {
    async authenticate(profile) {
      const security = await bridge.storage.security();
      if (!security.available) throw new Error('OS-backed secure storage is required for desktop pairing.');
      await bridge.authentication.pair(toStoredProfile(profile));
    },
    cancel(profileId) {
      return bridge.authentication.cancel(profileId);
    },
  },
  externalBrowser: { open: url => bridge.external.open(url) },
  localSetup: {
    supported: false,
    async setup() {
      throw new Error('Local setup is not available in this desktop build. Connect to a running local instance instead.');
    },
  },
  connection: {
    async probe(profile) {
      return bridge.connection.probe(toStoredProfile(profile));
    },
    async activate(profile, result, isCurrent = () => true) {
      if (result.activationTicket === undefined) throw new Error('Desktop activation ticket is missing.');
      const previousProfileId = (await bridge.profiles.list()).activeProfileId;
      const activated = await bridge.connection.activate(result.activationTicket);
      const discard = async () => {
        await bridge.connection.discard({
          profileId: activated.profileId,
          transportScope: activated.transportScope,
        }).catch(() => undefined);
        const currentScope = getDesktopConnectionScope();
        if (currentScope?.profileId === activated.profileId
          && currentScope.transportScope === activated.transportScope) {
          setDesktopConnectionScope(null);
        }
      };
      if (activated.profileId !== profile.id || !isCurrent()) {
        await discard();
        return {
          status: 'authentication-required',
          message: 'This connection changed while it was being activated. Check it again to continue.',
          version: result.version,
          authentication: result.authentication,
        };
      }
      const intendedOrigin = normalizeApiBaseUrl(profile.baseUrl);
      if (!/^[A-Za-z0-9_-]{22}$/.test(activated.identityEpoch)) {
        await discard();
        return {
          status: 'authentication-required',
          message: 'This connection changed while it was being activated. Check it again to continue.',
          version: result.version,
          authentication: result.authentication,
        };
      }
      const isReplacement = publishedProfile === null
        || previousProfileId !== profile.id
        || publishedProfile.id !== profile.id
        || publishedProfile.origin !== intendedOrigin
        || publishedProfile.identityEpoch !== activated.identityEpoch;
      if (isReplacement && !clearRendererProfileState()) {
        await discard();
        return {
          status: 'offline',
          message: 'Desktop storage isolation failed. Restart ProPR Desktop before connecting again.',
        };
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
      if (result.transportScope === undefined) throw new Error('Desktop transport scope is missing.');
      if (result.identityEpoch === undefined) throw new Error('Desktop credential identity is missing.');
      if (result.profileId === undefined || result.profileId !== profile.id) {
        setDesktopConnectionScope(null);
        throw new Error('Desktop activation profile changed before publication.');
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
