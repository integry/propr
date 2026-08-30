import { normalizeApiBaseUrl } from '@propr/client';
import type { DesktopBridge, DesktopProfile as StoredDesktopProfile } from '../../../apps/desktop/src/shared/contract';
import { setDesktopConnectionScope } from '../api/apiClient';
import type { DesktopAdapters, DesktopPlatform, DesktopProfile } from './types';

const platform = (value: string): DesktopPlatform => {
  const normalized = value.toLowerCase();
  if (normalized.includes('mac')) return 'macos';
  if (normalized.includes('win')) return 'windows';
  return 'linux';
};

const isLocal = (baseUrl: string): boolean => {
  const hostname = new URL(baseUrl).hostname.toLowerCase().replace(/\.$/, '');
  return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '[::1]'
    || /^127(?:\.\d{1,3}){3}$/.test(hostname);
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

const clearRendererProfileState = (): void => {
  try { window.localStorage.clear(); } catch { /* unavailable storage is already isolated */ }
  try { window.sessionStorage.clear(); } catch { /* unavailable storage is already isolated */ }
};

export const createElectronDesktopAdapters = (bridge: DesktopBridge): DesktopAdapters => ({
  platform: platform(navigator.platform || navigator.userAgent),
  profiles: {
    async list() {
      return (await bridge.profiles.list()).profiles.map(fromStoredProfile);
    },
    async save(profile) {
      const current = (await bridge.profiles.list()).profiles.find(item => item.id === profile.id);
      if (current && current.apiBaseUrl !== normalizeApiBaseUrl(profile.baseUrl)) clearRendererProfileState();
      await bridge.profiles.save(toStoredProfile(profile));
    },
    async remove(profileId) {
      await bridge.authentication.cancel(profileId);
      await bridge.profiles.remove(profileId);
      clearRendererProfileState();
    },
    async getActiveId() {
      return (await bridge.profiles.list()).activeProfileId;
    },
    async setActiveId(profileId) {
      const previousProfileId = (await bridge.profiles.list()).activeProfileId;
      await bridge.profiles.setActive(profileId);
      if (previousProfileId !== profileId) clearRendererProfileState();
      if (profileId === null) setDesktopConnectionScope(null);
    },
  },
  discovery: {
    async discover() {
      // URL discovery is performed by the main-process probe. Network-wide mDNS
      // remains an optional host concern; never scan arbitrary LAN addresses here.
      return [];
    },
  },
  authentication: {
    async authenticate(profile) {
      const security = await bridge.storage.security();
      if (!security.available) throw new Error('OS-backed secure storage is required for desktop pairing.');
      const current = (await bridge.profiles.list()).profiles.find(item => item.id === profile.id);
      if (current && current.apiBaseUrl !== normalizeApiBaseUrl(profile.baseUrl)) clearRendererProfileState();
      await bridge.authentication.pair(toStoredProfile(profile));
    },
    cancel(profileId) {
      void bridge.authentication.cancel(profileId);
    },
  },
  externalBrowser: { open: url => bridge.external.open(url) },
  localSetup: {
    async setup() {
      throw new Error('Local setup is not available in this desktop build. Connect to a running local instance instead.');
    },
  },
  connection: {
    async probe(profile) {
      const current = (await bridge.profiles.list()).profiles.find(item => item.id === profile.id);
      if (current && current.apiBaseUrl !== normalizeApiBaseUrl(profile.baseUrl)) {
        clearRendererProfileState();
        setDesktopConnectionScope(null);
      }
      return bridge.connection.probe(toStoredProfile(profile));
    },
    async activate(profile, result) {
      if (result.activationTicket === undefined) throw new Error('Desktop activation ticket is missing.');
      const previousProfileId = (await bridge.profiles.list()).activeProfileId;
      const activated = await bridge.connection.activate(result.activationTicket);
      if (previousProfileId !== activated.profileId) clearRendererProfileState();
      if (activated.profileId !== profile.id) {
        setDesktopConnectionScope(null);
        return {
          status: 'authentication-required',
          message: 'This connection changed while it was being activated. Check it again to continue.',
          version: result.version,
          authentication: result.authentication,
        };
      }
      return {
        status: 'ready',
        version: result.version,
        authentication: result.authentication,
        profileId: activated.profileId,
        transportScope: activated.transportScope,
      };
    },
    publishActivation(profile, result) {
      if (result.transportScope === undefined) throw new Error('Desktop transport scope is missing.');
      if (result.profileId === undefined || result.profileId !== profile.id) {
        setDesktopConnectionScope(null);
        throw new Error('Desktop activation profile changed before publication.');
      }
      setDesktopConnectionScope({
        bridge,
        profileId: result.profileId,
        transportScope: result.transportScope,
      }, profile.baseUrl);
    },
    deactivate() {
      setDesktopConnectionScope(null);
    },
  },
});
