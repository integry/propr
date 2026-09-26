import { randomUUID } from 'node:crypto';
import type { App, IpcMain, IpcMainInvokeEvent, Session } from 'electron';
import { clearDesktopInstanceCookies } from './desktop-session';
import { desktopPairingFailureCode, type DesktopCredentialService } from './credential-service';
import type { DesktopConnectDiscoveryService } from './connect-discovery';
import type { DesktopLogger } from './logger';
import type { LocalLifecycleController } from './lifecycle';
import type { ProfileStore } from './profile-store';
import type { DesktopSetupController } from './setup-controller';
import {
  isDesktopNotificationScope,
  isDesktopTaskTransition,
  type NativeNotificationService,
} from './native-notifications';
import {
  connectApiBaseUrlFromDeepLink,
  dashboardPathFromDeepLink,
  isSafeExternalUrl,
  isTrustedRendererUrl,
} from './security';
import { IPC_CHANNELS, isDesktopPairingOperationId, isDesktopNativeNavigationState } from './shared/contract';
import type { DesktopAcceptanceJourneyStage, DesktopDeepLinkAcknowledgement, DesktopNativeNavigationState } from './shared/contract';

export type DesktopAcceptanceOperation = 'PROFILE_SAVE' | 'PAIR' | 'PROBE' | 'ACTIVATE';
export type DesktopAcceptanceOperationStatus =
  | 'COMPLETED'
  | 'READY'
  | 'AUTHENTICATION_REQUIRED'
  | 'INCOMPATIBLE'
  | 'OFFLINE'
  | 'REJECTED';

interface RegisterIpcOptions {
  app: App;
  ipcMain: IpcMain;
  profiles: ProfileStore;
  credentials: DesktopCredentialService;
  connectDiscovery: Pick<DesktopConnectDiscoveryService, 'discover' | 'rediscover'>;
  lifecycle: LocalLifecycleController;
  setup?: DesktopSetupController;
  notifications?: Pick<NativeNotificationService, 'get' | 'update' | 'test' | 'publish' | 'clear' | 'activeScope'>;
  logger: DesktopLogger;
  desktopSession: Session;
  devServerUrl: string | undefined;
  packagedRendererUrl: string;
  openExternal(url: string): Promise<void>;
  platform?: NodeJS.Platform;
  windowForSender?(event: IpcMainInvokeEvent): DesktopWindowControlTarget | null;
  rendererConsumerReady?(event: IpcMainInvokeEvent): boolean;
  hasPendingConnectIntent?(): boolean;
  acknowledgeDeepLink?(event: IpcMainInvokeEvent, acknowledgement: DesktopDeepLinkAcknowledgement): boolean;
  onRendererActiveProfileChanged?(origin: string | null): void;
  onActiveWorkConnectionAvailable?(): void;
  onActiveWorkConnectionUnavailable?(reason: 'disconnected' | 'logged-out' | 'revoked' | 'profile-changed'): void;
  onActiveWorkRefresh?(): void;
  onNativeNavigationState?(state: DesktopNativeNavigationState): void;
  /** @internal Deterministic admitted-work accounting for lifecycle proof. */
  observeInvocation?(phase: 'entry' | 'exit', channel: string): void;
  /** @internal Fixed, secret-free packaged Connect acceptance evidence. */
  reportAcceptanceJourneyStage?(stage: DesktopAcceptanceJourneyStage): void;
  /** @internal Fixed, secret-free packaged Connect operation evidence. */
  reportAcceptanceOperation?(
    operation: DesktopAcceptanceOperation,
    status: DesktopAcceptanceOperationStatus,
  ): void;
}

interface DesktopWindowControlTarget {
  close(): void;
  isDestroyed(): boolean;
  isMaximized(): boolean;
  maximize(): void;
  minimize(): void;
  unmaximize(): void;
}

type Handler = (event: IpcMainInvokeEvent, ...args: any[]) => unknown;

export interface RegisteredIpcHandlers {
  close(): void;
  awaitIdle(): Promise<void>;
  dispose(): void;
}

