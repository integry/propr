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
    activate(profile, result) {
      if (result.connectionGeneration === undefined) throw new Error('Desktop connection generation is missing.');
      setDesktopConnectionScope({
        bridge,
        profileId: profile.id,
        connectionGeneration: result.connectionGeneration,
      });
    },
    deactivate() {
      setDesktopConnectionScope(null);
    },
  },
});
