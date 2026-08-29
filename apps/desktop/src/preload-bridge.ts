import type { DesktopBridge } from './shared/contract';
import { IPC_CHANNELS } from './shared/contract';

export interface PreloadIpc {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, value: string) => void): void;
  removeListener(channel: string, listener: (event: unknown, value: string) => void): void;
}

const invoke = <T>(ipc: PreloadIpc, channel: string, ...args: unknown[]): Promise<T> =>
  ipc.invoke(channel, ...args) as Promise<T>;

export const createDesktopBridge = (ipc: PreloadIpc): DesktopBridge => {
  const bridge: DesktopBridge = {
    app: {
      getMetadata: () => invoke(ipc, IPC_CHANNELS.appMetadata),
      onDeepLink: (listener) => {
        const wrapped = (_event: unknown, value: string) => listener(value);
        ipc.on(IPC_CHANNELS.deepLink, wrapped);
        return () => ipc.removeListener(IPC_CHANNELS.deepLink, wrapped);
      },
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
    credentials: {
      read: (profileId) => invoke(ipc, IPC_CHANNELS.credentialsRead, profileId),
      write: (profileId, value) => invoke(ipc, IPC_CHANNELS.credentialsWrite, profileId, value),
      remove: (profileId) => invoke(ipc, IPC_CHANNELS.credentialsRemove, profileId),
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