const closingError = (): Error => new Error('DESKTOP_CLOSING');
const acceptanceStages = new Set<DesktopAcceptanceJourneyStage>([
  'AUTHENTICATION_REQUIRED',
  'CREDENTIAL_COMMITTED',
  'AUTHENTICATED_REPROBE_READY',
  'ACTIVATION_COMMITTED',
  'ACTIVATION_PUBLISHED',
  'REACT_CONNECTED',
]);
const acceptanceOperations = new Map<string, DesktopAcceptanceOperation>([
  [IPC_CHANNELS.profilesSave, 'PROFILE_SAVE'],
  [IPC_CHANNELS.authenticationPair, 'PAIR'],
  [IPC_CHANNELS.connectionProbe, 'PROBE'],
  [IPC_CHANNELS.connectionActivate, 'ACTIVATE'],
]);

const acceptanceStatus = (result: unknown): DesktopAcceptanceOperationStatus => {
  if (result && typeof result === 'object' && !Array.isArray(result)
    && 'paired' in result && (result as { paired?: unknown }).paired === false) return 'REJECTED';
  if (!result || typeof result !== 'object' || Array.isArray(result) || !('status' in result)) {
    return 'COMPLETED';
  }
  const status = (result as { status?: unknown }).status;
  if (status === 'ready') return 'READY';
  if (status === 'authentication-required') return 'AUTHENTICATION_REQUIRED';
  if (status === 'incompatible') return 'INCOMPATIBLE';
  if (status === 'offline') return 'OFFLINE';
  return 'COMPLETED';
};

export const isValidDesktopDeepLinkAcknowledgement = (
  value: unknown,
): value is DesktopDeepLinkAcknowledgement => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const acknowledgement = value as Record<string, unknown>;
  if (Object.keys(acknowledgement).some(key => !['deliveryId', 'url', 'consumption'].includes(key))
    || !Number.isSafeInteger(acknowledgement.deliveryId)
    || (acknowledgement.deliveryId as number) <= 0
    || typeof acknowledgement.url !== 'string'
    || !acknowledgement.consumption || typeof acknowledgement.consumption !== 'object'
    || Array.isArray(acknowledgement.consumption)) return false;
  const consumption = acknowledgement.consumption as Record<string, unknown>;
  if (Object.keys(consumption).some(key => !['kind', 'target'].includes(key))
    || !['connect-confirmation', 'open-queued', 'open-navigated'].includes(consumption.kind as string)
    || typeof consumption.target !== 'string' || consumption.target.length === 0
    || consumption.target.length > 2_048) return false;
  const expectedConnectTarget = connectApiBaseUrlFromDeepLink(acknowledgement.url);
  const expectedOpenTarget = dashboardPathFromDeepLink(acknowledgement.url);
  return expectedConnectTarget !== null
    ? consumption.kind === 'connect-confirmation' && consumption.target === expectedConnectTarget
    : expectedOpenTarget !== null
      && (consumption.kind === 'open-queued' || consumption.kind === 'open-navigated')
      && consumption.target === expectedOpenTarget;
};

