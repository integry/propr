import type {
  DesktopBridge,
  DesktopDeepLinkAcknowledgement,
  DesktopDeepLinkConsumption,
  DesktopDeepLinkDelivery,
  DesktopNotificationScope,
  DesktopPairingProgress,
} from './shared/contract';
import {
  IPC_CHANNELS,
  isDesktopNativeCommandDelivery,
  isDesktopNotificationScope,
  isDesktopPairingOperationId,
} from './shared/contract';

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
  const deepLinkListeners = new Set<(url: string) => (
    DesktopDeepLinkConsumption | null | Promise<DesktopDeepLinkConsumption | null>
  )>();
  const pendingDeepLinks: DesktopDeepLinkDelivery[] = [];
  let resolveStartupConnectIntent!: (pending: boolean) => void;
  let rejectStartupConnectIntent!: (error: unknown) => void;
  const startupConnectIntent = new Promise<boolean>((resolve, reject) => {
    resolveStartupConnectIntent = resolve;
    rejectStartupConnectIntent = reject;
  });
  // A renderer without the startup consumer must not create an unhandled rejection.
  void startupConnectIntent.catch(() => undefined);
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
  const consume = async (delivery: DesktopDeepLinkDelivery): Promise<void> => {
    const acknowledgements = (await Promise.all(
      [...deepLinkListeners].map(listener => listener(delivery.url)),
    )).filter(isConsumption);
    if (acknowledgements.length !== 1) return;
    const acknowledgement: DesktopDeepLinkAcknowledgement = {
      ...delivery,
      consumption: acknowledgements[0],
    };
    await invoke(ipc, IPC_CHANNELS.deepLinkAcknowledgement, acknowledgement).catch(() => undefined);
  };
  const setupProgressListeners = new Set<(value: Awaited<ReturnType<DesktopBridge['localSetup']['status']>>) => void>();
  const notificationSettingsListeners = new Set<(value: DesktopNotificationScope) => void>();
  const notificationNavigationListeners = new Set<(path: string) => void>();
  const pairingProgressListeners = new Set<(value: DesktopPairingProgress) => void>();
  const nativeCommandListeners = new Set<(
    value: import('./shared/contract').DesktopNativeCommandDelivery,
  ) => void>();
  const pendingNativeCommands: import('./shared/contract').DesktopNativeCommandDelivery[] = [];
  ipc.on(IPC_CHANNELS.deepLink, (_event, value) => {
    if (!isDelivery(value)) return;
    if (deepLinkListeners.size === 0) {
      pendingDeepLinks.push(value);
      return;
    }
    void consume(value).catch(() => undefined);
  });
  ipc.on(IPC_CHANNELS.setupProgress, (_event, value) => {
    setupProgressListeners.forEach(listener => listener(
      value as Awaited<ReturnType<DesktopBridge['localSetup']['status']>>,
    ));
  });
  ipc.on(IPC_CHANNELS.notificationNavigate, (_event, value) => {
    if (typeof value !== 'string' || !(/^\/tasks(?:\/[A-Za-z0-9_.~!$&'()*+,;=:@%-]+)?$/.test(value))) return;
    notificationNavigationListeners.forEach(listener => listener(value));
  });
  ipc.on(IPC_CHANNELS.notificationsChanged, (_event, value) => {
    if (!isDesktopNotificationScope(value)) return;
    const safeScope: DesktopNotificationScope = {
      profileId: value.profileId,
      transportScope: value.transportScope,
      userId: value.userId,
    };
    notificationSettingsListeners.forEach(listener => listener(safeScope));
  });
  ipc.on(IPC_CHANNELS.authenticationProgress, (_event, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const progress = value as Record<string, unknown>;
    if (Object.keys(progress).length !== 3
      || !isDesktopPairingOperationId(progress.operationId)
      || typeof progress.profileId !== 'string'
      || progress.profileId.length === 0
      || progress.profileId.length > 128
      || !['browser-opening', 'approval-pending', 'browser-open-failed'].includes(
        progress.stage as string,
      )) return;
    const safeProgress: DesktopPairingProgress = {
      operationId: progress.operationId,
      profileId: progress.profileId,
      stage: progress.stage as DesktopPairingProgress['stage'],
    };
    pairingProgressListeners.forEach(listener => listener(safeProgress));
  });
  ipc.on(IPC_CHANNELS.nativeCommand, (_event, value) => {
    if (!isDesktopNativeCommandDelivery(value)) return;
    const delivery = {
      command: value.command,
      connectionScope: value.connectionScope ? { ...value.connectionScope } : null,
    };
    if (nativeCommandListeners.size === 0) {
      pendingNativeCommands.splice(0, pendingNativeCommands.length, delivery);
      return;
    }
    nativeCommandListeners.forEach(listener => listener(delivery));
  });

  const bridge: DesktopBridge = {
    ...((process.platform === 'linux' || process.platform === 'darwin') ? {
      voice: {
        requestMicrophone: () => {
          // Evaluated in the isolated preload world, before crossing IPC.
          if (typeof navigator === 'undefined' || !navigator.userActivation?.isActive) {
            return Promise.resolve(false);
          }
          return invoke<boolean>(ipc, IPC_CHANNELS.microphoneRequest);
        },
        revokeMicrophone: () => invoke<void>(ipc, IPC_CHANNELS.microphoneRevoke),
      },
    } : {}),
    app: {
      getMetadata: () => invoke(ipc, IPC_CHANNELS.appMetadata),
      refreshActiveWork: () => invoke(ipc, IPC_CHANNELS.activeWorkRefresh),
      quit: () => invoke(ipc, IPC_CHANNELS.appQuit),
      minimize: () => invoke(ipc, IPC_CHANNELS.windowMinimize),
      toggleMaximize: () => invoke(ipc, IPC_CHANNELS.windowToggleMaximize),
      closeWindow: () => invoke(ipc, IPC_CHANNELS.windowClose),
      hasStartupConnectIntent: () => startupConnectIntent,
      onDeepLink: (listener) => {
        const consumerWasAbsent = deepLinkListeners.size === 0;
        deepLinkListeners.add(listener);
        if (consumerWasAbsent) {
          void invoke<{ pendingConnect: boolean }>(ipc, IPC_CHANNELS.deepLinkConsumerReady)
            .then(state => {
              if (!state || typeof state.pendingConnect !== 'boolean') {
                throw new Error('Invalid desktop deep-link startup intent');
              }
              resolveStartupConnectIntent(state.pendingConnect);
            })
            .catch(rejectStartupConnectIntent);
        }
        pendingDeepLinks.splice(0).forEach(delivery => { void consume(delivery).catch(() => undefined); });
        return () => deepLinkListeners.delete(listener);
      },
      setNativeNavigationState: state => invoke(ipc, IPC_CHANNELS.nativeNavigationState, state),
      onNativeCommand: listener => {
        nativeCommandListeners.add(listener);
        pendingNativeCommands.splice(0).forEach(command => listener(command));
        return () => nativeCommandListeners.delete(listener);
      },
    },
    auth: {
      logout: (scope) => invoke(ipc, IPC_CHANNELS.authLogout, scope),
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
      admit: async (profileId) => {
        const admission = await invoke<unknown>(ipc, IPC_CHANNELS.authenticationPairAdmit, profileId);
        if (!admission || typeof admission !== 'object' || Array.isArray(admission)) {
          throw new Error('Desktop pairing admission failed');
        }
        const value = admission as Record<string, unknown>;
        if (Object.keys(value).length !== 1 || !isDesktopPairingOperationId(value.operationId)) {
          throw new Error('Desktop pairing admission failed');
        }
        return { operationId: value.operationId };
      },
      pair: (profile, operationId) => invoke(ipc, IPC_CHANNELS.authenticationPair, profile, operationId),
      cancel: (profileId) => invoke(ipc, IPC_CHANNELS.authenticationCancel, profileId),
      reopenApproval: (profileId, operationId) =>
        invoke(ipc, IPC_CHANNELS.authenticationReopenApproval, profileId, operationId),
      copyApproval: (profileId, operationId) =>
        invoke(ipc, IPC_CHANNELS.authenticationCopyApproval, profileId, operationId),
      onProgress: listener => {
        pairingProgressListeners.add(listener);
        return () => pairingProgressListeners.delete(listener);
      },
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
    localSetup: {
      status: () => invoke(ipc, IPC_CHANNELS.setupStatus),
      start: request => invoke(ipc, IPC_CHANNELS.setupStart, request),
      retry: request => request === undefined
        ? invoke(ipc, IPC_CHANNELS.setupRetry)
        : invoke(ipc, IPC_CHANNELS.setupRetry, request),
      cancel: () => invoke(ipc, IPC_CHANNELS.setupCancel),
      selectPrivateKey: () => invoke(ipc, IPC_CHANNELS.setupSelectPrivateKey),
      acquireWebhookSecret: () => invoke(ipc, IPC_CHANNELS.setupAcquireWebhookSecret),
      resolveGithubInstallation: decision => invoke(ipc, IPC_CHANNELS.setupGithubInstallationDecision, decision),
      onProgress: listener => {
        setupProgressListeners.add(listener);
        return () => setupProgressListeners.delete(listener);
      },
    },
    notifications: {
      get: scope => invoke(ipc, IPC_CHANNELS.notificationsGet, scope),
      update: (scope, preferences) => invoke(ipc, IPC_CHANNELS.notificationsUpdate, scope, preferences),
      test: scope => invoke(ipc, IPC_CHANNELS.notificationsTest, scope),
      publish: (scope, transition) => invoke(ipc, IPC_CHANNELS.notificationsPublish, scope, transition),
      clear: scope => invoke(ipc, IPC_CHANNELS.notificationsClear, scope),
      onSettingsChanged: listener => {
        notificationSettingsListeners.add(listener);
        return () => notificationSettingsListeners.delete(listener);
      },
      onNavigate: listener => {
        notificationNavigationListeners.add(listener);
        return () => notificationNavigationListeners.delete(listener);
      },
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
