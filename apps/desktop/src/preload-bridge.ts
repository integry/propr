import type {
  DesktopConnectionResult,
  DesktopBridge,
  DesktopPlatformView,
  DesktopProfile,
  DesktopProfileView,
  DesktopRendererBridge,
  DesktopSetupSnapshot,
} from './shared/contract';
import { IPC_CHANNELS } from './shared/contract';
import { evaluateProprApiCompatibility } from '@propr/shared';
import { normalizeApiBaseUrl } from './security';

export interface PreloadIpc {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, value: any) => void): void;
  removeListener(channel: string, listener: (event: unknown, value: any) => void): void;
}

const invoke = <T>(ipc: PreloadIpc, channel: string, ...args: unknown[]): Promise<T> =>
  ipc.invoke(channel, ...args) as Promise<T>;

export const createDesktopBridge = (
  ipc: PreloadIpc,
  platform: NodeJS.Platform = process.platform,
): DesktopBridge => {
  const deepLinkListeners = new Set<(url: string) => void>();
  const pendingDeepLinks: string[] = [];
  ipc.on(IPC_CHANNELS.deepLink, (_event, value) => {
    if (deepLinkListeners.size === 0) {
      pendingDeepLinks.push(value);
      return;
    }
    deepLinkListeners.forEach(listener => listener(value));
  });

  const bridge: DesktopBridge = {
    app: {
      getMetadata: () => invoke(ipc, IPC_CHANNELS.appMetadata),
      onDeepLink: (listener) => {
        deepLinkListeners.add(listener);
        pendingDeepLinks.splice(0).forEach(value => listener(value));
        return () => deepLinkListeners.delete(listener);
      },
    },
    auth: {
      logout: (apiBaseUrl) => invoke(ipc, IPC_CHANNELS.authLogout, apiBaseUrl),
    },
    external: {
      open: (url) => invoke(ipc, IPC_CHANNELS.openExternal, url),
    },
    storage: {
      security: () => invoke(ipc, IPC_CHANNELS.storageSecurity),
    },
    profiles: {
      list: () => invoke(ipc, IPC_CHANNELS.profilesList),
      save: (profile) => invoke(ipc, IPC_CHANNELS.profilesSave, profile),
      remove: (profileId) => invoke(ipc, IPC_CHANNELS.profilesRemove, profileId),
      setActive: (profileId) => invoke(ipc, IPC_CHANNELS.profilesSetActive, profileId),
    },
    authentication: {
      pair: (profile) => invoke(ipc, IPC_CHANNELS.authenticationPair, profile),
      cancel: (profileId) => invoke(ipc, IPC_CHANNELS.authenticationCancel, profileId),
    },
    connection: {
      probe: (profile) => invoke(ipc, IPC_CHANNELS.connectionProbe, profile),
      activate: (activationTicket) => invoke(ipc, IPC_CHANNELS.connectionActivate, activationTicket),
      discard: (value) => invoke(ipc, IPC_CHANNELS.connectionDiscard, value),
      invalidate: (value) => invoke(ipc, IPC_CHANNELS.connectionInvalidate, value),
    },
    ...(platform === 'linux' ? { lifecycle: {
      status: () => invoke(ipc, IPC_CHANNELS.lifecycleStatus),
      start: () => invoke(ipc, IPC_CHANNELS.lifecycleStart),
      stop: () => invoke(ipc, IPC_CHANNELS.lifecycleStop),
      restart: () => invoke(ipc, IPC_CHANNELS.lifecycleRestart),
    } } : {}),
  };

  Object.values(bridge).forEach(Object.freeze);
  return Object.freeze(bridge);
};

const platformView = (platform: NodeJS.Platform): DesktopPlatformView =>
  platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : 'linux';

const isLoopback = (baseUrl: string): boolean => {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  } catch {
    return false;
  }
};

const profileView = (profile: DesktopProfile): DesktopProfileView => ({
  id: profile.id,
  name: profile.label,
  baseUrl: profile.apiBaseUrl,
  kind: isLoopback(profile.apiBaseUrl) ? 'local' : 'remote',
  lastConnectedAt: profile.updatedAt,
});

const bounded = (value: string, maximum = 512): string => value.slice(0, maximum);

