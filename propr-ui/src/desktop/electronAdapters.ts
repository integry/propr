import { ProprClient, ProprClientError, normalizeApiBaseUrl } from '@propr/client';
import type { DesktopBridge, DesktopProfile as StoredDesktopProfile } from '../../../apps/desktop/src/shared/contract';
import { setDesktopAccessTokenProvider } from '../api/apiClient';
import type {
  DesktopAdapters,
  DesktopConnectionResult,
  DesktopPlatform,
  DesktopProfile,
} from './types';

interface ElectronAdapterDependencies {
  fetch?: typeof globalThis.fetch;
  pairingSleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

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

const authenticationSummary = (capabilities: {
  browserPairing: boolean;
  instanceBearerTokens: boolean;
  socketIoBearerAuthentication: boolean;
}): string => capabilities.browserPairing
  && capabilities.instanceBearerTokens
  && capabilities.socketIoBearerAuthentication
  ? 'Browser approval · REST and Socket.IO bearer access'
  : 'Secure desktop pairing is unavailable';

const tokenProvider = (bridge: DesktopBridge, profileId: string) => async (): Promise<string | null> => {
  const credential = await bridge.credentials.read(profileId);
  return credential.available ? credential.value : null;
};

const authenticatedClient = (
  bridge: DesktopBridge,
  profile: DesktopProfile,
  dependencies: ElectronAdapterDependencies,
): ProprClient => new ProprClient({
  baseUrl: profile.baseUrl,
  authentication: { type: 'bearer', getAccessToken: tokenProvider(bridge, profile.id) },
  fetch: dependencies.fetch,
});

const revokeCurrentToken = async (
  client: ProprClient,
): Promise<void> => {
  const response = await client.fetch(client.url('/api/desktop/tokens/current'), { method: 'DELETE' }, { timeoutMs: 8000 });
  if (!response.ok && response.status !== 401 && response.status !== 404) {
    throw new Error(`The instance could not revoke this connection (HTTP ${response.status}).`);
  }
};

export const createElectronDesktopAdapters = (
  bridge: DesktopBridge,
  dependencies: ElectronAdapterDependencies = {},
): DesktopAdapters => {
  const pairingControllers = new Map<string, AbortController>();
  let activeCredentialProfileId: string | null = null;

  const deactivate = (): void => {
    activeCredentialProfileId = null;
    setDesktopAccessTokenProvider(null);
  };

  const activateCredentials = (profileId: string): void => {
    activeCredentialProfileId = profileId;
    setDesktopAccessTokenProvider(async () => {
      if (activeCredentialProfileId !== profileId) return null;
      return tokenProvider(bridge, profileId)();
    });
  };

  const clearRendererProfileState = (): void => {
    try { window.localStorage.clear(); } catch { /* unavailable storage is already isolated */ }
    try { window.sessionStorage.clear(); } catch { /* unavailable storage is already isolated */ }
  };

  const probe = async (profile: DesktopProfile): Promise<DesktopConnectionResult> => {
    const baseUrl = normalizeApiBaseUrl(profile.baseUrl);
    const discoveryClient = new ProprClient({
      baseUrl,
      authentication: { type: 'none' },
      fetch: dependencies.fetch,
    });
    let discovery;
    try {
      discovery = await discoveryClient.discoverDesktop();
    } catch (error) {
      return {
        status: 'offline',
        message: error instanceof Error
          ? `ProPR could not discover this instance. ${error.message}`
          : 'ProPR could not discover this instance.',
      };
    }
    const authentication = authenticationSummary(discovery.desktopAuthentication);
    if (!discovery.compatibility.compatible) {
      return {
        status: 'incompatible',
        message: discovery.compatibility.message,
        version: discovery.version,
      };
    }

    const credential = await bridge.credentials.read(profile.id);
    if (!credential.available) {
      return {
        status: 'authentication-required',
        message: 'OS-backed secure storage is unavailable. Enable your system keychain before pairing.',
        version: discovery.version,
        authentication,
      };
    }

    const authClient = credential.value
      ? authenticatedClient(bridge, profile, dependencies)
      : discoveryClient;
    let response: Response;
    try {
      response = await authClient.fetch(authClient.url('/api/auth/user'), {
        cache: 'no-store',
      }, { timeoutMs: 8000 });
    } catch {
      return {
        status: 'offline',
        message: 'The instance was discovered but authentication could not be checked.',
      };
    }
    if (response.ok) {
      if (credential.value) activateCredentials(profile.id);
      return { status: 'ready', version: discovery.version, authentication };
    }
    if (response.status === 401 || response.status === 403) {
      let code: string | undefined;
      try { code = (await response.clone().json() as { code?: string }).code; } catch { /* no public error body */ }
      if (credential.value && (response.status === 401 || code === 'INVALID_INSTANCE_TOKEN')) {
        await bridge.credentials.remove(profile.id);
        if (activeCredentialProfileId === profile.id) deactivate();
      }
      return {
        status: 'authentication-required',
        message: credential.value
          ? 'Access to this instance was revoked or expired. Pair again to continue.'
          : discovery.desktopAuthentication.browserPairing
            ? 'Approve this desktop in your browser to continue.'
            : 'This instance does not support secure desktop pairing.',
        version: discovery.version,
        authentication,
      };
    }
    return {
      status: 'offline',
      message: `The instance returned HTTP ${response.status} while checking authentication.`,
    };
  };

  return {
    platform: platform(navigator.platform || navigator.userAgent),
    profiles: {
      async list() {
        return (await bridge.profiles.list()).profiles.map(fromStoredProfile);
      },
      async save(profile) {
        await bridge.profiles.save({
          id: profile.id,
          label: profile.name,
          apiBaseUrl: normalizeApiBaseUrl(profile.baseUrl),
        });
      },
      async remove(profileId) {
        const stored = (await bridge.profiles.list()).profiles.find(item => item.id === profileId);
        if (stored) {
          const credential = await bridge.credentials.read(profileId);
          if (credential.available && credential.value) {
            const profile = fromStoredProfile(stored);
            await revokeCurrentToken(authenticatedClient(bridge, profile, dependencies)).catch(() => undefined);
          }
        }
        pairingControllers.get(profileId)?.abort();
        pairingControllers.delete(profileId);
        if (activeCredentialProfileId === profileId) deactivate();
        await bridge.profiles.remove(profileId);
      },
      async getActiveId() {
        return (await bridge.profiles.list()).activeProfileId;
      },
      async setActiveId(profileId) {
        const previousProfileId = (await bridge.profiles.list()).activeProfileId;
        await bridge.profiles.setActive(profileId);
        if (previousProfileId !== profileId) clearRendererProfileState();
        if (profileId === null && activeCredentialProfileId !== null) deactivate();
      },
    },
    discovery: {
      async discover() {
        // URL discovery is performed by probe(). Network-wide mDNS remains an
        // optional host concern; never scan arbitrary LAN addresses here.
        return [];
      },
    },
    authentication: {
      async authenticate(profile) {
        const security = await bridge.storage.security();
        if (!security.available) {
          throw new Error('OS-backed secure storage is required for desktop pairing.');
        }
        pairingControllers.get(profile.id)?.abort();
        const controller = new AbortController();
        pairingControllers.set(profile.id, controller);
        const client = new ProprClient({
          baseUrl: profile.baseUrl,
          authentication: { type: 'none' },
          fetch: dependencies.fetch,
        });
        try {
          await bridge.profiles.save({
            id: profile.id,
            label: profile.name,
            apiBaseUrl: normalizeApiBaseUrl(profile.baseUrl),
          });
          const metadata = await bridge.app.getMetadata();
          const pairing = await client.pairDesktop(`ProPR Desktop (${metadata.platform})`, {
            signal: controller.signal,
            sleep: dependencies.pairingSleep,
            now: dependencies.now,
            onApprovalRequired: approvalUrl => bridge.external.open(approvalUrl),
          });
          const stored = await bridge.credentials.write(profile.id, pairing.token);
          if (!stored.stored) {
            const transientClient = new ProprClient({
              baseUrl: profile.baseUrl,
              authentication: { type: 'bearer', getAccessToken: () => pairing.token },
              fetch: dependencies.fetch,
            });
            await revokeCurrentToken(transientClient).catch(() => undefined);
            throw new Error('The paired token could not be stored because OS encryption is unavailable.');
          }
          activateCredentials(profile.id);
        } catch (error) {
          if (error instanceof ProprClientError && error.kind === 'aborted') {
            throw new Error('Desktop pairing was cancelled.');
          }
          throw error;
        } finally {
          if (pairingControllers.get(profile.id) === controller) pairingControllers.delete(profile.id);
        }
      },
      cancel(profileId) {
        pairingControllers.get(profileId)?.abort();
      },
    },
    externalBrowser: { open: url => bridge.external.open(url) },
    localSetup: {
      async setup() {
        throw new Error('Local setup is not available in this desktop build. Connect to a running local instance instead.');
      },
    },
    connection: {
      probe,
      deactivate,
      clearCredentials: profile => bridge.credentials.remove(profile.id),
    },
  };
};