export const registerIpcHandlers = (options: RegisterIpcOptions): RegisteredIpcHandlers => {
  const channels = new Set<string>();
  const active = new Set<Promise<unknown>>();
  let pairingAdmission: { profileId: string; operationId: string } | null = null;
  let closing = false;
  let rendererActiveProfileReconciliationGeneration = 0;
  const trusted = (event: IpcMainInvokeEvent): boolean => {
    const senderUrl = event.senderFrame?.url ?? '';
    return isTrustedRendererUrl(senderUrl, options.devServerUrl, options.packagedRendererUrl);
  };
  const handle = (channel: string, handler: Handler, completesAdmittedWork = false): void => {
    channels.add(channel);
    options.ipcMain.handle(channel, async (event, ...args) => {
      if (closing && !completesAdmittedWork) throw closingError();
      if (!trusted(event)) {
        options.logger.log('warn', 'desktop.ipc.rejected', { channel });
        throw new Error('Untrusted desktop IPC sender');
      }
      options.observeInvocation?.('entry', channel);
      const invocation = Promise.resolve().then(() => handler(event, ...args));
      active.add(invocation);
      try {
        const result = await invocation;
        const operation = acceptanceOperations.get(channel);
        if (operation) options.reportAcceptanceOperation?.(operation, acceptanceStatus(result));
        return result;
      } catch (error) {
        const operation = acceptanceOperations.get(channel);
        if (operation) options.reportAcceptanceOperation?.(operation, 'REJECTED');
        options.logger.log('error', 'desktop.ipc.failed', { channel, code: 'IPC_OPERATION_FAILED' });
        throw new Error('Desktop operation failed [IPC_OPERATION_FAILED]');
      } finally {
        active.delete(invocation);
        options.observeInvocation?.('exit', channel);
      }
    });
  };
  const reconcileRendererActiveProfile = async (): Promise<void> => {
    if (!options.onRendererActiveProfileChanged) return;
    const generation = ++rendererActiveProfileReconciliationGeneration;
    let current;
    try {
      current = await options.credentials.listProfiles();
    } catch (error) {
      if (generation === rendererActiveProfileReconciliationGeneration) {
        options.onRendererActiveProfileChanged(null);
      }
      throw error;
    }
    const activeOrigin = current.profiles
      .find(profile => profile.id === current.activeProfileId)?.apiBaseUrl ?? null;
    if (generation === rendererActiveProfileReconciliationGeneration) {
      options.onRendererActiveProfileChanged(activeOrigin);
    }
  };
  const reconcileActiveWorkConnection = (): void => {
    if (!options.onActiveWorkRefresh && !options.onActiveWorkConnectionUnavailable) return;
    if (options.credentials.hasActiveRendererBinding()) options.onActiveWorkRefresh?.();
    else options.onActiveWorkConnectionUnavailable?.('profile-changed');
  };

  handle(IPC_CHANNELS.nativeNavigationState, (_event, state, ...args) => {
    if (args.length || !isDesktopNativeNavigationState(state)) throw new Error('Invalid native navigation state');
    if (state.connectionScope === null || options.credentials.isActiveConnectionScope(state.connectionScope)) {
      options.onNativeNavigationState?.(state);
    }
  });
  handle(IPC_CHANNELS.appMetadata, () => ({
    name: options.app.getName(),
    version: options.app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    packaged: options.app.isPackaged,
  }));
  handle(IPC_CHANNELS.activeWorkRefresh, (_event, ...args) => {
    if (args.length) throw new Error('Invalid active work refresh request');
    options.onActiveWorkRefresh?.();
  });
  handle(IPC_CHANNELS.appQuit, (_event, ...args) => {
    if (args.length) throw new Error('Invalid app quit request');
    options.app.quit();
  });
  const windowControlTarget = (event: IpcMainInvokeEvent, args: unknown[]): DesktopWindowControlTarget => {
    if (args.length) throw new Error('Invalid native window control request');
    const target = options.windowForSender?.(event);
    if (!target || target.isDestroyed()) throw new Error('Native window control target is unavailable');
    return target;
  };
  if (options.windowForSender) {
    handle(IPC_CHANNELS.windowMinimize, (event, ...args) => {
      windowControlTarget(event, args).minimize();
    });
    handle(IPC_CHANNELS.windowToggleMaximize, (event, ...args) => {
      const target = windowControlTarget(event, args);
      if (target.isMaximized()) target.unmaximize();
      else target.maximize();
    });
    handle(IPC_CHANNELS.windowClose, (event, ...args) => {
      windowControlTarget(event, args).close();
    });
  }
  handle(IPC_CHANNELS.deepLinkAcknowledgement, (event, acknowledgement, ...args) => {
    if (args.length || !isValidDesktopDeepLinkAcknowledgement(acknowledgement)) {
      throw new Error('Invalid desktop deep-link acknowledgement');
    }
    if (!options.acknowledgeDeepLink?.(event, acknowledgement)) {
      throw new Error('Unexpected desktop deep-link acknowledgement');
    }
  }, true);
  handle(IPC_CHANNELS.deepLinkConsumerReady, (event, ...args) => {
    if (args.length || !options.rendererConsumerReady?.(event)) {
      throw new Error('Unexpected desktop deep-link consumer readiness');
    }
    return { pendingConnect: options.hasPendingConnectIntent?.() ?? false };
  });
  handle(IPC_CHANNELS.authLogout, async (_event, scope, ...args) => {
    if (args.length || !scope || typeof scope !== 'object' || Array.isArray(scope)
      || Object.keys(scope).length !== 2
      || typeof scope.profileId !== 'string' || typeof scope.transportScope !== 'string') {
      throw new Error('Invalid desktop logout scope');
    }
    const notificationScope = options.notifications?.activeScope();
    await options.credentials.logout(scope);
    if (notificationScope && notificationScope.profileId === scope.profileId
      && notificationScope.transportScope === scope.transportScope) {
      options.notifications?.clear(notificationScope);
    }
    if (options.onActiveWorkConnectionUnavailable && !options.credentials.hasActiveRendererBinding()) {
      options.onActiveWorkConnectionUnavailable('logged-out');
    }
  });
  handle(IPC_CHANNELS.openExternal, async (_event, value: unknown) => {
    if (typeof value !== 'string' || !isSafeExternalUrl(value)) throw new Error('External URL is not allowed');
    await options.openExternal(value);
  });
  handle(IPC_CHANNELS.storageSecurity, () => options.credentials.storageSecurity());
  if (options.notifications) {
    handle(IPC_CHANNELS.notificationsGet, (_event, scope, ...args) => {
      if (args.length || !isDesktopNotificationScope(scope)) throw new Error('Invalid notification scope');
      return options.notifications!.get(scope);
    });
    handle(IPC_CHANNELS.notificationsUpdate, (_event, scope, preferences, ...args) => {
      if (args.length || !isDesktopNotificationScope(scope)) throw new Error('Invalid notification settings request');
      return options.notifications!.update(scope, preferences);
    });
    handle(IPC_CHANNELS.notificationsTest, (_event, scope, ...args) => {
      if (args.length || !isDesktopNotificationScope(scope)) throw new Error('Invalid notification test request');
      return options.notifications!.test(scope);
    });
    handle(IPC_CHANNELS.notificationsPublish, (_event, scope, transition, ...args) => {
      if (args.length || !isDesktopNotificationScope(scope) || !isDesktopTaskTransition(transition)) {
        throw new Error('Invalid task notification event');
      }
      return options.notifications!.publish(scope, transition);
    });
    handle(IPC_CHANNELS.notificationsClear, (_event, scope, ...args) => {
      if (args.length || !isDesktopNotificationScope(scope)) throw new Error('Invalid notification clear request');
      options.notifications!.clear(scope);
    });
  }
  handle(IPC_CHANNELS.profilesList, () => options.credentials.listProfiles());
  handle(IPC_CHANNELS.profilesSave, async (_event, input) => {
    const profile = await options.credentials.saveProfile(
      input,
      (previousOrigin, nextOrigin) => clearDesktopInstanceCookies(
        options.desktopSession,
        [previousOrigin, nextOrigin],
      ),
    );
    await reconcileRendererActiveProfile();
    reconcileActiveWorkConnection();
    return profile;
  });
  handle(IPC_CHANNELS.profilesRemove, async (_event, profileId) => {
    await options.credentials.removeProfile(
      profileId,
      origin => clearDesktopInstanceCookies(options.desktopSession, [origin]),
    );
    await reconcileRendererActiveProfile();
    reconcileActiveWorkConnection();
  });
  handle(IPC_CHANNELS.profilesSetActive, async (_event, profileId) => {
    const current = await options.credentials.listProfiles();
    const previous = current.profiles.find(profile => profile.id === current.activeProfileId);
    const next = current.profiles.find(profile => profile.id === profileId);
    if (profileId !== null && !next) throw new Error('Desktop profile does not exist');
    // Account switching clears the durable selection before asynchronous cookie cleanup.
    // A reload or cleanup failure must not silently select the previous account.
    if (profileId === null) {
      await options.credentials.setActiveProfile(null);
      options.onActiveWorkConnectionUnavailable?.('profile-changed');
    }
    await clearDesktopInstanceCookies(options.desktopSession, [
      ...(previous ? [previous.apiBaseUrl] : []),
      ...(next ? [next.apiBaseUrl] : []),
    ]);
    if (profileId !== null) await options.credentials.setActiveProfile(profileId);
    await reconcileRendererActiveProfile();
    options.onActiveWorkConnectionUnavailable?.('profile-changed');
  });
  handle(IPC_CHANNELS.authenticationPairAdmit, (_event, profileId, ...args) => {
    if (args.length || typeof profileId !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(profileId)) {
      throw new Error('Invalid desktop pairing admission');
    }
    const operationId = randomUUID();
    pairingAdmission = { profileId, operationId };
    return { operationId };
  });
  handle(IPC_CHANNELS.authenticationPair, async (_event, profile, operationId, ...args) => {
    const admittedOperation = pairingAdmission;
    if (args.length || !profile || typeof profile !== 'object' || Array.isArray(profile)
      || typeof profile.id !== 'string' || !isDesktopPairingOperationId(operationId)
      || admittedOperation?.profileId !== profile.id || admittedOperation?.operationId !== operationId) {
      throw new Error('Invalid desktop pairing operation');
    }
    pairingAdmission = null;
    try {
      const paired = await options.credentials.pair(profile, operationId);
      await reconcileRendererActiveProfile();
      reconcileActiveWorkConnection();
      return paired;
    } catch (error) {
      // A shutdown-owned cancellation must retain the admitted-work fence: do not
      // turn it into a renderer result while the renderer and IPC are closing.
      if (closing) throw error;
      const code = desktopPairingFailureCode(error);
      if (code === null) throw error;
      options.logger.log(code === 'PAIRING_CANCELLED' ? 'info' : 'warn', 'desktop.authentication_pair.failed', {
        code,
      });
      return { paired: false as const, code };
    }
  });
  handle(IPC_CHANNELS.authenticationCancel, (_event, profileId) => {
    if (pairingAdmission?.profileId === profileId) pairingAdmission = null;
    return options.credentials.cancelPairing(profileId);
  });
  const pairingApprovalAction = async (
    action: 'reopen' | 'copy',
    profileId: unknown,
    operationId: unknown,
    args: unknown[],
  ) => {
    if (args.length || typeof profileId !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(profileId)
      || !isDesktopPairingOperationId(operationId)) {
      throw new Error('Invalid desktop pairing approval action');
    }
    if (!['darwin', 'linux'].includes(options.platform ?? process.platform)) {
      return { status: 'unavailable' as const };
    }
    const result = action === 'reopen'
      ? await options.credentials.reopenPairingApproval(profileId, operationId)
      : await options.credentials.copyPendingPairingApproval(profileId, operationId);
    options.logger.log(result.status === 'failed' ? 'warn' : 'info', 'desktop.authentication_pair.approval_action', {
      action,
      status: result.status,
    });
    return result;
  };
  handle(IPC_CHANNELS.authenticationReopenApproval, (_event, profileId, operationId, ...args) =>
    pairingApprovalAction('reopen', profileId, operationId, args));
  handle(IPC_CHANNELS.authenticationCopyApproval, (_event, profileId, operationId, ...args) =>
    pairingApprovalAction('copy', profileId, operationId, args));
  handle(IPC_CHANNELS.connectionProbe, (_event, profile) => options.credentials.probe(profile));
  handle(IPC_CHANNELS.connectionActivate, async (_event, activationTicket) => {
    const before = await options.credentials.listProfiles();
    const activated = await options.credentials.activate(activationTicket);
    try {
      const after = await options.credentials.listProfiles();
      const previousOrigin = before.profiles
        .find(profile => profile.id === before.activeProfileId)?.apiBaseUrl;
      const activatedOrigin = after.profiles
        .find(profile => profile.id === after.activeProfileId)?.apiBaseUrl;
      const origins = [previousOrigin, activatedOrigin].filter(origin => origin !== undefined);
      await clearDesktopInstanceCookies(options.desktopSession, origins);
      if (!activatedOrigin) throw new Error('Desktop activation did not establish a renderer origin');
      await reconcileRendererActiveProfile();
      options.onActiveWorkConnectionAvailable?.();
      return activated;
    } catch (error) {
      try {
        await options.credentials.discardActivation({
          profileId: activated.profileId,
          transportScope: activated.transportScope,
        });
      } finally {
        await reconcileRendererActiveProfile();
      }
      throw error;
    }
  });
  handle(IPC_CHANNELS.connectionDiscard, async (_event, value) => {
    const discarded = await options.credentials.discardActivation(value);
    if (discarded.discarded) {
      await reconcileRendererActiveProfile();
      options.onActiveWorkConnectionUnavailable?.('disconnected');
    }
    return discarded;
  });
  handle(IPC_CHANNELS.connectionInvalidate, async (_event, value) => {
    const invalidated = await options.credentials.invalidate(value);
    if (invalidated.invalidated) options.onActiveWorkConnectionUnavailable?.('revoked');
    return invalidated;
  });
  handle(IPC_CHANNELS.connectDiscover, (_event, ...args) => {
    if (args.length) throw new Error('Invalid Connect discovery request');
    return options.connectDiscovery.discover();
  });
  handle(IPC_CHANNELS.connectRediscover, (_event, profileId, ...args) => {
    if (args.length) throw new Error('Invalid Connect rediscovery request');
    return options.connectDiscovery.rediscover(profileId);
  });
  if (options.reportAcceptanceJourneyStage) {
    handle(IPC_CHANNELS.acceptanceJourneyStage, (_event, stage, ...args) => {
      if (args.length || !acceptanceStages.has(stage)) throw new Error('Invalid acceptance journey stage');
      options.reportAcceptanceJourneyStage!(stage);
    });
  }
  handle(IPC_CHANNELS.lifecycleStatus, () => options.lifecycle.status());
  handle(IPC_CHANNELS.lifecycleStart, () => options.lifecycle.start());
  handle(IPC_CHANNELS.lifecycleStop, () => options.lifecycle.stop());
  handle(IPC_CHANNELS.lifecycleRestart, () => options.lifecycle.restart());
  const setup = options.setup;
  if (setup) handle(IPC_CHANNELS.setupStatus, (_event, ...args) => {
    if (args.length) throw new Error('Invalid setup status request');
    return setup.status();
  });
  if (setup) handle(IPC_CHANNELS.setupStart, (_event, request, ...args) => {
    if (args.length) throw new Error('Invalid setup start request');
    return setup.start(request);
  });
  if (setup) handle(IPC_CHANNELS.setupRetry, (_event, request, ...args) => {
    if (args.length) throw new Error('Invalid setup retry request');
    return setup.retry(request);
  });
  if (setup) handle(IPC_CHANNELS.setupCancel, (_event, ...args) => {
    if (args.length) throw new Error('Invalid setup cancellation request');
    return setup.cancel();
  });
  if (setup) handle(IPC_CHANNELS.setupSelectPrivateKey, (_event, ...args) => {
    if (args.length) throw new Error('Invalid setup file request');
    return setup.selectPrivateKey();
  });
  if (setup) handle(IPC_CHANNELS.setupAcquireWebhookSecret, (_event, ...args) => {
    if (args.length) throw new Error('Invalid setup secret request');
    return setup.acquireWebhookSecret();
  });
  if (setup) handle(IPC_CHANNELS.setupGithubInstallationDecision, (_event, decision, ...args) => {
    if (args.length) throw new Error('Invalid GitHub installation decision');
    return setup.resolveGithubInstallation(decision);
  });
  return {
    close() {
      if (closing) return;
      closing = true;
      pairingAdmission = null;
      for (const channel of channels) {
        // This channel completes deep links accepted before admission closed.
        // Final disposal removes it after the bounded shutdown drain.
        if (channel === IPC_CHANNELS.deepLinkAcknowledgement) continue;
        options.ipcMain.removeHandler(channel);
        options.ipcMain.handle(channel, () => Promise.reject(closingError()));
      }
    },
    async awaitIdle() {
      while (active.size > 0) await Promise.allSettled([...active]);
    },
    dispose() {
      closing = true;
      pairingAdmission = null;
      for (const channel of channels) options.ipcMain.removeHandler(channel);
    },
  };
};