/** Compatibility probe for confirmed local or remote profile origins. */
export const probeDesktopProfile = async (
  profile: DesktopProfileView,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<DesktopConnectionResult> => {
  const baseUrl = normalizeApiBaseUrl(profile.baseUrl);
  if (!baseUrl || baseUrl !== profile.baseUrl) {
    return { status: 'offline', message: 'This profile does not contain a valid ProPR instance origin.' };
  }
  if (profile.kind === 'local' && !isLoopback(baseUrl)) {
    return { status: 'offline', message: 'This local profile does not use a loopback address.' };
  }
  try {
    const response = await fetchImpl(`${baseUrl}/api/compatibility`, {
      credentials: 'include',
      cache: 'no-store',
      signal: AbortSignal.timeout(8_000),
    });
    if (response.status === 401 || response.status === 403) {
      return { status: 'authentication-required', message: 'Sign in to continue to this instance.' };
    }
    if (response.status === 404) return { status: 'ready' };
    if (!response.ok) return { status: 'offline', message: `The instance returned HTTP ${response.status}.` };
    const metadata = await response.json() as { apiCompatibility?: string; version?: string };
    const compatibility = evaluateProprApiCompatibility(metadata);
    const version = compatibility.apiVersion ? bounded(compatibility.apiVersion, 64) : undefined;
    if (compatibility.compatible || compatibility.reason === 'missing') {
      return { status: 'ready', version };
    }
    return { status: 'incompatible', message: bounded(compatibility.message), version };
  } catch {
    return { status: 'offline', message: 'ProPR Desktop could not reach this instance. Check that it is running and try again.' };
  }
};

/** Build the shared renderer adapter without exposing raw IPC or credentials. */
export const createDesktopRendererBridge = (
  ipc: PreloadIpc,
  platform: NodeJS.Platform = process.platform,
  connectionProbe?: (profile: DesktopProfileView) => Promise<DesktopConnectionResult>,
  onDeepLink: DesktopBridge['app']['onDeepLink'] = () => () => undefined,
): DesktopRendererBridge => {
  const platformName = platformView(platform);
  const progressListeners = new Set<(snapshot: DesktopSetupSnapshot) => void>();
  if (platformName === 'linux') {
    ipc.on(IPC_CHANNELS.setupProgress, (_event, snapshot: DesktopSetupSnapshot) => {
      progressListeners.forEach(listener => listener(snapshot));
    });
  }
  const remoteOnlySnapshot = (): DesktopSetupSnapshot => ({
    phase: 'unsupported',
    capability: {
      supported: false,
      kind: 'remote-only',
      platform,
      reason: 'Local setup is available only on Linux. Connect to a remote ProPR instance.',
    },
    sessionId: '00000000-0000-4000-8000-000000000000',
    logs: [],
  });
  const localSetupUnavailable = async (): Promise<never> => {
    throw new Error('Local setup is unavailable on this platform. Connect to a remote ProPR instance.');
  };

  const bridge: DesktopRendererBridge = {
    isDesktop: true,
    platform: platformName,
    app: { onDeepLink: listener => onDeepLink(listener) },
    profiles: {
      list: async () => {
        const result = await invoke<{ profiles: DesktopProfile[] }>(ipc, IPC_CHANNELS.profilesList);
        return result.profiles.map(profileView);
      },
      save: async (profile) => {
        await invoke(ipc, IPC_CHANNELS.profilesSave, {
          id: profile.id,
          label: profile.name,
          apiBaseUrl: profile.baseUrl,
        });
      },
      remove: (profileId) => invoke(ipc, IPC_CHANNELS.profilesRemove, profileId),
      getActiveId: async () => (await invoke<{ activeProfileId: string | null }>(ipc, IPC_CHANNELS.profilesList)).activeProfileId,
      setActiveId: (profileId) => invoke(ipc, IPC_CHANNELS.profilesSetActive, profileId),
    },
    discovery: { discover: () => invoke(ipc, IPC_CHANNELS.discovery) },
    authentication: {
      authenticate: async profile => {
        const apiBaseUrl = normalizeApiBaseUrl(profile.baseUrl);
        if (profile.kind !== 'remote' || !apiBaseUrl || apiBaseUrl !== profile.baseUrl) {
          throw new Error('Remote sign-in requires a canonical remote profile.');
        }
        await invoke(ipc, IPC_CHANNELS.authenticationPair, {
          id: profile.id,
          label: profile.name,
          apiBaseUrl,
        });
      },
      cancel: profileId => invoke(ipc, IPC_CHANNELS.authenticationCancel, profileId),
    },
    externalBrowser: { open: (url) => invoke(ipc, IPC_CHANNELS.openExternal, url) },
    localSetup: platformName === 'linux' ? {
      status: () => invoke(ipc, IPC_CHANNELS.setupStatus),
      start: (request) => invoke(ipc, IPC_CHANNELS.setupStart, request),
      retry: (request) => invoke(ipc, IPC_CHANNELS.setupRetry, request),
      cancel: () => invoke(ipc, IPC_CHANNELS.setupCancel),
      selectPrivateKey: () => invoke(ipc, IPC_CHANNELS.setupSelectPrivateKey),
      acquireWebhookSecret: () => invoke(ipc, IPC_CHANNELS.setupAcquireWebhookSecret),
      onProgress: (listener) => {
        progressListeners.add(listener);
        return () => progressListeners.delete(listener);
      },
    } : {
      status: async () => remoteOnlySnapshot(),
      start: localSetupUnavailable,
      retry: localSetupUnavailable,
      cancel: localSetupUnavailable,
      selectPrivateKey: localSetupUnavailable,
      acquireWebhookSecret: localSetupUnavailable,
      onProgress: () => () => undefined,
    },
    connection: {
      probe: async profile => {
        if (connectionProbe) return connectionProbe(profile);
        const input = { id: profile.id, label: profile.name, apiBaseUrl: profile.baseUrl };
        if (profile.kind !== 'local') return invoke(ipc, IPC_CHANNELS.connectionProbe, input);
        const prepared = await invoke<{ localActivationTicket: string }>(
          ipc,
          IPC_CHANNELS.connectionPrepareLocal,
          input,
        );
        const result = await probeDesktopProfile(profile);
        return result.status === 'ready'
          ? { ...result, localActivationTicket: prepared.localActivationTicket }
          : result;
      },
      activateLocal: localActivationTicket => invoke(
        ipc,
        IPC_CHANNELS.connectionActivateLocal,
        localActivationTicket,
      ),
      discardLocal: localActivationTicket => invoke(
        ipc,
        IPC_CHANNELS.connectionDiscardLocal,
        localActivationTicket,
      ),
      activate: activationTicket => invoke(ipc, IPC_CHANNELS.connectionActivate, activationTicket),
      discard: value => invoke(ipc, IPC_CHANNELS.connectionDiscard, value),
      invalidate: value => invoke(ipc, IPC_CHANNELS.connectionInvalidate, value),
    },
  };
  Object.values(bridge).filter(value => typeof value === 'object').forEach(Object.freeze);
  return Object.freeze(bridge);
};
