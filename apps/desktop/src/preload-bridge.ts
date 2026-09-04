import type {
  DesktopBridge,
  DesktopDeepLinkAcknowledgement,
  DesktopDeepLinkConsumption,
  DesktopDeepLinkDelivery,
} from './shared/contract';
import { IPC_CHANNELS } from './shared/contract';

export interface PreloadIpc {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, value: unknown) => void): void;
  removeListener(channel: string, listener: (event: unknown, value: unknown) => void): void;
}

const invoke = <T>(ipc: PreloadIpc, channel: string, ...args: unknown[]): Promise<T> =>
  ipc.invoke(channel, ...args) as Promise<T>;

export const createDesktopBridge = (
  ipc: PreloadIpc,
  connectDiscoverySupported = process.platform === 'darwin'
    || process.platform === 'linux'
    || process.platform === 'win32',
  connectJourneyAcceptance = false,
): DesktopBridge => {
  const deepLinkListeners = new Set<(url: string) => DesktopDeepLinkConsumption | null>();
  const pendingDeepLinks: DesktopDeepLinkDelivery[] = [];
  const isDelivery = (value: unknown): value is DesktopDeepLinkDelivery => Boolean(
    value && typeof value === 'object'
      && Number.isSafeInteger((value as DesktopDeepLinkDelivery).deliveryId)
      && (value as DesktopDeepLinkDelivery).deliveryId > 0
      && typeof (value as DesktopDeepLinkDelivery).url === 'string',
  );
  const isConsumption = (value: unknown): value is DesktopDeepLinkConsumption => Boolean(
    value && typeof value === 'object'
      && ['connect-confirmation', 'open-queued', 'open-navigated'].includes(
        (value as DesktopDeepLinkConsumption).kind,
      )
      && typeof (value as DesktopDeepLinkConsumption).target === 'string'
      && (value as DesktopDeepLinkConsumption).target.length > 0
      && (value as DesktopDeepLinkConsumption).target.length <= 2_048,
  );
  const consume = (delivery: DesktopDeepLinkDelivery): void => {
    const acknowledgements = [...deepLinkListeners]
      .map(listener => listener(delivery.url))
      .filter(isConsumption);
    if (acknowledgements.length !== 1) return;
    const acknowledgement: DesktopDeepLinkAcknowledgement = {
      ...delivery,
      consumption: acknowledgements[0],
    };
    void invoke(ipc, IPC_CHANNELS.deepLinkAcknowledgement, acknowledgement).catch(() => undefined);
  };
  ipc.on(IPC_CHANNELS.deepLink, (_event, value) => {
    if (!isDelivery(value)) return;
    if (deepLinkListeners.size === 0) {
      pendingDeepLinks.push(value);
      return;
    }
    consume(value);
  });

  const bridge: DesktopBridge = {
    app: {
      getMetadata: () => invoke(ipc, IPC_CHANNELS.appMetadata),
      onDeepLink: (listener) => {
        deepLinkListeners.add(listener);
        pendingDeepLinks.splice(0).forEach(consume);
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
    ...(connectJourneyAcceptance ? {
      acceptance: {
        reportJourneyStage: (stage) => invoke(ipc, IPC_CHANNELS.acceptanceJourneyStage, stage),
      },
    } : {}),
  };

  Object.values(bridge).forEach(Object.freeze);
  return Object.freeze(bridge);
};
