import type { DesktopBridge } from './shared/contract';
import { IPC_CHANNELS } from './shared/contract';

export interface PreloadIpc {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, value: string) => void): void;
  removeListener(channel: string, listener: (event: unknown, value: string) => void): void;
}

const invoke = <T>(ipc: PreloadIpc, channel: string, ...args: unknown[]): Promise<T> =>
  ipc.invoke(channel, ...args) as Promise<T>;

export const createDesktopBridge = (
  ipc: PreloadIpc,
  connectDiscoverySupported = process.platform === 'darwin'
    || process.platform === 'linux'
    || process.platform === 'win32',
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
    discovery: {
      supported: connectDiscoverySupported,
      discover: () => invoke(ipc, IPC_CHANNELS.connectDiscover),
      rediscover: (profileId) => invoke(ipc, IPC_CHANNELS.connectRediscover, profileId),
    },
    lifecycle: {
      status: () => invoke(ipc, IPC_CHANNELS.lifecycleStatus),
      start: () => invoke(ipc, IPC_CHANNELS.lifecycleStart),
      stop: () => invoke(ipc, IPC_CHANNELS.lifecycleStop),
      restart: () => invoke(ipc, IPC_CHANNELS.lifecycleRestart),
    },
  };

  Object.values(bridge).forEach(Object.freeze);
  return Object.freeze(bridge);
};
